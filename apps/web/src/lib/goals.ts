import { randomUUID } from "node:crypto";
import {
  createGoalRequestSchema,
  DEFAULT_GOAL_CAP_CENTS,
  DEFAULT_GOAL_EVERY_MINUTES,
  DEFAULT_GOAL_LIMIT,
  editGoalRequestSchema,
  MAX_GOAL_TICKETS,
  type CreateGoalRequest,
  type EditGoalRequest,
  type Goal,
  type GoalActionResult,
  type GoalTicket,
  type GoalTicketState,
  type JobDetail,
} from "@hippidy/contracts";
import { createGoal, editGoal, fetchJob, type ApiResult } from "./api-client.ts";
import { fromThisApp } from "./auth-flow.ts";
import { readCookie, SESSION_COOKIE } from "./cookies.ts";
import { signedInPerson, type HomeDeps } from "./home.ts";
import {
  centsFromText,
  clientDeps,
  jobHref,
  jobNameFromPath,
  jobNotice,
  minutesFromText,
  versionOf,
  type JobNotice,
} from "./jobs.ts";
import { taskHref } from "./tasks.ts";
import type { Person } from "./tokens.ts";

// Feature goals in the web app (slice 4.4, decision 221): the "New goal" form at
// `/jobs/new-goal`, and a goal's tickets, with their changes and pull requests, on its job's
// page, where its tickets and limit are changed. Over the standard Request and Response, so it
// is tested without Next.js; the pages and route files only pass the real dependencies in.

/** Where the new-goal form is, and where it posts (not under `/jobs/`, where a name is). */
export const NEW_GOAL_PAGE = "/jobs/new-goal";
export const NEW_GOAL_PATH = "/new-goal";

/** Where a goal's edit form posts. */
export function goalEditHref(name: string): string {
  return `${jobHref(name)}/goal`;
}

/**
 * The thread a Slack link points at: `https://x.slack.com/archives/C123ABC/p1700000000000200`
 * is channel `C123ABC`, thread `1700000000.000200`. A link to a reply names its thread in
 * `thread_ts`. Nothing for anything else.
 */
export function threadFromLink(text: string): { channelId: string; threadId: string } | undefined {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (url.hostname !== "slack.com" && !url.hostname.endsWith(".slack.com")) return undefined;
  const match = /^\/archives\/([A-Z0-9]{2,40})\/p(\d{7,20})\/?$/.exec(url.pathname);
  if (match === null) return undefined;
  const [, channelId = "", digits = ""] = match;
  const threadTs = url.searchParams.get("thread_ts");
  if (threadTs !== null) {
    return /^\d{1,14}\.\d{1,6}$/.test(threadTs) ? { channelId, threadId: threadTs } : undefined;
  }
  return { channelId, threadId: `${digits.slice(0, -6)}.${digits.slice(-6)}` };
}

const TICKET_KEY = /^[A-Z][A-Z0-9]{0,19}-[1-9][0-9]{0,8}$/;

/**
 * Ticket keys as a person lists them, one per line or separated by commas or spaces, in order,
 * each once. Nothing when one is not a key, or there are none or more than 30.
 */
export function ticketsFromText(text: string): string[] | undefined {
  const keys = text
    .split(/[\s,;]+/)
    .map((key) => key.trim().toUpperCase())
    .filter((key) => key !== "");
  if (keys.some((key) => !TICKET_KEY.test(key))) return undefined;
  const unique = [...new Set(keys)];
  return unique.length >= 1 && unique.length <= MAX_GOAL_TICKETS ? unique : undefined;
}

const field = (form: FormData, name: string): string | undefined => {
  const value = form.get(name);
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : undefined;
};

/** Why the new-goal form could not be sent, before the API is asked. */
export type FormError = "invalid" | "bad_link" | "bad_tickets";

/** The goal the form asks for, or why not. */
export function goalCreateFromForm(
  form: FormData,
): { kind: "create"; goal: CreateGoalRequest } | { kind: "invalid"; error: FormError } {
  const thread = threadFromLink(field(form, "link") ?? "");
  if (thread === undefined) return { kind: "invalid", error: "bad_link" };
  const tickets = ticketsFromText(field(form, "tickets") ?? "");
  if (tickets === undefined) return { kind: "invalid", error: "bad_tickets" };
  const limitText = field(form, "limit") ?? "";
  const capText = field(form, "cap") ?? "";
  const everyText = field(form, "everyMinutes") ?? "";
  const limit = limitText === "" ? DEFAULT_GOAL_LIMIT : minutesFromText(limitText);
  const capCents = capText === "" ? DEFAULT_GOAL_CAP_CENTS : centsFromText(capText);
  const everyMinutes = everyText === "" ? DEFAULT_GOAL_EVERY_MINUTES : minutesFromText(everyText);
  // A field typed but not a number is not the default.
  if (limit === undefined || capCents === undefined || everyMinutes === undefined) {
    return { kind: "invalid", error: "invalid" };
  }
  const goal = {
    name: field(form, "name") ?? "",
    goal: field(form, "goal") ?? "",
    ...thread,
    tickets,
    limit,
    capCents,
    everyMinutes,
  };
  const parsed = createGoalRequestSchema.safeParse(goal);
  return parsed.success
    ? { kind: "create", goal: parsed.data }
    : { kind: "invalid", error: "invalid" };
}

