import { randomUUID } from "node:crypto";
import {
  editDecisionRequestSchema,
  type Decision,
  type DecisionActionResult,
  type DecisionDetail,
  type DecisionEvent,
  type DecisionStatus,
  type EditDecisionRequest,
  type NotAllowedReason,
} from "@hippidy/contracts";
import {
  confirmDecision,
  editDecision,
  fetchDecision,
  fetchDecisions,
  rejectDecision,
  type ApiClientDeps,
  type ApiResult,
} from "./api-client.ts";
import { fromThisApp } from "./auth-flow.ts";
import type { WebConfig } from "./config.ts";
import { readCookie, SESSION_COOKIE } from "./cookies.ts";
import { signedInPerson, type HomeDeps } from "./home.ts";
import { ago, channelLink, messageLink } from "./sessions-view.ts";
import type { Person } from "./tokens.ts";

// The wiki (slice 2.6, decisions 201 and 202): the decisions on record, one decision's page,
// and the forms that confirm, reject or edit a proposal. Over the standard Request and Response,
// so it is tested without Next.js; the pages and route files only pass the real dependencies in.

/** The most the API gives in one list. */
export const DECISIONS_LIMIT = 500;

/** Which decisions the list shows. `open` is the default: the active ones and the proposals. */
export const statusFilters = [
  "open",
  "proposed",
  "active",
  "rejected",
  "superseded",
  "all",
] as const;
export type StatusFilter = (typeof statusFilters)[number];

export const statusFilterLabel: Record<StatusFilter, string> = {
  open: "Active and proposed",
  proposed: "Proposed",
  active: "Active",
  rejected: "Rejected",
  superseded: "Superseded",
  all: "All",
};

export const statusLabel: Record<DecisionStatus, string> = {
  proposed: "Proposed",
  active: "Active",
  superseded: "Superseded",
  rejected: "Rejected",
};

/** Decisions under one area; `area` null is "No area". */
export interface AreaGroup {
  area: string | null;
  label: string;
  decisions: Decision[];
}

/** What the decisions page shows. */
export type DecisionsView =
  | { kind: "unconfigured" }
  | { kind: "signed_out" }
  | {
      kind: "signed_in";
      person: Person;
      /** The words searched for, if any. */
      q: string | undefined;
      filter: StatusFilter;
      groups: ApiResult<AreaGroup[]>;
      /** Whether the API gave as many as it gives at once, so some may not be shown. */
      truncated: boolean;
      readAt: string;
    };

const isFilter = (value: string | undefined): value is StatusFilter =>
  statusFilters.some((filter) => filter === value);

/** The words to search for: trimmed, at most 200 characters, none when empty. */
export function searchWords(q: string | undefined): string | undefined {
  const words = q?.trim().slice(0, 200).trim();
  return words === undefined || words === "" ? undefined : words;
}

/** Decisions by area, areas in alphabetical order and "No area" last, newest first in each. */
export function groupByArea(decisions: Decision[]): AreaGroup[] {
  // "Search" and "search" are one area, shown as first written.
  const byArea = new Map<string | null, { area: string | null; list: Decision[] }>();
  for (const decision of decisions) {
    const key = decision.area === null ? null : decision.area.toLowerCase();
    const group = byArea.get(key);
    if (group === undefined) byArea.set(key, { area: decision.area, list: [decision] });
    else group.list.push(decision);
  }
  return [...byArea.values()]
    .map(({ area, list }) => ({
      area,
      label: area ?? "No area",
      decisions: list.sort((a, b) => b.number - a.number),
    }))
    .sort((a, b) =>
      a.area === null
        ? 1
        : b.area === null
          ? -1
          : a.area.localeCompare(b.area, "en", { sensitivity: "base" }),
    );
}

function clientDeps(person: Person, config: WebConfig, deps: HomeDeps, now: Date): ApiClientDeps {
  const correlationId = randomUUID();
  return {
    fetch: deps.fetch,
    apiBaseUrl: config.apiBaseUrl,
    apiSecret: config.apiSecret,
    log: deps.log.child({ correlationId, actorId: person.actorId }),
    correlationId,
    now: () => now,
  };
}

