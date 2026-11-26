import { randomUUID } from "node:crypto";
import {
  editJobRequestSchema,
  type EditJobRequest,
  type Job,
  type JobActionResult,
  type JobDetail,
  type JobKind,
  type JobList,
  type JobState,
  type JobWake,
} from "@hippidy/contracts";
import { editJob, fetchJob, fetchJobs, type ApiClientDeps, type ApiResult } from "./api-client.ts";
import { fromThisApp } from "./auth-flow.ts";
import type { WebConfig } from "./config.ts";
import { readCookie, SESSION_COOKIE } from "./cookies.ts";
import { nameOf } from "./decisions.ts";
import { signedInPerson, type HomeDeps } from "./home.ts";
import type { Person } from "./tokens.ts";

// Standing jobs (slices 4.1 and 4.2, decisions 215 and 217): every job with its schedule, state
// and this month's spend against its cap, one job's page with its wakes and history, and the form
// that pauses, resumes or changes one. Over the standard Request and Response, so it is tested
// without Next.js; the pages and route files only pass the real dependencies in.

/** What all jobs together are meant to stay inside, a month, in cents (decision 11). */
export const MONTHLY_BUDGET_CENTS = 10_000;

/** A job's page. Its name is encoded as one segment. */
export function jobHref(name: string): string {
  return `/jobs/${encodeURIComponent(name)}`;
}

/**
 * A job's name from its address: decoded if it still is, trimmed and lowercased like the API
 * does. Nothing when it cannot be a name (1 to 60 characters, no control characters).
 */
export function jobNameFromPath(text: string): string | undefined {
  let decoded = text;
  if (text.includes("%")) {
    try {
      decoded = decodeURIComponent(text);
    } catch {
      return undefined;
    }
  }
  const name = decoded.trim().toLowerCase();
  if (name.length < 1 || name.length > 60) return undefined;
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  return name;
}

/** What an action did, as the page is told in its address: a goal is made, or a job edited. */
export const jobDone = ["edited", "created"] as const;
export type JobDone = (typeof jobDone)[number];

/** Why an action did nothing, as the page is told in its address. */
export const jobErrors = [
  "invalid",
  "unchanged",
  "changed",
  "still_capped",
  "not_found",
  "signed_out",
  "unavailable",
  "failed",
  // A goal's (slice 4.4).
  "goal_invalid",
  "bad_link",
  "bad_tickets",
  "no_thread",
  "thread_taken",
  "name_taken",
  "unknown_tickets",
  "briefed_tickets",
  "tracker_unavailable",
] as const;
export type JobError = (typeof jobErrors)[number];

export type JobNotice =
  | { kind: "done"; done: JobDone }
  /** `tickets`: the tickets the error is about, when it names some. */
  | { kind: "error"; error: JobError; tickets?: string[] };

const TICKET_KEY = /^[A-Z][A-Z0-9]{0,19}-[1-9][0-9]{0,8}$/;

/**
 * The notice for `?done=` or `?error=`, if it is one this app sends, with the tickets
 * `?tickets=` names (only real keys, at most 30).
 */
export function jobNotice(
  done: string | undefined,
  error: string | undefined,
  tickets?: string,
): JobNotice | undefined {
  const isDone = jobDone.find((value) => value === done);
  if (isDone !== undefined) return { kind: "done", done: isDone };
  const isError = jobErrors.find((value) => value === error);
  if (isError === undefined) return undefined;
  const keys = (tickets ?? "")
    .split(",")
    .filter((key) => TICKET_KEY.test(key))
    .slice(0, 30);
  return keys.length === 0
    ? { kind: "error", error: isError }
    : { kind: "error", error: isError, tickets: keys };
}

