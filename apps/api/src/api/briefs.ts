import type { Deliverer, MyBrief } from "@hippidy/contracts";
import type { Logger } from "../log.ts";
import type { Place } from "../store/areas.ts";
import {
  briefExists,
  briefPeople,
  briefPerson,
  briefText,
  buildBrief,
  claimBrief,
  lastBriefSent,
  linksFor,
  LOOKBACK_MS,
  markBriefFailed,
  markBriefSent,
  setTimeZone,
  takeBrief,
  type BriefPerson,
} from "../store/briefs.ts";
import type { Db } from "../store/db.ts";

// Daily briefs by direct message (slice 3.4, decision 212), sent from reconcile: outside any
// sync lease, a few per run, once per person and local day, and never when there is nothing new.

/** The most briefs one reconcile run sends, so it stays short. */
export const BRIEFS_PER_RUN = 10;
/** The most time zones one run asks the source for. */
export const TIME_ZONES_PER_RUN = 20;
/** A time zone is asked again after a week. */
const TIME_ZONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Sent from this hour, local time, until noon; a brief missed by noon waits for tomorrow. */
export const BRIEF_HOUR = 9;
export const BRIEF_LAST_HOUR = 12;

export interface BriefDeps {
  db: Db;
  deliverer: Deliverer | undefined;
  place: Place | undefined;
  webBaseUrl: string | undefined;
  /** Decides conflicts recorded with nobody to decide them (209), so they are in its brief. */
  fallback?: { actorId: string } | undefined;
  now?: () => Date;
  /** Wall-clock time, for the run's time budget; replaced in tests. */
  clock?: () => number;
}

/** A run stops starting sends after this long, so reconcile stays short. */
export const BRIEF_RUN_BUDGET_MS = 20_000;

/** The date, hour and weekday in a time zone; UTC when it is unknown or not one. */
export function localTime(
  now: Date,
  timeZone: string | null,
): { date: string; hour: number; weekday: number } {
  const zone = (() => {
    if (timeZone === null) return "UTC";
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
      return timeZone;
    } catch {
      return "UTC";
    }
  })();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    date: `${String(parts.year)}-${String(parts.month)}-${String(parts.day)}`,
    hour: Number(parts.hour),
    weekday: weekdays.indexOf(String(parts.weekday)),
  };
}

/** Whether it is brief time for a person now: a weekday, from 9:00 until noon their time. */
export function isBriefTime(local: { hour: number; weekday: number }): boolean {
  return (
    local.weekday >= 1 &&
    local.weekday <= 5 &&
    local.hour >= BRIEF_HOUR &&
    local.hour < BRIEF_LAST_HOUR
  );
}

/** Since when a brief looks: its last one, at most three days back. */
function sinceFor(last: Date | null, now: Date): Date {
  const floor = new Date(now.getTime() - LOOKBACK_MS);
  return last === null || last < floor ? floor : last;
}

export interface BriefRunResult {
  sent: number;
  empty: number;
  failed: number;
  /** The run itself failed (a database error), not one send: its wake is a failure (4.1). */
  runFailed?: boolean;
}