/** Reads the session cookie and, for a signed-in person, the decisions the filter asks for. */
export async function loadDecisions(
  input: { sessionCookie: string | undefined; q: string | undefined; status: string | undefined },
  deps: HomeDeps,
): Promise<DecisionsView> {
  const config = deps.config;
  if (config === undefined) return { kind: "unconfigured" };
  const now = deps.now?.() ?? new Date();
  const person = await signedInPerson(input.sessionCookie, config, now);
  if (person === undefined) return { kind: "signed_out" };
  const client = clientDeps(person, config, deps, now);
  const q = searchWords(input.q);
  const filter = isFilter(input.status) ? input.status : "open";
  const statuses: (DecisionStatus | "all")[] =
    filter === "open" ? ["active", "proposed"] : [filter];
  const results = await Promise.all(
    statuses.map((status) =>
      fetchDecisions(
        person,
        {
          ...(q === undefined ? {} : { q }),
          status,
          limit: DECISIONS_LIMIT,
        },
        client,
      ),
    ),
  );
  const base = { kind: "signed_in", person, q, filter, readAt: now.toISOString() } as const;
  const decisions: Decision[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const result of results) {
    if (result.kind === "failed") return { ...base, groups: result, truncated: false };
    truncated ||= result.value.length >= DECISIONS_LIMIT;
    for (const decision of result.value) {
      if (seen.has(decision.id)) continue;
      seen.add(decision.id);
      decisions.push(decision);
    }
  }
  return { ...base, groups: { kind: "ok", value: groupByArea(decisions) }, truncated };
}

/** What an action did, as the decision's page is told in its address. */
export const actionDone = ["confirmed", "rejected", "edited"] as const;
export type ActionDone = (typeof actionDone)[number];

/** Why an action did nothing, as the decision's page is told in its address. */
export const actionErrors = [
  "not_proposed",
  "not_found",
  "not_allowed",
  "not_in_thread",
  "read_only",
  "not_decider",
  "invalid",
  "unchanged",
  "changed",
  "signed_out",
  "unavailable",
  "failed",
] as const;
export type ActionError = (typeof actionErrors)[number];

export type ActionNotice =
  { kind: "done"; done: ActionDone } | { kind: "error"; error: ActionError };

/** The notice for `?done=` or `?error=`, if it is one this app sends. */
export function actionNotice(
  done: string | undefined,
  error: string | undefined,
): ActionNotice | undefined {
  const isDone = actionDone.find((value) => value === done);
  if (isDone !== undefined) return { kind: "done", done: isDone };
  const isError = actionErrors.find((value) => value === error);
  return isError === undefined ? undefined : { kind: "error", error: isError };
}

/** What the page of one decision shows. */
export type DecisionView =
  | { kind: "unconfigured" }
  | { kind: "signed_out"; notice: ActionNotice | undefined }
  | { kind: "not_found"; person: Person }
  | { kind: "failed"; person: Person; reason: string }
  | {
      kind: "ok";
      person: Person;
      detail: DecisionDetail;
      notice: ActionNotice | undefined;
      readAt: string;
    };

/** A decision's number from its address: a positive whole number, or nothing. */
export function decisionNumber(text: string): number | undefined {
  return /^[1-9]\d{0,8}$/.test(text) ? Number(text) : undefined;
}

