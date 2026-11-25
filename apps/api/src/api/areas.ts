import { mentionToken, type Area } from "@hippidy/contracts";
import { globMatches } from "./glob.ts";
import type { Logger } from "../log.ts";
import { listAreas, nameAreasForChange, type Place } from "../store/areas.ts";
import type { Db } from "../store/db.ts";
import { enqueueDelivery, getConversation } from "../store/conversations.ts";
import { flushSoon, targetOf, type ConversationDeps } from "./conversations.ts";

// Routing by area (slice 3.1, decisions 205 and 206): which areas a text or a set of changed
// files touches, and the line that names their owners in the thread. No model runs for it.

/** Who decides for anything with no owner (rule 10 of `wave-3.md`). */
export interface Fallback {
  actorId: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `phrase` stands in `text` as a whole word or phrase, any case. */
function hasPhrase(text: string, phrase: string): boolean {
  const words = phrase.trim().toLowerCase().split(/\s+/).map(escapeRegExp).join("\\s+");
  if (words === "") return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${words}($|[^\\p{L}\\p{N}_])`, "iu").test(text);
}

/**
 * Path-like words in a text (`apps/api/src/store/x.ts`), to match against areas' paths. Split
 * on spaces first, so a long text is read in one pass.
 */
export function pathsIn(text: string): string[] {
  return text
    .split(/[\s,;:()[\]{}<>"'`]+/)
    .map((word) => word.replace(/^\.\//, "").replace(/[.]+$/, ""))
    .filter((word) => /^[\w.*-]+(?:\/[\w.*-]+)+$/.test(word));
}

/** A name or word shorter than this is not looked for in text: it would match nearly anything. */
export const MIN_MATCH_CHARACTERS = 3;

/** Whether a repository path falls under one of an area's globs. */
function pathMatches(area: Area, file: string): boolean {
  return area.paths.some((pattern) => globMatches(file, pattern));
}

/** The areas a text names: by name, a word of theirs, or a path under theirs. */
export function areasInText(areas: readonly Area[], text: string): Area[] {
  const paths = pathsIn(text);
  return areas.filter(
    (area) =>
      (area.name.length >= MIN_MATCH_CHARACTERS && hasPhrase(text, area.name)) ||
      area.words.some((word) => word.length >= MIN_MATCH_CHARACTERS && hasPhrase(text, word)) ||
      paths.some((path) => pathMatches(area, path)),
  );
}

/** The areas a set of changed files falls in. */
export function areasInFiles(areas: readonly Area[], files: readonly string[]): Area[] {
  return areas.filter((area) => files.some((file) => pathMatches(area, file)));
}

/** "This touches search, owned by @Ada." for each area, with the people it mentions. */
export function ownerLines(
  areas: readonly Area[],
  fallback: Fallback | undefined,
): { text: string; mentions: string[] } {
  const mentions = new Set<string>();
  const lines = areas.map((area) => {
    if (area.owner !== null) {
      mentions.add(area.owner.actorId);
      return `This touches **${area.name}**, owned by ${mentionToken(area.owner.actorId)}.`;
    }
    if (fallback !== undefined) {
      mentions.add(fallback.actorId);
      return `This touches **${area.name}**, which has no owner, so ${mentionToken(fallback.actorId)} decides for it.`;
    }
    return `This touches **${area.name}**, which has no owner yet.`;
  });
  return { text: lines.join("\n"), mentions: [...mentions] };
}

/** The most people one delivery mentions (the contract's limit). */
export const MAX_MENTIONS = 10;

/** Areas split into groups whose owners (or the fallback) are at most ten people each. */
export function groupsByOwners(areas: readonly Area[], fallback: Fallback | undefined): Area[][] {
  const groups: Area[][] = [];
  let group: Area[] = [];
  let people = new Set<string>();
  for (const area of areas) {
    const who = area.owner?.actorId ?? fallback?.actorId;
    if (who !== undefined && !people.has(who) && people.size === MAX_MENTIONS) {
      groups.push(group);
      group = [];
      people = new Set();
    }
    group.push(area);
    if (who !== undefined) people.add(who);
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

/**
 * Names, once per change, the areas it touches that were not named for it before: a reply in
 * its thread that mentions their owners. Answers how many were named.
 */
export async function nameChangeAreas(
  deps: Pick<ConversationDeps, "db" | "deliverers">,
  input: {
    conversationId: string;
    changeId: string;
    areas: readonly Area[];
    via: "brief" | "pull_request";
    key: string;
    fallback: Fallback | undefined;
  },
  log?: Logger,
): Promise<number> {
  // Named and queued together, so a line is never lost between the two (from the review).
  const named = await deps.db.transaction(async (tx) => {
    const fresh = await nameAreasForChange(
      tx,
      input.changeId,
      input.areas.map((area) => area.id),
      input.via,
    );
    const areas = input.areas.filter((area) => fresh.includes(area.id));
    if (areas.length === 0) return areas;
    const conversation = await getConversation(tx, input.conversationId);
    // A delivery mentions at most ten people: more owners are named in more replies.
    for (const [index, group] of groupsByOwners(areas, input.fallback).entries()) {
      const { text, mentions } = ownerLines(group, input.fallback);
      await enqueueDelivery(tx, conversation.id, `${input.key}:${String(index)}`, "note", {
        kind: "reply",
        target: targetOf(conversation),
        text,
        mentions,
      });
    }
    return areas;
  });
  if (named.length === 0) return 0;
  log?.info("areas.named", { changeId: input.changeId, via: input.via, areas: named.length });
  return named.length;
}

/**
 * After a change's sync (outside its lease): reads the files of its latest pull request, once
 * per pull request, and names the areas they fall in that were not named yet. Never throws.
 */
export async function namePullRequestAreas(
  deps: ConversationDeps,
  changeId: string,
  log: Logger,
): Promise<void> {
  try {
    const rows = await deps.db.query(
      `select c.conversation_id, c.pull_request_url, v.source, v.workspace_id
       from changes c join conversations v on v.id = c.conversation_id
       where c.id = $1 and c.pull_request_url is not null
         and c.pull_request_url is distinct from c.areas_checked_url`,
      [changeId],
    );
    const row = rows[0];
    if (row === undefined || deps.checks?.changedFiles === undefined) return;
    const url = String(row.pull_request_url);
    const place = { source: row.source, workspaceId: String(row.workspace_id) } as Place;
    const areas = await listAreas(deps.db, place);
    // With no areas yet, the pull request is read once there are some.
    if (areas.length === 0) return;
    const files = await deps.checks.changedFiles(url);
    // Marked first: a failure below is logged, and the next pull request is read afresh.
    await deps.db.query(`update changes set areas_checked_url = $2 where id = $1`, [changeId, url]);
    if (files === undefined || files.length === 0) return;
    await nameChangeAreas(
      deps,
      {
        conversationId: String(row.conversation_id),
        changeId,
        areas: areasInFiles(areas, files),
        via: "pull_request",
        key: `areas:${changeId}:${url}`,
        fallback: deps.fallback,
      },
      log,
    );
    await flushSoon(deps, String(row.conversation_id), log);
  } catch (error) {
    log.warn("areas.pull_request_failed", { changeId, error });
  }
}

/** An area as the teammate is shown it before a message: its name and owner's name. */
export interface AreaLine {
  name: string;
  owner: string | null;
}

/** The areas a teammate's message names, with their owners (slice 3.1). */
export async function areasBearingOn(db: Db, place: Place, text: string): Promise<AreaLine[]> {
  return areasInText(await listAreas(db, place), text).map((area) => ({
    name: area.name,
    owner: area.owner === null ? null : (area.owner.name ?? area.owner.actorId),
  }));
}
