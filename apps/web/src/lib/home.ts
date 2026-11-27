import { randomUUID } from "node:crypto";
import type {
  JobList,
  MyBrief,
  Scorecard,
  ScorecardCountKind,
  SessionActivity,
} from "@hippidy/contracts";
import {
  fetchJobs,
  fetchMyBrief,
  fetchScorecard,
  fetchSessions,
  type ApiClientDeps,
  type ApiResult,
} from "./api-client.ts";
import { signInNotices, type SignInNotice } from "./auth-flow.ts";
import type { WebConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import type { Fetch } from "./slack-oidc.ts";
import { readSession, type Person } from "./tokens.ts";

/** How many sessions the page shows: the Dashboard v1 plan's ten. */
export const SESSIONS_SHOWN = 10;

/**
 * What the home page shows (slice 4.5, decision 223): the person's brief, the jobs, the team's
 * scorecard and the agents at work. Each part is read on its own, so one the API does not
 * answer says so and the others still show.
 */
export type HomeView =
  | { kind: "unconfigured" }
  | { kind: "signed_out"; notice: SignInNotice | undefined }
  | {
      kind: "signed_in";
      person: Person;
      /** Their brief as it would be now (slice 3.4), or why the API gave none. */
      brief: ApiResult<MyBrief>;
      /** The standing jobs with this month's spend (slice 4.1). */
      jobs: ApiResult<JobList>;
      /** The team's counts, this week against last. */
      scorecard: ApiResult<Scorecard>;
      /** The latest agents at work (slice 2.4). */
      sessions: ApiResult<SessionActivity[]>;
      /** This app's address, to tell its own pages from Slack's among the brief's links. */
      webBaseUrl: string;
      /** When the page was read, for "as of". */
      readAt: string;
    };

export interface HomeDeps {
  config: WebConfig | undefined;
  fetch: Fetch;
  log: Logger;
  now?: () => Date;
}

/** The person the session cookie names, if it is valid for this workspace and still fresh. */
export function signedInPerson(
  sessionCookie: string | undefined,
  config: WebConfig,
  now: Date,
): Promise<Person | undefined> {
  return readSession(sessionCookie, {
    secret: config.sessionSecret,
    workspaceId: config.slack.workspaceId,
    now,
  });
}

const isNotice = (value: string | undefined): value is SignInNotice =>
  signInNotices.some((notice) => notice === value);

/** A part's call, which answers why it failed rather than throwing, whatever happens in it. */
async function part<T>(read: () => Promise<ApiResult<T>>, log: Logger): Promise<ApiResult<T>> {
  try {
    return await read();
  } catch (error) {
    log.error("home.part_failed", { error });
    return { kind: "failed", reason: "unreachable" };
  }
}

/**
 * Reads the session cookie and, for a signed-in person, asks the API for each part of the page
 * at once, each on its own.
 */
export async function loadHome(
  input: { sessionCookie: string | undefined; signin: string | undefined },
  deps: HomeDeps,
): Promise<HomeView> {
  const config = deps.config;
  if (config === undefined) return { kind: "unconfigured" };
  const now = deps.now?.() ?? new Date();
  const person = await signedInPerson(input.sessionCookie, config, now);
  if (person === undefined) {
    return { kind: "signed_out", notice: isNotice(input.signin) ? input.signin : undefined };
  }
  const correlationId = randomUUID();
  const log = deps.log.child({ correlationId, actorId: person.actorId });
  const client: ApiClientDeps = {
    fetch: deps.fetch,
    apiBaseUrl: config.apiBaseUrl,
    apiSecret: config.apiSecret,
    log,
    correlationId,
    now: () => now,
  };
  const [brief, jobs, scorecard, sessions] = await Promise.all([
    part(() => fetchMyBrief(person, client), log),
    part(() => fetchJobs(person, client), log),
    part(() => fetchScorecard(person, client), log),
    part(() => fetchSessions(person, SESSIONS_SHOWN, client), log),
  ]);
  return {
    kind: "signed_in",
    person,
    brief,
    jobs,
    scorecard,
    sessions,
    webBaseUrl: config.webBaseUrl,
    readAt: now.toISOString(),
  };
}

// How the page words the scorecard, kept here so it is tested without Next.js.

/** What each count is called on the page. */
export const scorecardLabel: Record<ScorecardCountKind, string> = {
  decisions_made: "Decisions made",
  conflicts_settled: "Conflicts settled",
  waits_ended: "Waits ended",
  changes_started: "Changes started",
  pull_requests_reviewed: "Pull requests reviewed by the checker",
  tickets_merged: "Goal tickets merged",
};

/** The page each count comes from, where there is one. */
export const scorecardHref: Record<ScorecardCountKind, string | undefined> = {
  decisions_made: "/decisions",
  conflicts_settled: "/conflicts",
  waits_ended: "/waits",
  changes_started: undefined,
  pull_requests_reviewed: "/jobs/checker",
  tickets_merged: "/jobs",
};

/** This week against last: "+2", "−1", or "same". */
export function differenceText(thisWeek: number, lastWeek: number): string {
  const difference = thisWeek - lastWeek;
  if (difference === 0) return "same";
  return difference > 0 ? `+${difference}` : `−${-difference}`;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "Monday 23 November" for a week's first day, in UTC, whatever the server's locale. */
function dayText(iso: string): string {
  const day = new Date(iso);
  return `${DAYS[day.getUTCDay()] ?? ""} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()] ?? ""}`;
}

/** What the weeks are, said under the scorecard's heading. */
export function weeksText(scorecard: Scorecard): string {
  return `This week is from ${dayText(scorecard.thisWeekStart)}, 00:00 UTC, to now; last week is the seven days from ${dayText(scorecard.lastWeekStart)}. Weeks run Monday to Sunday in UTC.`;
}