/** Reads the session cookie and, for a signed-in person, one decision with its history. */
export async function loadDecision(
  input: {
    sessionCookie: string | undefined;
    number: string;
    done: string | undefined;
    error: string | undefined;
  },
  deps: HomeDeps,
): Promise<DecisionView> {
  const config = deps.config;
  if (config === undefined) return { kind: "unconfigured" };
  const now = deps.now?.() ?? new Date();
  const person = await signedInPerson(input.sessionCookie, config, now);
  if (person === undefined) {
    return { kind: "signed_out", notice: actionNotice(input.done, input.error) };
  }
  const number = decisionNumber(input.number);
  if (number === undefined) return { kind: "not_found", person };
  const lookup = await fetchDecision(person, number, clientDeps(person, config, deps, now));
  switch (lookup.kind) {
    case "not_found":
      return { kind: "not_found", person };
    case "failed":
      return { kind: "failed", person, reason: lookup.reason };
    case "ok": {
      const detail = lookup.value;
      const notice = actionNotice(input.done, input.error);
      // A refusal the page already gives under the proposal is not said twice.
      const saidBelow =
        notice?.kind === "error" &&
        detail.decision.status === "proposed" &&
        !detail.youMay.act &&
        notice.error === detail.youMay.reason;
      return {
        kind: "ok",
        person,
        detail,
        notice: saidBelow ? undefined : notice,
        readAt: now.toISOString(),
      };
    }
  }
}

/** The forms a decision's page posts to. */
export const decisionActions = ["confirm", "reject", "edit"] as const;
export type DecisionAction = (typeof decisionActions)[number];

/** What the edit form asks for, from its fields. */
export type FormEdit =
  { kind: "edit"; edit: EditDecisionRequest } | { kind: "unchanged" } | { kind: "invalid" };

const field = (form: FormData, name: string): string | undefined => {
  const value = form.get(name);
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : undefined;
};

/** The wording the form was shown, which every action sends (decision 203). */
export function wordingVersionOf(form: FormData): number | undefined {
  const value = Number(field(form, "wordingVersion"));
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}

/**
 * The edit body from the form's fields: an empty statement leaves it as it is; an empty reason
 * or area clears it. A field the same as the decision's now is left out. It names the wording
 * the form showed, so an edit made meanwhile by someone else is not overwritten.
 */
export function editFromForm(form: FormData, current: Decision): FormEdit {
  const statement = field(form, "statement");
  const reason = field(form, "reason");
  const area = field(form, "area");
  const wordingVersion = wordingVersionOf(form);
  if (wordingVersion === undefined) return { kind: "invalid" };
  const edit: EditDecisionRequest = { wordingVersion };
  if (statement !== undefined && statement !== "" && statement !== current.statement) {
    edit.statement = statement;
  }
  const newReason = reason === "" ? null : reason;
  if (newReason !== undefined && newReason !== current.reason) edit.reason = newReason;
  const newArea = area === "" ? null : area;
  if (newArea !== undefined && newArea !== current.area) edit.area = newArea;
  if (edit.statement === undefined && edit.reason === undefined && edit.area === undefined) {
    return { kind: "unchanged" };
  }
  const parsed = editDecisionRequestSchema.safeParse(edit);
  return parsed.success ? { kind: "edit", edit: parsed.data } : { kind: "invalid" };
}

function outcomeOf(result: ApiResult<DecisionActionResult>): ActionNotice {
  if (result.kind === "failed") return { kind: "error", error: "failed" };
  const status = result.value.status;
  switch (status) {
    case "confirmed":
    case "rejected":
    case "edited":
      return { kind: "done", done: status };
    case "not_allowed":
      return { kind: "error", error: result.value.reason ?? "not_allowed" };
    case "not_proposed":
    case "not_found":
    case "changed":
      return { kind: "error", error: status };
  }
}

/**
 * `POST /decisions/<number>/<action>`: a form on a decision's page confirms, rejects or edits
 * it. Only from this app's own pages, and only for a signed-in person, as whom the API is
 * called: who acts is never read from the form. Answers with the decision's page again.
 */