/** What the goal's edit form asks for: only what differs from the goal shown. */
export type FormGoalEdit =
  | { kind: "edit"; edit: EditGoalRequest }
  | { kind: "unchanged" }
  | { kind: "invalid"; error: "invalid" | "bad_tickets" };

export function goalEditFromForm(form: FormData, detail: JobDetail & { goal: Goal }): FormGoalEdit {
  const version = versionOf(form);
  if (version === undefined) return { kind: "invalid", error: "invalid" };
  const edit: EditGoalRequest = { version };
  const ticketsText = field(form, "tickets");
  if (ticketsText !== undefined) {
    const tickets = ticketsFromText(ticketsText);
    if (tickets === undefined) return { kind: "invalid", error: "bad_tickets" };
    const shown = detail.goal.tickets.map((ticket) => ticket.key);
    if (JSON.stringify(tickets) !== JSON.stringify(shown)) edit.tickets = tickets;
  }
  const limitText = field(form, "limit");
  if (limitText !== undefined) {
    const limit = minutesFromText(limitText);
    if (limit === undefined) return { kind: "invalid", error: "invalid" };
    if (limit !== detail.goal.limit) edit.limit = limit;
  }
  if (edit.tickets === undefined && edit.limit === undefined) return { kind: "unchanged" };
  const parsed = editGoalRequestSchema.safeParse(edit);
  return parsed.success
    ? { kind: "edit", edit: parsed.data }
    : { kind: "invalid", error: "invalid" };
}

/** The notice an API answer gives, with the tickets it names. */
function outcomeOf(result: ApiResult<GoalActionResult>): JobNotice {
  if (result.kind === "failed") return { kind: "error", error: "failed" };
  const value = result.value;
  switch (value.status) {
    case "created":
    case "edited":
      return { kind: "done", done: value.status };
    case "unknown_tickets":
    case "briefed_tickets":
      return { kind: "error", error: value.status, tickets: value.tickets ?? [] };
    default:
      return { kind: "error", error: value.status };
  }
}

/** A 303 back to `path` with the notice in its address. */
function redirect(path: string, notice: JobNotice, base: string): Response {
  const url = new URL(path, base);
  if (notice.kind === "done") url.searchParams.set("done", notice.done);
  else {
    url.searchParams.set("error", notice.error);
    if (notice.tickets !== undefined && notice.tickets.length > 0) {
      url.searchParams.set("tickets", notice.tickets.join(","));
    }
  }
  return new Response(null, {
    status: 303,
    headers: { location: url.toString(), "cache-control": "no-store" },
  });
}

/** What the new-goal page shows. */
export type NewGoalView =
  | { kind: "unconfigured" }
  | { kind: "signed_out" }
  | { kind: "signed_in"; person: Person; notice: JobNotice | undefined };

/** Reads the session cookie: the form for a signed-in person, with what the last try said. */
export async function loadNewGoal(
  input: {
    sessionCookie: string | undefined;
    error: string | undefined;
    tickets: string | undefined;
  },
  deps: HomeDeps,
): Promise<NewGoalView> {
  const config = deps.config;
  if (config === undefined) return { kind: "unconfigured" };
  const now = deps.now?.() ?? new Date();
  const person = await signedInPerson(input.sessionCookie, config, now);
  if (person === undefined) return { kind: "signed_out" };
  return { kind: "signed_in", person, notice: jobNotice(undefined, input.error, input.tickets) };
}

/**
 * `POST /new-goal`: the form at `/jobs/new-goal` makes a goal. Only from this app's own pages,
 * and only for a signed-in person, as whom the API is called: who acts is never read from the
 * form. Answers with the goal's page, or the form again and why not.
 */
export async function handleNewGoal(request: Request, deps: HomeDeps): Promise<Response> {
  const log = deps.log.child({ correlationId: randomUUID() });
  if (!fromThisApp(request, deps.config)) {
    log.warn("goal.create_refused", { reason: "cross_origin" });
    return new Response("Goals must be made from this app.", { status: 403 });
  }
  const config = deps.config;
  const base = config?.webBaseUrl ?? request.url;
  const back = (notice: JobNotice) => redirect(NEW_GOAL_PAGE, notice, base);
  if (config === undefined) return back({ kind: "error", error: "unavailable" });
  const now = deps.now?.() ?? new Date();
  const person = await signedInPerson(
    readCookie(request.headers.get("cookie"), SESSION_COOKIE),
    config,
    now,
  );
  if (person === undefined) {
    log.warn("goal.create_refused", { reason: "signed_out" });
    return back({ kind: "error", error: "signed_out" });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back({ kind: "error", error: "invalid" });
  }
  const create = goalCreateFromForm(form);
  if (create.kind === "invalid") {
    return back({
      kind: "error",
      error: create.error === "invalid" ? "goal_invalid" : create.error,
    });
  }
  const client = clientDeps(person, config, deps, now);
  const result = await createGoal(person, create.goal, client);
  const notice = outcomeOf(result);
  client.log.info("goal.create", {
    tickets: create.goal.tickets.length,
    outcome: notice.kind === "done" ? notice.done : notice.error,
  });
  const name = result.kind === "ok" ? result.value.name : undefined;
  return notice.kind === "done" && name !== undefined
    ? redirect(jobHref(name), notice, base)
    : back(notice);
}

