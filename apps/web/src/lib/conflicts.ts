import { randomUUID } from "node:crypto";
import {
  settleConflictRequestSchema,
  type Conflict,
  type ConflictDetail,
  type ConflictOutcome,
  type ConflictRefusal,
  type SettleConflictRequest,
  type SettleConflictResult,
} from "@hippidy/contracts";
import {
  fetchConflict,
  fetchConflicts,
  settleConflict,
  type ApiClientDeps,
  type ApiResult,
} from "./api-client.ts";
import { fromThisApp } from "./auth-flow.ts";
import type { WebConfig } from "./config.ts";
import { readCookie, SESSION_COOKIE } from "./cookies.ts";
import { decisionNumber, nameOf, type Where } from "./decisions.ts";
import { signedInPerson, type HomeDeps } from "./home.ts";
import { channelLink, messageLink } from "./sessions-view.ts";
import type { Person } from "./tokens.ts";

// Conflicts and who decides them (slice 3.2, decision 208): the open ones, one conflict's page,
// and the form that settles one. Over the standard Request and Response, so it is tested without
// Next.js; the pages and route files only pass the real dependencies in.

/** The most the API gives in one list. */
export const CONFLICTS_LIMIT = 200;

/** Which conflicts the list shows; `open` is the default. */
export const conflictFilters = ["open", "settled", "all"] as const;
export type ConflictFilter = (typeof conflictFilters)[number];

export const conflictFilterLabel: Record<ConflictFilter, string> = {
  open: "Open",
  settled: "Settled",
  all: "All",
};

/** A conflict's page. */
export function conflictHref(number: number): string {
  return `/conflicts/${number}`;
}

/** A conflict's number from its address: a positive whole number, or nothing. */
export const conflictNumber = decisionNumber;

/** The list's address for a filter. */
export function conflictsHref(filter: ConflictFilter): string {
  return filter === "open" ? "/conflicts" : `/conflicts?status=${filter}`;
}

/** What settling did, as the page is told in its address. */
export const settleDone = ["settled"] as const;
export type SettleDone = (typeof settleDone)[number];

/** Why settling did nothing, as the page is told in its address. */
export const settleErrors = [
  "not_decider",
  "has_proposal",
  "already_settled",
  "not_found",
  "invalid",
  "signed_out",
  "unavailable",
  "failed",
] as const;
export type SettleError = (typeof settleErrors)[number];

export type SettleNotice =
  { kind: "done"; done: SettleDone } | { kind: "error"; error: SettleError };

/** The notice for `?done=` or `?error=`, if it is one this app sends. */
export function settleNotice(
  done: string | undefined,
  error: string | undefined,
): SettleNotice | undefined {
  const isDone = settleDone.find((value) => value === done);
  if (isDone !== undefined) return { kind: "done", done: isDone };
  const isError = settleErrors.find((value) => value === error);
  return isError === undefined ? undefined : { kind: "error", error: isError };
}

/** The error a refusal from the API is shown as. */
function refusalError(reason: ConflictRefusal): SettleError {
  return reason === "settled" ? "already_settled" : reason;
}

/** What the conflicts page shows. */
export type ConflictsView =
  | { kind: "unconfigured" }
  | { kind: "signed_out" }
  | {
      kind: "signed_in";
      person: Person;
      filter: ConflictFilter;
      list: ApiResult<Conflict[]>;
      /** Whether the API gave as many as it gives at once, so some may not be shown. */
      truncated: boolean;
      readAt: string;
    };

/** What the page of one conflict shows. */
export type ConflictView =
  | { kind: "unconfigured" }
  | { kind: "signed_out"; notice: SettleNotice | undefined }
  | { kind: "not_found"; person: Person }
  | { kind: "failed"; person: Person; reason: string }
  | {
      kind: "ok";
      person: Person;
      detail: ConflictDetail;
      notice: SettleNotice | undefined;
      readAt: string;
    };

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

const isFilter = (value: string | undefined): value is ConflictFilter =>
  conflictFilters.some((filter) => filter === value);

