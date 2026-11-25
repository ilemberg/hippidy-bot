import {
  mentionToken,
  type Decision,
  type RaiseConflictInput,
  type RaiseConflictOutput,
  type SettleConflictRequest,
  type SettleConflictResult,
} from "@hippidy/contracts";
import { z } from "zod";
import type { Logger } from "../log.ts";
import { findAreaByName } from "../store/areas.ts";
import { actorNameInConversation } from "../store/changes.ts";
import {
  decidersFor,
  decidersForDecisions,
  openConflictsIn,
  recordConflict,
  settleConflict,
  type Decider,
  type Position,
} from "../store/conflicts.ts";
import { enqueueDelivery, getConversation } from "../store/conversations.ts";
import type { Db } from "../store/db.ts";
import { findDecisionByNumber, type DecisionActor } from "../store/decisions.ts";
import { hasWrittenInConversation, type ToolCallContext } from "../store/projects.ts";
import type { CustomToolAnswer, CustomToolCall, Routing } from "./agent-tools.ts";
import { flushSoon, queue, targetOf, type ConversationDeps } from "./conversations.ts";

// Conflicts (slice 3.2, decision 208): a proposal that replaces someone else's decision, or a
// disagreement the teammate raises, is posted with who decides it; the record keeps the active
// decision until they do (rule 11 of `wave-3.md`). No model runs to find them.

/** The most open conflicts one thread may have: attention has a budget (rule 13). */
export const MAX_OPEN_CONFLICTS_PER_THREAD = 3;

export const conflictErrors = {
  tooMany: `this thread already has ${String(MAX_OPEN_CONFLICTS_PER_THREAD)} open conflicts; tell the people here they are waiting on their deciders, rather than raising another`,
  notActive: (n: number) =>
    `decision ${String(n)} is not active, so there is nothing to conflict with`,
  notInThread: (actorId: string) =>
    `${actorId} has not written in this thread and made none of the decisions named, so their position cannot be recorded`,
  noArea: (area: string) =>
    `there is no area named "${area}"; leave out area to use the decision's`,
  otherArea: (area: string, theirs: string | null) =>
    `the decisions named are in ${theirs === null ? "no area" : `the area "${theirs}"`}, not "${area}"; leave out area`,
} as const;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** "Who decides: @Ada (owner of search), @Grace (who made decision 12)." with its mentions. */
export function whoDecides(
  deciders: readonly Decider[],
  context: { area: string | null; replaced?: number | undefined },
): { text: string; mentions: string[] } {
  if (deciders.length === 0) {
    return {
      text: "Nobody is set to decide it: its area has no owner and no fallback owner is configured.",
      mentions: [],
    };
  }
  const named = deciders.map((d) => {
    const who = mentionToken(d.actorId);
    if (d.role === "owner") return `${who} (owner of **${context.area ?? "its area"}**)`;
    if (d.role === "fallback") {
      return context.area === null
        ? `${who} (it is in no area)`
        : `${who} (**${context.area}** has no owner)`;
    }
    return `${who} (who made decision ${String(context.replaced ?? "")})`;
  });
  return { text: `Who decides: ${named.join(", ")}.`, mentions: deciders.map((d) => d.actorId) };
}

/** The lines under a proposal that replaces someone else's decision. */
export function replacementLines(
  replaced: Decision,
  deciders: readonly Decider[],
): { text: string; mentions: string[] } {
  const who = replaced.decidedBy.name ?? replaced.decidedBy.actorId ?? "someone else";
  const decide = whoDecides(deciders, { area: replaced.area, replaced: replaced.number });
  return {
    text:
      `This would replace decision ${String(replaced.number)}, which ${who} decided. ` +
      `Until it is decided, decision ${String(replaced.number)} stands.\n${decide.text}`,
    mentions: decide.mentions,
  };
}

/** Who decides a replacement of `replaced`: its area's owner as of then, else the fallback, and its maker. */
export function replacementDeciders(
  db: Db,
  context: ToolCallContext,
  replaced: Decision,
  routing: Routing,
): Promise<Decider[]> {
  return decidersFor(
    db,
    context,
    {
      area: replaced.area,
      ownedBy: replaced.decidedAt,
      replacedDecider: replaced.origin === "import" ? null : replaced.decidedBy.actorId,
    },
    routing.fallback,
  );
}

/**
 * The roles of stored deciders, for posting again: `decidersFor` puts the owner (or fallback)
 * first and the replaced decision's maker after.
 */
export function rolesFromStored(
  ids: readonly string[],
  replaced: Decision,
  fallback: { actorId: string } | undefined,
): Decider[] {
  return ids.map((actorId, index) => ({
    actorId,
    role:
      index > 0 || actorId === replaced.decidedBy.actorId
        ? "decider"
        : actorId === fallback?.actorId
          ? "fallback"
          : "owner",
  }));
}

function error(text: string): CustomToolAnswer {
  return { text, isError: true };
}

/**
 * Records and posts a conflict the teammate raises: people in the thread want opposite things,
 * or a request contradicts an active decision. Once per call.
 */
