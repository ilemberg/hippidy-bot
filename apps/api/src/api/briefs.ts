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
  now?: () => Date;
}

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
  try {
    const people = (await briefPeople(deps.db, place)).filter((p) => !p.stopped);
    for (const person of people) {
      if (result.sent + result.failed >= BRIEFS_PER_RUN) break;
      let zone = person.timeZone;
      if (needsTimeZone(person, now) && deliverer.timeZone !== undefined) {
        if (zonesAsked >= TIME_ZONES_PER_RUN) continue;
        zonesAsked++;
        zone = await askTimeZone(deps.db, deliverer, place, person, log);
      }
      const local = localTime(now, zone);
      if (!isBriefTime(local)) continue;
      if (await briefExists(deps.db, place, person.actorId, local.date)) continue;
      const since = sinceFor(await lastBriefSent(deps.db, place, person.actorId), now);
      const brief = await buildBrief(deps.db, place, person.actorId, since, now, links);
      // Written before it is sent, so a retried run sends it once.
      const row = await claimBrief(
        deps.db,
        place,
        person.actorId,
        local.date,
        brief.sections.length === 0 ? null : briefText(brief),
      );
      if (row.status === "empty") {
        result.empty++;
        continue;
      }
      if (row.status !== "pending" || row.text === null) continue;
      try {
        await deliverer.direct(
          { workspaceId: place.workspaceId, userId: person.actorId, text: row.text },
          `brief:${row.id}`,
        );
        await markBriefSent(deps.db, row.id);
        result.sent++;
      } catch (error) {
        result.failed++;
        log.warn("brief.send_failed", { briefId: row.id, attempts: row.attempts + 1, error });
        await markBriefFailed(deps.db, row.id, String(error));
      }
    }
  } catch (error) {
    log.error("brief.run_failed", { error });
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

async function askTimeZone(
  db: Db,
  deliverer: Deliverer,
  place: Place,
  person: BriefPerson,
  log: Logger,
): Promise<string | null> {
  try {
    const zone =
      (await deliverer.timeZone?.({ workspaceId: place.workspaceId, userId: person.actorId })) ??
      null;
    await setTimeZone(db, place, person.actorId, zone);
    return zone ?? person.timeZone;
  } catch (error) {
    log.warn("brief.time_zone_failed", { actorId: person.actorId, error });
    // Asked again next week, not every minute.
    await setTimeZone(db, place, person.actorId, null);
    return person.timeZone;
  }
}

/** A person's brief as it would be now, for the web app's preview. */
export async function myBrief(
  db: Db,
  place: Place,
  actorId: string,
  webBaseUrl: string | undefined,
  now = new Date(),
): Promise<MyBrief> {
  const person = await briefPerson(db, place, actorId);
  const since = sinceFor(person.lastSentAt, now);
  return {
    on: !person.stopped,
    timeZone: person.timeZone,
    lastSentAt: person.lastSentAt?.toISOString() ?? null,
    brief: await buildBrief(db, place, actorId, since, now, linksFor(webBaseUrl)),
  };
}