/** Reads the session cookie and, for a signed-in person, the conflicts the filter asks for. */
export async function loadConflicts(
  input: { sessionCookie: string | undefined; status: string | undefined },
  deps: HomeDeps,
): Promise<ConflictsView> {
  const config = deps.config;
  if (config === undefined) return { kind: "unconfigured" };
  const now = deps.now?.() ?? new Date();
  const person = await signedInPerson(input.sessionCookie, config, now);
  if (person === undefined) return { kind: "signed_out" };
  const filter = isFilter(input.status) ? input.status : "open";
  const list = await fetchConflicts(
    person,
    { status: filter, limit: CONFLICTS_LIMIT },
    clientDeps(person, config, deps, now),
  );
  return {
    kind: "signed_in",
    person,
    filter,
    list,
    truncated: list.kind === "ok" && list.value.length >= CONFLICTS_LIMIT,
    readAt: now.toISOString(),
  };
}

/** Reads the session cookie and, for a signed-in person, one conflict and what they may do. */
export async function loadConflict(
  input: {
    sessionCookie: string | undefined;
    number: string;
    done: string | undefined;
    error: string | undefined;
  },
  deps: HomeDeps,
): Promise<ConflictView> {
  const config = deps.config;
  if (config === undefined) return { kind: "unconfigured" };
  const now = deps.now?.() ?? new Date();
  const notice = settleNotice(input.done, input.error);
  const person = await signedInPerson(input.sessionCookie, config, now);
  if (person === undefined) return { kind: "signed_out", notice };
  const number = conflictNumber(input.number);
  if (number === undefined) return { kind: "not_found", person };
  const lookup = await fetchConflict(person, number, clientDeps(person, config, deps, now));
  switch (lookup.kind) {
    case "not_found":
      return { kind: "not_found", person };
    case "failed":
      return { kind: "failed", person, reason: lookup.reason };
    case "ok": {
      const reason = lookup.value.youMay.reason;
      // A refusal the page already gives in place of the form is not said twice.
      const saidBelow =
        notice?.kind === "error" &&
        (reason === "not_decider" || reason === "has_proposal") &&
        notice.error === reason;
      return {
        kind: "ok",
        person,
        detail: lookup.value,
        notice: saidBelow ? undefined : notice,
        readAt: now.toISOString(),
      };
    }
  }
}

const field = (form: FormData, name: string): string | undefined => {
  const value = form.get(name);
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : undefined;
};

/** What the settle form asks for, from its fields. */
export type FormSettle = { kind: "settle"; settle: SettleConflictRequest } | { kind: "invalid" };

/** The settle body from the form's fields: an outcome, and a note unless it is empty. */
export function settleFromForm(form: FormData): FormSettle {
  const note = field(form, "note");
  const parsed = settleConflictRequestSchema.safeParse({
    outcome: field(form, "outcome") ?? "",
    ...(note === undefined || note === "" ? {} : { note }),
  });
  return parsed.success ? { kind: "settle", settle: parsed.data } : { kind: "invalid" };
}

function outcomeOf(result: ApiResult<SettleConflictResult>): SettleNotice {
  if (result.kind === "failed") return { kind: "error", error: "failed" };
  switch (result.value.status) {
    case "settled":
      return { kind: "done", done: "settled" };
    case "not_found":
      return { kind: "error", error: "not_found" };
    case "not_allowed":
      return {
        kind: "error",
        error: result.value.reason === undefined ? "failed" : refusalError(result.value.reason),
      };
  }
}

/**
 * `POST /conflicts/<number>/settle`: the form on a conflict's page settles it. Only from this
 * app's own pages, and only for a signed-in person, as whom the API is called: who acts is never
 * read from the form. Answers with the conflict's page again.
 */
export async function handleSettleConflict(
  request: Request,
  numberText: string,
  deps: HomeDeps,
): Promise<Response> {
  const log = deps.log.child({ correlationId: randomUUID() });
  const number = conflictNumber(numberText);
  if (number === undefined) return new Response("Not found.", { status: 404 });
  if (!fromThisApp(request, deps.config)) {
    log.warn("conflict.settle_refused", { reason: "cross_origin", number });
    return new Response("Changes to conflicts must come from this app.", { status: 403 });
  }
  const config = deps.config;
  const back = (notice: SettleNotice): Response => {
    const url = new URL(conflictHref(number), config?.webBaseUrl ?? request.url);
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
    log.warn("conflict.settle_refused", { reason: "signed_out", number });
    return back({ kind: "error", error: "signed_out" });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back({ kind: "error", error: "invalid" });
  }
  const settle = settleFromForm(form);
  if (settle.kind === "invalid") return back({ kind: "error", error: "invalid" });

  const client = clientDeps(person, config, deps, now);
  const lookup = await fetchConflict(person, number, client);
  if (lookup.kind === "not_found") return back({ kind: "error", error: "not_found" });
  if (lookup.kind === "failed") return back({ kind: "error", error: "failed" });
  const result = await settleConflict(person, lookup.value.conflict.id, settle.settle, client);
  const notice = outcomeOf(result);
  client.log.info("conflict.settle", {
    number,
    outcome: settle.settle.outcome,
    result: notice.kind === "done" ? notice.done : notice.error,
  });
  return back(notice);
}

