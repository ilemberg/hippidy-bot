import {
  scorecardCountKindSchema,
  type Scorecard,
  type ScorecardCount,
  type ScorecardCountKind,
} from "@hippidy/contracts";
import { z } from "zod";
import type { Place } from "./areas.ts";
import type { Db } from "./db.ts";

// The team's scorecard (slice 4.5, decision 223): this week's and last week's counts, each from
// a record with a time, only the workspace's own. One query per count, each read by an index on
// its time; nothing here calls Slack, GitHub or the tracker.

const DAY_MS = 24 * 60 * 60 * 1000;

/** The weeks a scorecard compares: Monday to Sunday in UTC. This week runs up to `now`. */
export interface ScorecardWeeks {
  lastWeekStart: Date;
  thisWeekStart: Date;
  now: Date;
}

/** The weeks for `now`: this week from its Monday 00:00 UTC, last week the seven days before. */
export function scorecardWeeks(now: Date): ScorecardWeeks {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  // getUTCDay: Sunday is 0, Monday 1.
  const sinceMonday = (now.getUTCDay() + 6) % 7;
  const thisWeekStart = new Date(midnight - sinceMonday * DAY_MS);
  return { lastWeekStart: new Date(thisWeekStart.getTime() - 7 * DAY_MS), thisWeekStart, now };
}

/**
 * Each count's records, as a `select` of one column `t`, the time that puts a record in a week.
 * `$1` and `$2` are the place's source and workspace; `$3` is the start of last week and `$4`
 * the end of this week (now), which the time is already limited to, so the index is used.
 */
const COUNTS: Record<ScorecardCountKind, string> = {
  // A decision made active in the week: recorded active, or a proposal confirmed (its
  // `confirmed_at`), whether or not it has been superseded since. An import from the decision
  // log belongs to no workspace: it is the team's, as on the decisions page, so it counts for
  // every workspace.
  decisions_made: `
    select coalesce(d.confirmed_at, d.decided_at) as t
    from decisions d left join conversations v on v.id = d.conversation_id
    where d.status in ('active', 'superseded')
      and coalesce(d.confirmed_at, d.decided_at) >= $3::timestamptz
      and coalesce(d.confirmed_at, d.decided_at) <= $4::timestamptz
      and (d.origin = 'import'
           or (coalesce(v.source, d.decided_by_source) = $1
               and coalesce(v.workspace_id, d.decided_by_workspace_id) = $2))`,
  conflicts_settled: `
    select settled_at as t from conflicts
    where source = $1 and workspace_id = $2
      and settled_at >= $3::timestamptz and settled_at <= $4::timestamptz`,
  waits_ended: `
    select ended_at as t from waits
    where source = $1 and workspace_id = $2
      and ended_at >= $3::timestamptz and ended_at <= $4::timestamptz`,
  // Changes started in the workspace's threads, each once: when its first brief was started,
  // by a person or the start rule. A later brief of the same change (more work on it) is not
  // another change, so a brief with an earlier started one in its change is left out.
  changes_started: `
    select b.started_at as t
    from change_briefs b
    join changes c on c.id = b.change_id
    join conversations v on v.id = c.conversation_id
    where v.source = $1 and v.workspace_id = $2
      and b.started_at >= $3::timestamptz and b.started_at <= $4::timestamptz
      and not exists (select 1 from change_briefs e
                      where e.change_id = b.change_id and e.started_at is not null
                        and (e.started_at < b.started_at
                             or (e.started_at = b.started_at and e.seq < b.seq)))`,
  // Reviews the checker posted. A review is of the deployment's repository, not of a thread, so
  // it belongs to the workspace whose checker job posts it: counted only for a workspace that
  // has one. A posted review is never touched again (`reviews.ts`), so `updated_at` is when it
  // was posted.
  pull_requests_reviewed: `
    select r.updated_at as t from pull_request_reviews r
    where r.status = 'posted'
      and r.updated_at >= $3::timestamptz and r.updated_at <= $4::timestamptz
      and exists (select 1 from jobs j
                  where j.source = $1 and j.workspace_id = $2 and j.kind = 'checker')`,
  // A goal's tickets settled as merged; a goal is a job of the workspace's.
  tickets_merged: `
    select t.settled_at as t
    from goal_tickets t join jobs j on j.id = t.job_id
    where j.source = $1 and j.workspace_id = $2 and t.state = 'merged'
      and t.settled_at >= $3::timestamptz and t.settled_at <= $4::timestamptz`,
};

const countRow = z.object({ this_week: z.number().int(), last_week: z.number().int() });

/** One count, this week and last, for the place. */
async function countWeeks(
  db: Db,
  kind: ScorecardCountKind,
  place: Place,
  weeks: ScorecardWeeks,
): Promise<ScorecardCount> {
  // `count` is a bigint, which postgres.js reads as a string: cast to int.
  const rows = await db.query(
    `select count(*) filter (where x.t >= $5::timestamptz)::int as this_week,
            count(*) filter (where x.t < $5::timestamptz)::int as last_week
     from (${COUNTS[kind]}) x`,
    [
      place.source,
      place.workspaceId,
      weeks.lastWeekStart.toISOString(),
      weeks.now.toISOString(),
      weeks.thisWeekStart.toISOString(),
    ],
  );
  const r = countRow.parse(rows[0]);
  return { kind, thisWeek: r.this_week, lastWeek: r.last_week };
}

/** The workspace's scorecard for the week of `now` against the week before. */
export async function readScorecard(db: Db, place: Place, now: Date): Promise<Scorecard> {
  const weeks = scorecardWeeks(now);
  const counts: ScorecardCount[] = [];
  for (const kind of scorecardCountKindSchema.options)
    counts.push(await countWeeks(db, kind, place, weeks));
  return {
    lastWeekStart: weeks.lastWeekStart.toISOString(),
    thisWeekStart: weeks.thisWeekStart.toISOString(),
    readAt: now.toISOString(),
    counts,
  };
}