export async function handleDecisionAction(
  request: Request,
  numberText: string,
  actionText: string,
  deps: HomeDeps,
): Promise<Response> {
  const log = deps.log.child({ correlationId: randomUUID() });
  const action = decisionActions.find((value) => value === actionText);
  const number = decisionNumber(numberText);
  if (action === undefined || number === undefined) {
    return new Response("Not found.", { status: 404 });
  }
  if (!fromThisApp(request, deps.config)) {
    log.warn("decision.action_refused", { reason: "cross_origin", action, number });
    return new Response("Changes to decisions must come from this app.", { status: 403 });
  }
  const config = deps.config;
  const back = (notice: ActionNotice): Response => {
    const url = new URL(`/decisions/${number}`, config?.webBaseUrl ?? request.url);
    if (notice.kind === "done") url.searchParams.set("done", notice.done);
    else url.searchParams.set("error", notice.error);
    return new Response(null, {
      status: 303,
      headers: { location: url.toString(), "cache-control": "no-store" },
    });
  };
  if (config === undefined) return back({ kind: "error", error: "unavailable" });
  const now = deps.now?.() ?? new Date();
  const person = await signedInPerson(
    readCookie(request.headers.get("cookie"), SESSION_COOKIE),
    config,
    now,
  );
  if (person === undefined) {
    log.warn("decision.action_refused", { reason: "signed_out", action, number });
    return back({ kind: "error", error: "signed_out" });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back({ kind: "error", error: "invalid" });
  }
  const wordingVersion = wordingVersionOf(form);
  if (wordingVersion === undefined) return back({ kind: "error", error: "invalid" });

  const client = clientDeps(person, config, deps, now);
  const lookup = await fetchDecision(person, number, client);
  if (lookup.kind === "not_found") return back({ kind: "error", error: "not_found" });
  if (lookup.kind === "failed") return back({ kind: "error", error: "failed" });
  const decision = lookup.value.decision;

  let result: ApiResult<DecisionActionResult>;
  if (action === "confirm") {
    result = await confirmDecision(person, decision.id, wordingVersion, client);
  } else if (action === "reject") {
    result = await rejectDecision(person, decision.id, wordingVersion, client);
  } else {
    const edit = editFromForm(form, decision);
    if (edit.kind !== "edit") return back({ kind: "error", error: edit.kind });
    result = await editDecision(person, decision.id, edit.edit, client);
  }
  const notice = outcomeOf(result);
  client.log.info("decision.action", {
    number,
    action,
    outcome: notice.kind === "done" ? notice.done : notice.error,
  });
  return back(notice);
}

// How the pages word a decision, kept here so it is tested without Next.js.

/** A person's name, or their id, or "someone". */
export function nameOf(who: { actorId: string | null; name: string | null }): string {
  return who.name ?? who.actorId ?? "someone";
}

/** "5 min ago" for the last month, then the date. */
export function when(at: string, now: Date): string {
  const days = (now.getTime() - new Date(at).getTime()) / 86_400_000;
  return days < 30 ? ago(at, now) : `on ${at.slice(0, 10)}`;
}

/** Where a decision was made: a link to Slack, or the log entry it was imported from. */
export type Where = { kind: "link"; href: string; text: string } | { kind: "text"; text: string };

export function whereDecided(decision: Decision): Where | undefined {
  if (decision.origin === "import") {
    return {
      kind: "text",
      text:
        decision.originRef === null ? "decisions.md" : `decisions.md entry ${decision.originRef}`,
    };
  }
  if (decision.channelId === null) return undefined;
  // Decisions carry no source; every channel so far is Slack's.
  const id = decision.messageId ?? decision.threadId;
  if (id === null) {
    return { kind: "link", href: channelLink(decision.channelId), text: "the channel in Slack" };
  }
  const href = messageLink("slack", decision.channelId, decision.threadId, id);
  if (href === undefined) return undefined;
  return {
    kind: "link",
    href,
    text: decision.messageId === null ? "the thread in Slack" : "the message in Slack",
  };
}