export async function raiseConflict(
  db: Db,
  conversationId: string,
  context: ToolCallContext,
  call: CustomToolCall,
  input: RaiseConflictInput,
  routing: Routing,
): Promise<CustomToolAnswer> {
  // Answered again: from what the first answer recorded, whatever has changed since.
  const own = await db.query(
    `select number::int as number, deciders from conflicts where custom_tool_use_id = $1`,
    [call.id],
  );
  if (own[0] !== undefined) {
    const mine = z.object({ number: z.number(), deciders: z.array(z.string()) }).parse(own[0]);
    const output: RaiseConflictOutput = { number: mine.number, deciders: mine.deciders };
    return { text: JSON.stringify(output), isError: false };
  }
  const decisions: Decision[] = [];
  for (const number of [...new Set(input.decisions ?? [])]) {
    const decision = await findDecisionByNumber(db, number);
    if (decision?.status !== "active") return error(conflictErrors.notActive(number));
    decisions.push(decision);
  }
  const positions: Position[] = [];
  for (const position of input.positions ?? []) {
    const actor = { ...context, actorId: position.actorId };
    const decided = decisions.some((d) => d.decidedBy.actorId === position.actorId);
    if (!decided && !(await hasWrittenInConversation(db, conversationId, actor))) {
      return error(conflictErrors.notInThread(position.actorId));
    }
    positions.push({
      actorId: position.actorId,
      name: await actorNameInConversation(db, conversationId, position.actorId),
      says: position.says,
    });
  }
  // With decisions named, their areas decide who decides, not the model (from the review).
  let area = decisions.find((d) => d.area !== null)?.area ?? null;
  if (input.area !== undefined) {
    const found = await findAreaByName(db, context, input.area);
    if (found === undefined) return error(conflictErrors.noArea(input.area));
    if (decisions.length > 0 && found.name !== area) {
      return error(conflictErrors.otherArea(found.name, area));
    }
    area = found.name;
  }
  if ((await openConflictsIn(db, conversationId)) >= MAX_OPEN_CONFLICTS_PER_THREAD) {
    return error(conflictErrors.tooMany);
  }
  const deciders =
    decisions.length > 0
      ? await decidersForDecisions(db, context, decisions, routing.fallback)
      : await decidersFor(db, context, { area }, routing.fallback);
  const conversation = await getConversation(db, conversationId);
  const recorded = await db.transaction(async (tx) => {
    const conflict = await recordConflict(tx, {
      place: context,
      kind: "raised",
      summary: input.summary,
      conversationId,
      channelId: null,
      threadId: null,
      area,
      decisionIds: decisions.map((d) => d.id),
      proposalId: null,
      positions,
      deciders: deciders.map((d) => d.actorId),
      customToolUseId: call.id,
    });
    // Queued with it, under its id, so answering the call again posts it once.
    const decide = whoDecides(deciders, { area });
    const lines = [
      `**Conflict ${String(conflict.number)}:** ${input.summary}`,
      ...positions.map((p) => `- ${p.name ?? p.actorId}: ${clip(p.says, 300)}`),
      ...decisions.map(
        (d) => `It bears on decision ${String(d.number)}: "${clip(d.statement, 300)}"`,
      ),
      decide.text +
        (decisions.length === 0
          ? ""
          : ` Until then, ${decisions.map((d) => `decision ${String(d.number)}`).join(" and ")} ${decisions.length === 1 ? "stands" : "stand"}.`),
    ];
    await enqueueDelivery(tx, conversationId, `conflict:${conflict.id}`, "note", {
      kind: "reply",
      target: targetOf(conversation),
      text: lines.join("\n"),
      ...(decide.mentions.length === 0 ? {} : { mentions: decide.mentions }),
    });
    return conflict;
  });
  routing.log?.info("conflict.raised", {
    conversationId,
    number: recorded.number,
    created: recorded.created,
  });
  const output: RaiseConflictOutput = {
    number: recorded.number,
    deciders: deciders.map((d) => d.actorId),
  };
  return { text: JSON.stringify(output), isError: false };
}

export const conflictTexts = {
  settled: (number: number, name: string, outcome: string, note: string | null) =>
    `Conflict ${String(number)} settled by ${name}: ${
      outcome === "kept"
        ? "things stay as they are"
        : outcome === "changed"
          ? "the change goes ahead"
          : "it is dismissed"
    }.${note === null ? "" : ` "${clip(note, 500)}"`}`,
} as const;

/**
 * A decider settles a conflict in the web app. One raised in a thread the bot is in is noted
 * there; one from listening is not (176).
 */
export async function settleConflictByPerson(
  deps: ConversationDeps,
  conflictId: string,
  person: DecisionActor,
  request: SettleConflictRequest,
  log: Logger,
): Promise<SettleConflictResult> {
  const result = await settleConflict(deps.db, person, conflictId, request, deps.fallback);
  log.info("conflict.settle", { conflictId, status: result.status });
  if (result.status !== "settled") {
    return result.status === "not_allowed"
      ? { status: "not_allowed", reason: result.reason, conflict: result.conflict }
      : { status: "not_found" };
  }
  const { conflict } = result;
  if (conflict.conversationId !== null && conflict.kind !== "capture") {
    try {
      const conversation = await getConversation(deps.db, conflict.conversationId);
      const text = conflictTexts.settled(
        conflict.number,
        person.name ?? `${person.source} user ${person.actorId}`,
        request.outcome,
        conflict.note,
      );
      await queue(deps, conversation, `settled:${conflict.id}`, "note", {
        kind: "reply",
        target: targetOf(conversation),
        text,
      });
      await flushSoon(deps, conversation.id, log);
    } catch (failure) {
      log.error("conflict.note_failed", { conflictId, error: failure });
    }
  }
  return { status: "settled", conflict };
}