// How the pages word a conflict, kept here so it is tested without Next.js.

/** How a conflict came about, in plain words. */
export const kindLabel: Record<Conflict["kind"], string> = {
  replacement: "A replacement proposal",
  raised: "Raised in a thread",
  capture: "Found by listening",
};

/** What each kind means, for the conflict's page. */
export const kindAbout: Record<Conflict["kind"], string> = {
  replacement: "A decision was proposed to replace one that someone else made.",
  raised: "The bot raised it in a thread, where people wanted different things.",
  capture:
    "While listening in a channel, the bot found a proposal that would replace an active decision.",
};

/** How each outcome reads. */
export const outcomeLabel: Record<ConflictOutcome, string> = {
  kept: "Kept: what was decided stands",
  changed: "Changed: the decision changes",
  dismissed: "Dismissed: not a conflict after all",
};

/** Names in a sentence: "Ada", "Ada or Grace", "Ada, Grace or Linus". */
export function namesOr(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} or ${names.at(-1) ?? ""}`;
}

/** Who decides a conflict, or that nobody is set to. */
export function decidersText(deciders: Conflict["deciders"]): string {
  return deciders.length === 0 ? "Nobody is set to decide it" : namesOr(deciders.map(nameOf));
}

/** Why a person may not settle a conflict here, in plain words. */
export function refusalText(reason: ConflictRefusal | null, conflict: Conflict): string {
  switch (reason) {
    case "not_decider":
      return conflict.deciders.length === 0
        ? "Nobody is set to decide it: its area has no owner and no fallback owner is set."
        : `Only the people named decide it: ${namesOr(conflict.deciders.map(nameOf))}.`;
    case "has_proposal":
      return conflict.proposal === null
        ? "It is settled by confirming or rejecting its proposal."
        : `It is settled by confirming or rejecting its proposal, decision ${conflict.proposal.number}.`;
    case "settled":
      return "It is already settled.";
    case null:
      return "You cannot settle it.";
  }
}

/** The sentence a notice from settling shows. */
export function settleNoticeText(notice: SettleNotice, conflict: Conflict | undefined): string {
  if (notice.kind === "done") return "Settled.";
  switch (notice.error) {
    case "not_decider":
    case "has_proposal":
      return conflict === undefined
        ? "You cannot settle it."
        : `Not settled. ${refusalText(notice.error, conflict)}`;
    case "already_settled":
      return "Someone settled it before you, so nothing was changed. Their outcome is below.";
    case "not_found":
      return "There is no such conflict.";
    case "invalid":
      return "Not settled: choose kept, changed or dismissed, with a note of at most 500 characters.";
    case "signed_out":
      return "Your sign-in has ended. Sign in again, then try again.";
    case "unavailable":
      return "Sign-in is not set up yet.";
    case "failed":
      return "The API did not answer in time. Reload the page to see whether it was settled, then try again if not.";
  }
}

/** What settling does, said above the form: the thread it came from is told, if it has one. */
export function settleAbout(conflict: Conflict): string {
  const told = conflict.conversationId !== null && conflict.kind !== "capture";
  return told
    ? "You decide it. The thread it came from gets a note, and the outcome is kept with who settled it and when."
    : "You decide it. The outcome is kept with who settled it and when.";
}

/** Where a conflict came up: its thread in Slack, or its channel. */
export function conflictThread(conflict: Conflict): Where | undefined {
  if (conflict.channelId === null) return undefined;
  if (conflict.threadId === null) {
    return { kind: "link", href: channelLink(conflict.channelId), text: "the channel in Slack" };
  }
  // Conflicts carry no source; every channel so far is Slack's.
  const href = messageLink("slack", conflict.channelId, null, conflict.threadId);
  return href === undefined ? undefined : { kind: "link", href, text: "the thread in Slack" };
}
