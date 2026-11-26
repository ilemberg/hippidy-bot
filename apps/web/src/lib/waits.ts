import { randomUUID } from "node:crypto";
import {
  createWaitRequestSchema,
  type CreateWaitRequest,
  type Wait,
  type WaitActionResult,
} from "@hippidy/contracts";
import {
  endWait,
  fetchPeople,
  fetchWaits,
  recordWait,
  type ApiClientDeps,
  type ApiResult,
} from "./api-client.ts";
import type { Known } from "./areas.ts";
import { fromThisApp } from "./auth-flow.ts";
import type { WebConfig } from "./config.ts";
import { readCookie, SESSION_COOKIE } from "./cookies.ts";
import { nameOf, type Where } from "./decisions.ts";
import { signedInPerson, type HomeDeps } from "./home.ts";
import { messageLink } from "./sessions-view.ts";
import type { Person } from "./tokens.ts";

// The waiting-on list (slice 3.3, decision 210): who waits on whom, for what and since when, the
// form with which a signed-in person records their own wait, and the button that ends one they
// are part of. Over the standard Request and Response, so it is tested without Next.js; the
// pages and route files only pass the real dependencies in.

/** The most the API gives in one list. */
export const WAITS_LIMIT = 200;

/** Where the form that records a wait posts. */
export const CREATE_WAIT_PATH = "/new-wait";

/** Which waits the list shows; `open` is the default. */
export const waitFilters = ["open", "ended"] as const;
export type WaitFilter = (typeof waitFilters)[number];

export const waitFilterLabel: Record<WaitFilter, string> = {
  open: "Open",
  ended: "Ended",
};

/** The list's address for a filter. */
export function waitsHref(filter: WaitFilter): string {
  return filter === "open" ? "/waits" : `/waits?status=${filter}`;
}