/** One pass: sends the briefs due now. Never throws: a failure is logged and tried again. */
export async function runBriefs(deps: BriefDeps, log: Logger): Promise<BriefRunResult> {
  const result: BriefRunResult = { sent: 0, empty: 0, failed: 0 };
  const deliverer = deps.deliverer;
  const place = deps.place;
  if (deliverer?.direct === undefined || place === undefined) return result;
  const now = deps.now?.() ?? new Date();
  const links = linksFor(deps.webBaseUrl);
  let zonesAsked = 0;
  const clock = deps.clock ?? Date.now;
  const started = clock();
  try {
    const people = (await briefPeople(deps.db, place)).filter((p) => !p.stopped);
    for (const person of people) {
      if (result.sent + result.failed >= BRIEFS_PER_RUN) break;
      if (clock() - started > BRIEF_RUN_BUDGET_MS) break;
      let zone = person.timeZone;
      if (needsTimeZone(person, now) && deliverer.timeZone !== undefined) {
        if (zonesAsked >= TIME_ZONES_PER_RUN) continue;
        zonesAsked++;
        const asked = await askTimeZone(deps.db, deliverer, place, person, log);
        // Never read and not readable now: not sent on a guessed clock (from the review).
        if (asked.kind === "failed" && person.timeZoneCheckedAt === null) continue;
        zone = asked.kind === "read" ? (asked.zone ?? person.timeZone) : person.timeZone;
      }
      const local = localTime(now, zone);
      if (!isBriefTime(local)) continue;
      if (await briefExists(deps.db, place, person.actorId, local.date)) continue;
      const since = sinceFor(await lastBriefSent(deps.db, place, person.actorId), now);
      const built = await buildBrief(
        deps.db,
        place,
        person.actorId,
        since,
        now,
        links,
        deps.fallback,
      );
      const row = await claimBrief(
        deps.db,
        place,
        person.actorId,
        local.date,
        built.fresh ? briefText(built.brief, deps.webBaseUrl) : null,
      );
      if (row.status === "empty") {
        result.empty++;
        continue;
      }
      // Only one run gets to send it, and only while the person still wants briefs.
      const text = await takeBrief(deps.db, row.id);
      if (text === undefined) continue;
      try {
        await deliverer.direct(
          { workspaceId: place.workspaceId, userId: person.actorId, text },
          `brief:${row.id}`,
        );
      } catch (error) {
        result.failed++;
        log.warn("brief.send_failed", { briefId: row.id, attempts: row.attempts + 1, error });
        await markBriefFailed(deps.db, row.id, String(error));
        continue;
      }
      // Sent: marked so, and never sent again, even if marking it fails (it stays `sending`
      // until it is stale, and is then tried again: a duplicate only if the database fails).
      await markBriefSent(deps.db, row.id);
      result.sent++;
    }
  } catch (error) {
    log.error("brief.run_failed", { error });
    result.runFailed = true;
  }
  if (result.sent + result.failed > 0) log.info("brief.run", { ...result });
  return result;
}

function needsTimeZone(person: BriefPerson, now: Date): boolean {
  return (
    person.timeZoneCheckedAt === null ||
    now.getTime() - person.timeZoneCheckedAt.getTime() > TIME_ZONE_TTL_MS
  );
}

/**
 * Asks the source for a person's time zone. A failure is not kept: it is asked again on a
 * later run, rather than the person getting briefs on UTC for a week (from the review).
 */
async function askTimeZone(
  db: Db,
  deliverer: Deliverer,
  place: Place,
  person: BriefPerson,
  log: Logger,
): Promise<{ kind: "read"; zone: string | null } | { kind: "failed" }> {
  try {
    const zone =
      (await deliverer.timeZone?.({ workspaceId: place.workspaceId, userId: person.actorId })) ??
      null;
    await setTimeZone(db, place, person.actorId, zone);
    return { kind: "read", zone };
  } catch (error) {
    log.warn("brief.time_zone_failed", { actorId: person.actorId, error });
    return { kind: "failed" };
  }
}

/** A person's brief as it would be now, for the web app's preview. */
export async function myBrief(
  db: Db,
  place: Place,
  actorId: string,
  webBaseUrl: string | undefined,
  now = new Date(),
  fallback?: { actorId: string },
): Promise<MyBrief> {
  const person = await briefPerson(db, place, actorId);
  const since = sinceFor(person.lastSentAt, now);
  return {
    on: !person.stopped,
    timeZone: person.timeZone,
    lastSentAt: person.lastSentAt?.toISOString() ?? null,
    brief: (await buildBrief(db, place, actorId, since, now, linksFor(webBaseUrl), fallback)).brief,
  };
}