/** The sentence a notice from an action shows. */
export function jobNoticeText(notice: JobNotice): string {
  if (notice.kind === "done") {
    return notice.done === "created"
      ? "Goal made. It wakes within a few minutes and posts its first brief in its thread."
      : "Saved.";
  }
  const named = notice.tickets === undefined ? "" : `: ${notice.tickets.join(", ")}`;
  switch (notice.error) {
    case "invalid":
      return "Not saved: a cap is $0.00 to $100.00 a month, an interval 1 to 1,440 minutes, and a goal at most 2,000 characters.";
    case "unchanged":
      return "Nothing was changed.";
    case "changed":
      return "Someone changed this job after you opened it, so nothing was saved. Read it again below, then try again.";
    case "still_capped":
      return "Not resumed: it reached its cap this month. Raise its cap above this month's spend to resume it.";
    case "not_found":
      return "There is no such job.";
    case "signed_out":
      return "Your sign-in has ended. Sign in again, then try again.";
    case "unavailable":
      return "Sign-in is not set up yet.";
    case "failed":
      return "The API did not answer in time. Reload the page to see whether it was saved, then try again if not.";
    case "goal_invalid":
      return "Not saved: a name is lowercase letters, digits and hyphens; the goal 1 to 2,000 characters; the limit 1 to 5; a cap $0.00 to $100.00 a month; an interval 1 to 1,440 minutes.";
    case "bad_link":
      return "Not saved: paste the link of a Slack thread (in Slack: More actions, Copy link).";
    case "bad_tickets":
      return "Not saved: list 1 to 30 ticket keys, like T-4 or SCRUM-8, one per line or separated by commas.";
    case "no_thread":
      return "Not saved: the bot is not in that thread yet. Mention the bot there first, then try again.";
    case "thread_taken":
      return "Not saved: that thread has a goal already. One goal per thread.";
    case "name_taken":
      return "Not saved: a job has that name already. Choose another.";
    case "unknown_tickets":
      return `Not saved: the tracker has no such ticket${named}.`;
    case "briefed_tickets":
      return `Not saved: a ticket already briefed stays in the goal${named}.`;
    case "tracker_unavailable":
      return "Not saved: the tracker did not answer, so the tickets could not be checked. Try again later.";
  }
}

/** What the jobs page shows. */
export type JobsView =
  | { kind: "unconfigured" }
  | { kind: "signed_out" }
  | { kind: "signed_in"; person: Person; list: ApiResult<JobList>; readAt: string };

/** What the page of one job shows. */
export type JobView =
  | { kind: "unconfigured" }
  | { kind: "signed_out"; notice: JobNotice | undefined }
  | { kind: "not_found"; person: Person; name: string | undefined }
  | { kind: "failed"; person: Person; reason: string }
  | {
      kind: "ok";
      person: Person;
      detail: JobDetail;
      notice: JobNotice | undefined;
      readAt: string;
    };