/** Where the button that ends a wait posts. */
export function endWaitPath(id: string): string {
  return `/waits/${encodeURIComponent(id)}/end`;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A wait's id from its address, or nothing when it cannot be one. */
export function waitIdFromPath(text: string): string | undefined {
  return GUID.test(text) ? text.toLowerCase() : undefined;
}

/** What an action did, as the page is told in its address. */
export const waitDone = ["recorded", "ended"] as const;
export type WaitDone = (typeof waitDone)[number];

/** Why an action did nothing, as the page is told in its address. */
export const waitErrors = [
  "already_ended",
  "not_allowed",
  "not_found",
  "unknown_person",
  "invalid",
  "signed_out",
  "unavailable",
  "failed",
] as const;
export type WaitError = (typeof waitErrors)[number];

export type WaitNotice = { kind: "done"; done: WaitDone } | { kind: "error"; error: WaitError };

/** The notice for `?done=` or `?error=`, if it is one this app sends. */
export function waitNotice(
  done: string | undefined,
  error: string | undefined,
): WaitNotice | undefined {
  const isDone = waitDone.find((value) => value === done);
  if (isDone !== undefined) return { kind: "done", done: isDone };
  const isError = waitErrors.find((value) => value === error);
  return isError === undefined ? undefined : { kind: "error", error: isError };
}

/** The sentence a notice from an action shows. */
export function waitNoticeText(notice: WaitNotice): string {
  if (notice.kind === "done") {
    switch (notice.done) {
      case "recorded":
        return "Recorded.";
      case "ended":
        return "Ended.";
    }
  }
  switch (notice.error) {
    case "already_ended":
      return "It had already ended, so nothing was changed.";
    case "not_allowed":
      return "Only the person waiting, the person waited on, or whoever recorded it can end a wait.";
    case "not_found":
      return "There is no such wait.";
    case "unknown_person":
      return "Not recorded: the bot does not know that person.";
    case "invalid":
      return "Not recorded: choose whom you are waiting on, say for what in at most 300 characters, and give a task's key like T-12 or SCRUM-8, or none.";
    case "signed_out":
      return "Your sign-in has ended. Sign in again, then try again.";
    case "unavailable":
      return "Sign-in is not set up yet.";
    case "failed":
      return "The API did not answer in time. Reload the page to see whether it was saved, then try again if not.";
  }
}

/** What the waiting-on page shows. */
export type WaitsView =
  | { kind: "unconfigured" }
  | { kind: "signed_out"; notice: WaitNotice | undefined }
  | {
      kind: "signed_in";
      person: Person;
      filter: WaitFilter;
      list: ApiResult<Wait[]>;
      /** Whom the form offers to wait on. */
      people: ApiResult<Known[]>;
      /** Whether the API gave as many as it gives at once, so some may not be shown. */
      truncated: boolean;
      notice: WaitNotice | undefined;
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

const isFilter = (value: string | undefined): value is WaitFilter =>
  waitFilters.some((filter) => filter === value);

/** Reads the session cookie and, for a signed-in person, the waits asked for and the people. */
export async function loadWaits(
  input: {
    sessionCookie: string | undefined;
    status: string | undefined;
    done: string | undefined;
    error: string | undefined;
  },
  deps: HomeDeps,
): Promise<WaitsView> {
  const config = deps.config;
  if (config === undefined) return { kind: "unconfigured" };
  const now = deps.now?.() ?? new Date();
  const notice = waitNotice(input.done, input.error);
  const person = await signedInPerson(input.sessionCookie, config, now);
  if (person === undefined) return { kind: "signed_out", notice };
  const filter = isFilter(input.status) ? input.status : "open";
  const client = clientDeps(person, config, deps, now);
  const [list, people] = await Promise.all([
    fetchWaits(person, { status: filter, limit: WAITS_LIMIT }, client),
    fetchPeople(person, client),
  ]);
  return {
    kind: "signed_in",
    person,
    filter,
    list,
    people,
    truncated: list.kind === "ok" && list.value.length >= WAITS_LIMIT,
    notice,
    readAt: now.toISOString(),
  };
}

const field = (form: FormData, name: string): string | undefined => {
  const value = form.get(name);
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : undefined;
};

/** What the form asks for, from its fields. */
export type FormWait = { kind: "record"; wait: CreateWaitRequest } | { kind: "invalid" };

/** The body from the form's fields: an empty task key is none. Never who waits. */
export function waitFromForm(form: FormData): FormWait {
  const task = field(form, "task");
  const parsed = createWaitRequestSchema.safeParse({
    waitingOnActorId: field(form, "waiting_on") ?? "",
    what: field(form, "what") ?? "",
    ...(task === undefined || task === "" ? {} : { taskKey: task }),
  });
  return parsed.success ? { kind: "record", wait: parsed.data } : { kind: "invalid" };
}

/** The forms the waiting-on page posts. */
export type WaitAction = "record" | "end";

function outcomeOf(result: ApiResult<WaitActionResult>, action: WaitAction): WaitNotice {
  if (result.kind === "failed") return { kind: "error", error: "failed" };
  const status = result.value.status;
  switch (status) {
    case "recorded":
      return action === "record"
        ? { kind: "done", done: status }
        : { kind: "error", error: "failed" };
    case "ended":
      return action === "end" ? { kind: "done", done: status } : { kind: "error", error: "failed" };
    case "already_ended":
    case "not_allowed":
    case "not_found":
    case "unknown_person":
      return { kind: "error", error: status };
  }
}

/**
 * `POST /new-wait` or `POST /waits/<id>/end`: a signed-in person records their own wait, or ends
 * one they are part of. Only from this app's own pages, and only for a signed-in person, as whom
 * the API is called: who waits or who ends it is never read from the form. Answers with the
 * waiting-on page.
 */
export async function handleWaitAction(
  request: Request,
  action: WaitAction,
  idText: string | undefined,
  deps: HomeDeps,
): Promise<Response> {
  const log = deps.log.child({ correlationId: randomUUID() });
  const id = idText === undefined ? undefined : waitIdFromPath(idText);
  if (action === "end" && id === undefined) return new Response("Not found.", { status: 404 });
  if (!fromThisApp(request, deps.config)) {
    log.warn("wait.action_refused", { reason: "cross_origin", action, waitId: id });
    return new Response("Changes to waits must come from this app.", { status: 403 });
  }
  const config = deps.config;
  const back = (notice: WaitNotice): Response => {
    const url = new URL("/waits", config?.webBaseUrl ?? request.url);
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
    log.warn("wait.action_refused", { reason: "signed_out", action, waitId: id });
    return back({ kind: "error", error: "signed_out" });
  }
  const client = clientDeps(person, config, deps, now);

  let result: ApiResult<WaitActionResult>;
  if (action === "end") {
    if (id === undefined) return back({ kind: "error", error: "not_found" });
    result = await endWait(person, id, client);
  } else {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return back({ kind: "error", error: "invalid" });
    }
    const wait = waitFromForm(form);
    if (wait.kind === "invalid") return back({ kind: "error", error: "invalid" });
    result = await recordWait(person, wait.wait, client);
  }
  const notice = outcomeOf(result, action);
  client.log.info("wait.action", {
    action,
    waitId: id ?? (result.kind === "ok" ? result.value.wait?.id : undefined),
    outcome: notice.kind === "done" ? notice.done : notice.error,
  });
  return back(notice);
}

// How the pages word a wait, kept here so it is tested without Next.js.

/** Waits on one person. */
export interface WaitGroup {
  key: string;
  label: string;
  waits: Wait[];
}

/**
 * Waits by the person waited on, people in alphabetical order; in each, the longest waiting
 * first, or, once ended, the latest ended first.
 */
export function groupByWaitingOn(waits: readonly Wait[]): WaitGroup[] {
  const byPerson = new Map<string, WaitGroup>();
  for (const wait of waits) {
    const key = wait.waitingOn.actorId;
    const group = byPerson.get(key);
    if (group === undefined) {
      byPerson.set(key, { key, label: nameOf(wait.waitingOn), waits: [wait] });
    } else group.waits.push(wait);
  }
  const order = (a: Wait, b: Wait) =>
    a.endedAt !== null && b.endedAt !== null
      ? b.endedAt.localeCompare(a.endedAt)
      : new Date(a.since).getTime() - new Date(b.since).getTime();
  return [...byPerson.values()]
    .map((group) => ({ ...group, waits: group.waits.sort(order) }))
    .sort((a, b) => a.label.localeCompare(b.label, "en", { sensitivity: "base" }));
}

/** Whether the person signed in may end a wait: they wait, are waited on, or recorded it. */
export function youArePart(wait: Wait, you: Person): boolean {
  return [wait.waiter, wait.waitingOn, wait.recordedBy].some((who) => who.actorId === you.actorId);
}

/** How long a wait has lasted: "a moment", "5 min", "3 h", "1 day", "4 days". */
export function waitedFor(since: string, until: Date): string {
  const minutes = Math.floor((until.getTime() - new Date(since).getTime()) / 60_000);
  if (minutes < 1) return "a moment";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day" : `${days} days`;
}

/** Since when, and how long: "since 2026-11-23 (2 days)". */
export function sinceText(since: string, now: Date): string {
  return `since ${since.slice(0, 10)} (${waitedFor(since, now)})`;
}

/** Where a wait was said: its thread in Slack, or nothing when it was recorded in the web app. */
export function waitThread(wait: Wait): Where | undefined {
  if (wait.channelId === null || wait.threadId === null) return undefined;
  // Waits carry no source; every channel so far is Slack's.
  const href = messageLink("slack", wait.channelId, null, wait.threadId);
  return href === undefined ? undefined : { kind: "link", href, text: "the thread in Slack" };
}

/** The people a person may wait on: those the record knows, each once, without themselves. */
export function waitingOnOptions(
  people: ApiResult<Known[]>,
  you: Person,
): { value: string; label: string }[] {
  if (people.kind === "failed") return [];
  const seen = new Set<string>([you.actorId]);
  const options: { value: string; label: string }[] = [];
  for (const p of people.value) {
    if (seen.has(p.actorId)) continue;
    seen.add(p.actorId);
    options.push({ value: p.actorId, label: nameOf(p) });
  }
  return options.sort((a, b) => a.label.localeCompare(b.label, "en", { sensitivity: "base" }));
}