/** Why a person may not act on a decision, in plain words. */
export function notAllowedText(reason: NotAllowedReason | null, decision: Decision): string {
  switch (reason) {
    case "not_in_thread":
      return decision.origin === "thread"
        ? "Only people who wrote in the thread it came from, or the owner of its area, can confirm or change it. Mentioning @hippidy in that thread counts."
        : "Only people who wrote in the thread it came from, or the owner of its area, can confirm or change it.";
    case "read_only":
      return "Imported from the decision log; change it there.";
    case "not_decider":
      return "It would replace someone else's decision, so only the people who decide it can confirm or change it: the owner of its area (or the project's owner), or whoever made the decision it replaces. You may still withdraw it.";
    case null:
      return "You cannot confirm or change it.";
  }
}

/** What the page says about changing a decision that is not a proposal, if anything. */
export function notProposedText(decision: Decision): string | undefined {
  if (decision.status !== "active") return undefined;
  return decision.origin === "import"
    ? "Imported from the decision log; change it there."
    : "An active decision is not changed in place. To change it, ask the bot in a thread to record a decision that replaces it.";
}

/** The sentence a notice from an action shows. */
export function noticeText(notice: ActionNotice, decision: Decision | undefined): string {
  if (notice.kind === "done") {
    switch (notice.done) {
      case "confirmed":
        return "Confirmed. It is active now.";
      case "rejected":
        return "Rejected. It stays on record as rejected.";
      case "edited":
        return "Saved. It is still a proposal until someone confirms it.";
    }
  }
  switch (notice.error) {
    case "not_proposed":
      return "It is no longer a proposal, so nothing was changed.";
    case "not_found":
      return "There is no such decision.";
    case "not_allowed":
      return "You cannot confirm or change it.";
    case "not_in_thread":
    case "read_only":
    case "not_decider":
      return decision === undefined
        ? "You cannot confirm or change it."
        : notAllowedText(notice.error, decision);
    case "invalid":
      return "Not saved: the statement can be at most 500 characters, the reason 2,000 and the area 100.";
    case "unchanged":
      return "Nothing was changed.";
    case "changed":
      return "Someone changed its wording after you opened it, so nothing was done. Read it again below, then try again.";
    case "signed_out":
      return "Your sign-in has ended. Sign in again, then try again.";
    case "unavailable":
      return "Sign-in is not set up yet.";
    case "failed":
      return "The API did not answer in time. Reload the page to see whether it was saved, then try again if not.";
  }
}

/** One line of a decision's history, oldest first. */
export interface HistoryItem {
  key: string;
  text: string;
  at: string;
  changes: { field: string; before: string; after: string }[];
}

const eventText: Record<DecisionEvent["kind"], string> = {
  edited: "Edited",
  confirmed: "Confirmed",
  rejected: "Rejected",
  superseded: "Replaced by a newer decision",
};

const wordingFields = [
  ["statement", "Statement"],
  ["reason", "Reason"],
  ["area", "Area"],
] as const;

/** The history to show: its recording first, then each change, with what an edit changed. */
export function historyItems(detail: DecisionDetail): HistoryItem[] {
  const decision = detail.decision;
  // An edit by someone else put it in their name; the first proposer is in that edit.
  const first = detail.history.find((event) => event.before?.decidedBy !== undefined)?.before
    ?.decidedBy;
  const recorded =
    decision.origin === "import"
      ? `Imported from the decision log, decided by ${nameOf(decision.decidedBy)}`
      : `Proposed by ${nameOf(first ?? decision.decidedBy)}`;
  return [
    { key: "recorded", text: recorded, at: decision.decidedAt, changes: [] },
    ...detail.history.map((event, index) => ({
      key: `${index}:${event.kind}`,
      text:
        event.before?.decidedBy === undefined
          ? `${eventText[event.kind]} by ${nameOf(event.actor)}`
          : `Reworded by ${nameOf(event.actor)}, so it is in their name now`,
      at: event.at,
      changes:
        event.kind === "edited" && event.before !== null && event.after !== null
          ? wordingFields
              .filter(([name]) => event.before?.[name] !== event.after?.[name])
              .map(([name, label]) => ({
                field: label,
                before: event.before?.[name] ?? "(none)",
                after: event.after?.[name] ?? "(none)",
              }))
          : [],
    })),
  ];
}