/**
 * `POST /jobs/<name>/goal`: the form on a goal's page changes its tickets or limit, on the
 * version shown. Only from this app's pages, as the signed-in person.
 */
export async function handleGoalEdit(
  request: Request,
  nameText: string,
  deps: HomeDeps,
): Promise<Response> {
  const log = deps.log.child({ correlationId: randomUUID() });
  const name = jobNameFromPath(nameText);
  if (name === undefined) return new Response("Not found.", { status: 404 });
  if (!fromThisApp(request, deps.config)) {
    log.warn("goal.edit_refused", { reason: "cross_origin", name });
    return new Response("Changes to goals must come from this app.", { status: 403 });
  }
  const config = deps.config;
  const back = (notice: JobNotice) =>
    redirect(jobHref(name), notice, config?.webBaseUrl ?? request.url);
  if (config === undefined) return back({ kind: "error", error: "unavailable" });
  const now = deps.now?.() ?? new Date();
  const person = await signedInPerson(
    readCookie(request.headers.get("cookie"), SESSION_COOKIE),
    config,
    now,
  );
  if (person === undefined) {
    log.warn("goal.edit_refused", { reason: "signed_out", name });
    return back({ kind: "error", error: "signed_out" });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back({ kind: "error", error: "invalid" });
  }
  if (versionOf(form) === undefined) return back({ kind: "error", error: "invalid" });
  const client = clientDeps(person, config, deps, now);
  const lookup = await fetchJob(person, name, client);
  if (lookup.kind === "not_found") return back({ kind: "error", error: "not_found" });
  if (lookup.kind === "failed") return back({ kind: "error", error: "failed" });
  const detail = lookup.value;
  const goal = detail.goal;
  if (goal === null) return back({ kind: "error", error: "not_found" });
  const edit = goalEditFromForm(form, { ...detail, goal });
  if (edit.kind === "unchanged") return back({ kind: "error", error: "unchanged" });
  if (edit.kind === "invalid") {
    return back({ kind: "error", error: edit.error === "invalid" ? "goal_invalid" : edit.error });
  }
  const result = await editGoal(person, detail.job.id, edit.edit, client);
  const notice = outcomeOf(result);
  client.log.info("goal.edit", {
    name,
    fields: Object.keys(edit.edit).filter((key) => key !== "version"),
    outcome: notice.kind === "done" ? notice.done : notice.error,
  });
  return back(notice);
}

// How the pages word a goal, kept here so it is tested without Next.js.

export const ticketStateLabel: Record<GoalTicketState, string> = {
  pending: "Not briefed yet",
  briefed: "Briefed",
  merged: "Merged",
  closed: "Closed without merging",
  stopped: "Stopped",
  done_elsewhere: "Done before it was briefed",
  skipped: "Skipped",
};

const changeStatusLabel: Record<NonNullable<GoalTicket["change"]>["status"], string> = {
  waiting_for_start: "Waiting for Start",
  started: "Started",
  stopped: "Stopped",
};

/** One row of a goal's tickets table, in order. */
export interface TicketRow {
  key: string;
  title: string;
  /** The ticket in the tracker, or its page here for a built-in task. */
  href: string;
  state: GoalTicketState;
  label: string;
  change: string | null;
  pullRequest: { href: string; text: string } | null;
}

export function ticketRows(goal: Goal): TicketRow[] {
  return goal.tickets.map((ticket) => {
    const url = ticket.change?.pullRequestUrl ?? null;
    const number = url === null ? undefined : /\/pull\/(\d+)/.exec(url)?.[1];
    return {
      key: ticket.key,
      title: ticket.title,
      href: ticket.url ?? taskHref(ticket.key),
      state: ticket.state,
      label:
        ticket.state === "pending" && ticket.failures > 0
          ? `${ticketStateLabel.pending} (${String(ticket.failures)} failed ${ticket.failures === 1 ? "try" : "tries"})`
          : ticketStateLabel[ticket.state],
      change: ticket.change === null ? null : changeStatusLabel[ticket.change.status],
      pullRequest:
        url === null ? null : { href: url, text: number === undefined ? url : `#${number}` },
    };
  });
}

/** "2 of 3 open": the changes open against the limit. */
export function openText(goal: Goal): string {
  return `${String(goal.open)} of ${String(goal.limit)} open`;
}

/** What the tickets field shows: one key per line, in order. */
export function ticketsFieldValue(goal: Goal): string {
  return goal.tickets.map((ticket) => ticket.key).join("\n");
}