/** The API client's needs for one action, under a correlation id of its own. */
export function clientDeps(
  person: Person,
  config: WebConfig,
  deps: HomeDeps,
  now: Date,
): ApiClientDeps {
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

/** Reads the session cookie and, for a signed-in person, every job. */
export async function loadJobs(
  input: { sessionCookie: string | undefined },
  deps: HomeDeps,
): Promise<JobsView> {
  const config = deps.config;
  if (config === undefined) return { kind: "unconfigured" };
  const now = deps.now?.() ?? new Date();
  const person = await signedInPerson(input.sessionCookie, config, now);
  if (person === undefined) return { kind: "signed_out" };
  const list = await fetchJobs(person, clientDeps(person, config, deps, now));
  return { kind: "signed_in", person, list, readAt: now.toISOString() };
}

/** Reads the session cookie and, for a signed-in person, one job with its wakes and history. */
export async function loadJob(
  input: {
    sessionCookie: string | undefined;
    name: string;
    done: string | undefined;
    error: string | undefined;
    /** The tickets a goal's notice names (slice 4.4). */
    tickets?: string | undefined;
  },
  deps: HomeDeps,
): Promise<JobView> {
  const config = deps.config;
  if (config === undefined) return { kind: "unconfigured" };
  const now = deps.now?.() ?? new Date();
  const notice = jobNotice(input.done, input.error, input.tickets);
  const person = await signedInPerson(input.sessionCookie, config, now);
  if (person === undefined) return { kind: "signed_out", notice };
  const name = jobNameFromPath(input.name);
  if (name === undefined) return { kind: "not_found", person, name: undefined };
  const lookup = await fetchJob(person, name, clientDeps(person, config, deps, now));
  switch (lookup.kind) {
    case "not_found":
      return { kind: "not_found", person, name };
    case "failed":
      return { kind: "failed", person, reason: lookup.reason };
    case "ok":
      return { kind: "ok", person, detail: lookup.value, notice, readAt: now.toISOString() };
  }
}

const field = (form: FormData, name: string): string | undefined => {
  const value = form.get(name);
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : undefined;
};

/** The version the form was shown, which an edit sends. */
export function versionOf(form: FormData): number | undefined {
  const value = Number(field(form, "version"));
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** Dollars as a person types them ("40", "$40.5", "40.00") in whole cents; nothing if not. */
export function centsFromText(text: string): number | undefined {
  const match = /^\$?\s*(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (match === null) return undefined;
  const [, dollars = "0", cents = ""] = match;
  return Number(dollars) * 100 + Number(cents.padEnd(2, "0"));
}

/** Whole minutes as typed; nothing if not a whole number. */
export function minutesFromText(text: string): number | undefined {
  return /^\d{1,5}$/.test(text.trim()) ? Number(text.trim()) : undefined;
}

/** What the edit form asks for, from its fields. */
export type FormJobEdit =
  { kind: "edit"; edit: EditJobRequest } | { kind: "unchanged" } | { kind: "invalid" };

/**
 * The edit body from the form's fields: only what differs from the job now, with the version the
 * form showed, so a change made meanwhile by someone else is not overwritten. A state of `capped`
 * leaves it as it is (only the job sets it); an empty goal clears it; a missing field is left out.
 */
export function jobEditFromForm(form: FormData, current: Job): FormJobEdit {
  const version = versionOf(form);
  if (version === undefined) return { kind: "invalid" };
  const edit: EditJobRequest = { version };
  const state = field(form, "state");
  if (state !== undefined && state !== "capped" && state !== current.state) {
    if (state !== "active" && state !== "paused") return { kind: "invalid" };
    edit.state = state;
  }
  const capText = field(form, "cap");
  if (capText !== undefined) {
    const capCents = centsFromText(capText);
    if (capCents === undefined) return { kind: "invalid" };
    if (capCents !== current.capCents) edit.capCents = capCents;
  }
  const everyText = field(form, "everyMinutes");
  if (everyText !== undefined) {
    const everyMinutes = minutesFromText(everyText);
    if (everyMinutes === undefined) return { kind: "invalid" };
    if (everyMinutes !== current.everyMinutes) edit.everyMinutes = everyMinutes;
  }
  const goal = field(form, "goal");
  const newGoal = goal === "" ? null : goal;
  if (newGoal !== undefined && newGoal !== current.goal) edit.goal = newGoal;
  if (Object.keys(edit).length === 1) return { kind: "unchanged" };
  const parsed = editJobRequestSchema.safeParse(edit);
  return parsed.success ? { kind: "edit", edit: parsed.data } : { kind: "invalid" };
}

function outcomeOf(result: ApiResult<JobActionResult>): JobNotice {
  if (result.kind === "failed") return { kind: "error", error: "failed" };
  const status = result.value.status;
  switch (status) {
    case "edited":
      return { kind: "done", done: status };
    case "unchanged":
    case "changed":
    case "still_capped":
    case "not_found":
      return { kind: "error", error: status };
  }
}

/**
 * `POST /jobs/<name>/edit`: the form on a job's page pauses, resumes or changes it. Only from this
 * app's own pages, and only for a signed-in person, as whom the API is called: who acts is never
 * read from the form. Answers with the job's page and what happened.
 */
export async function handleJobEdit(
  request: Request,
  nameText: string,
  deps: HomeDeps,
): Promise<Response> {
  const log = deps.log.child({ correlationId: randomUUID() });
  const name = jobNameFromPath(nameText);
  if (name === undefined) return new Response("Not found.", { status: 404 });
  if (!fromThisApp(request, deps.config)) {
    log.warn("job.edit_refused", { reason: "cross_origin", name });
    return new Response("Changes to jobs must come from this app.", { status: 403 });
  }
  const config = deps.config;
  const back = (notice: JobNotice): Response => {
    const url = new URL(jobHref(name), config?.webBaseUrl ?? request.url);
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
    log.warn("job.edit_refused", { reason: "signed_out", name });
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
  const job = lookup.value.job;
  const edit = jobEditFromForm(form, job);
  if (edit.kind !== "edit") return back({ kind: "error", error: edit.kind });
  const result = await editJob(person, job.id, edit.edit, client);
  const notice = outcomeOf(result);
  client.log.info("job.edit", {
    name,
    fields: Object.keys(edit.edit).filter((key) => key !== "version"),
    outcome: notice.kind === "done" ? notice.done : notice.error,
  });
  return back(notice);
}

// How the pages word a job, kept here so it is tested without Next.js.

export const jobKindLabel: Record<JobKind, string> = {
  capture: "Capture",
  briefs: "Briefs",
  checker: "Checker",
  goal: "Goal",
};

export const jobStateLabel: Record<JobState, string> = {
  active: "Active",
  paused: "Paused by a person",
  capped: "Capped: reached its cap",
};

export const wakeOutcomeLabel: Record<JobWake["outcome"], string> = {
  said: "Said",
  silent: "Silent",
  failed: "Failed",
  skipped: "Skipped",
};

/** Whole cents as "$40.00". */
export function centsText(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Millionths of a dollar as "$12.34", or "under $0.01" for a cost too small to show in cents. */
export function microsText(micros: number): string {
  const cents = Math.round(micros / 10_000);
  return micros > 0 && cents === 0 ? "under $0.01" : centsText(cents);
}

/** "every minute", "every 5 minutes". */
export function everyText(minutes: number): string {
  return minutes === 1 ? "every minute" : `every ${minutes} minutes`;
}

/** This month's spend against the cap: "$12.34 of $40.00". */
export function spendText(job: Job): string {
  return `${microsText(job.spentMicrosThisMonth)} of ${centsText(job.capCents)}`;
}

/** The sentence under the list: what all jobs together are meant to stay inside, and their caps. */
export function budgetText(jobs: readonly Job[]): string {
  const total = jobs.reduce((sum, job) => sum + job.capCents, 0);
  const caps = `their caps add up to ${centsText(total)}`;
  return `All jobs together are meant to stay inside ${centsText(MONTHLY_BUDGET_CENTS)} a month; ${
    total > MONTHLY_BUDGET_CENTS ? `${caps}, which is more than that.` : `${caps}.`
  }`;
}

/** What the cap field shows: dollars with cents, without the sign. */
export function capFieldValue(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** The states the form offers: active or paused, and, for a capped job, leaving it capped. */
export function stateOptions(state: JobState): { value: string; label: string }[] {
  return [
    ...(state === "capped"
      ? [{ value: "capped", label: "Capped (raising its cap above this month's spend resumes it)" }]
      : []),
    { value: "active", label: "Active" },
    { value: "paused", label: "Paused" },
  ];
}

/** One row of the wakes table, newest first. */
export interface WakeRow {
  key: string;
  at: string;
  outcome: JobWake["outcome"];
  label: string;
  text: string;
  cost: string;
}

export function wakeRows(wakes: readonly JobWake[]): WakeRow[] {
  return wakes.map((wake, index) => ({
    key: `${index}:${wake.startedAt}`,
    at: wake.startedAt,
    outcome: wake.outcome,
    label: wakeOutcomeLabel[wake.outcome],
    text:
      (wake.outcome === "failed" ? (wake.error ?? wake.summary) : (wake.summary ?? wake.error)) ??
      "",
    cost: microsText(wake.costMicros),
  }));
}

/** One change a person made, oldest first: who, when, and a sentence for each field changed. */
export interface JobHistoryItem {
  key: string;
  at: string;
  lines: string[];
}

const shortQuote = (text: string, most = 120): string =>
  `“${text.length > most ? `${text.slice(0, most - 1)}…` : text}”`;

/** The sentence for one field a person changed, or nothing when it did not change. */
function changeLine(who: string, key: string, before: unknown, after: unknown): string | undefined {
  if (JSON.stringify(before) === JSON.stringify(after)) return undefined;
  switch (key) {
    case "state":
      if (after === "paused") return `${who} paused it`;
      if (after === "active") return `${who} resumed it`;
      return `${who} changed its state from ${String(before)} to ${String(after)}`;
    case "capCents":
      if (typeof before === "number" && typeof after === "number") {
        return `${who} changed the cap from ${centsText(before)} to ${centsText(after)}`;
      }
      break;
    case "everyMinutes":
      if (typeof before === "number" && typeof after === "number") {
        return `${who} changed the interval from ${everyText(before)} to ${everyText(after)}`;
      }
      break;
    case "tickets":
      if (Array.isArray(before) && Array.isArray(after)) {
        return `${who} changed the tickets from ${before.join(", ")} to ${after.join(", ")}`;
      }
      break;
    case "limit":
      if (typeof before === "number" && typeof after === "number") {
        return `${who} changed the limit on open changes from ${String(before)} to ${String(after)}`;
      }
      break;
    case "goal":
      if (typeof after === "string" && (before === null || before === undefined)) {
        return `${who} set the goal to ${shortQuote(after)}`;
      }
      if (after === null && typeof before === "string") return `${who} cleared the goal`;
      if (typeof before === "string" && typeof after === "string") {
        return `${who} changed the goal from ${shortQuote(before)} to ${shortQuote(after)}`;
      }
      break;
  }
  return `${who} changed its ${key}`;
}

const fieldOrder = ["state", "capCents", "everyMinutes", "goal", "tickets", "limit"];

/** The history to show: who made it (a goal, 4.4) and who changed what, oldest first. */
export function jobHistoryItems(detail: JobDetail): JobHistoryItem[] {
  return detail.history.map((event, index) => {
    const who = nameOf(event.actor);
    // A goal's first event: nothing before it, what it was made with after.
    if (Object.keys(event.before).length === 0 && Object.keys(event.after).length > 0) {
      const tickets = event.after.tickets;
      return {
        key: `${index}:${event.at}`,
        at: event.at,
        lines: [
          Array.isArray(tickets)
            ? `${who} made it, with the tickets ${tickets.join(", ")}`
            : `${who} made it`,
        ],
      };
    }
    const keys = [...new Set([...Object.keys(event.before), ...Object.keys(event.after)])].sort(
      (a, b) => {
        const rank = (key: string) => {
          const at = fieldOrder.indexOf(key);
          return at === -1 ? fieldOrder.length : at;
        };
        return rank(a) - rank(b) || a.localeCompare(b);
      },
    );
    const lines = keys.flatMap((key) => {
      const line = changeLine(who, key, event.before[key], event.after[key]);
      return line === undefined ? [] : [line];
    });
    return {
      key: `${index}:${event.at}`,
      at: event.at,
      lines: lines.length === 0 ? [`${who} edited it`] : lines,
    };
  });
}
