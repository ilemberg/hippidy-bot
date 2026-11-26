import type { Job, JobKind, JobWake } from "@hippidy/contracts";
import { z } from "zod";
import type { Place } from "./areas.ts";
import type { Db, Row } from "./db.ts";
import { storable } from "./json.ts";

// Standing jobs (slice 4.1, decision 215): what the bot is responsible for, each wake it makes
// with what it cost, and the scheduler's bookkeeping. A person changes a job (4.2); a job never
// changes itself (G16), except to cap itself at its monthly cap (G21).

/** The jobs every workspace has, made by reconcile if missing. */
export const BUILTIN_JOBS: readonly {
  name: string;
  kind: JobKind;
  goal: string;
  capCents: number;
}[] = [
  {
    name: "capture",
    kind: "capture",
    goal: "Read quiet threads in listened channels and propose the decisions made in them.",
    // Its $1 a day (decision 199), for a month.
    capCents: 3000,
  },
  {
    name: "briefs",
    kind: "briefs",
    goal: "Send each person one brief on weekday mornings when something is new.",
    capCents: 100,
  },
];

const columns = `j.id, j.name, j.kind, j.goal, j.owner_actor_id, j.owner_name, j.every_minutes,
  j.state, j.cap_cents, j.last_wake_at, j.version, j.created_at,
  coalesce((select sum(w.cost_micros) from job_wakes w
            where w.job_id = j.id
              and w.started_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'),
           0)::float8 as spent`;

const jobRow = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["capture", "briefs"]),
  goal: z.string().nullable(),
  owner_actor_id: z.string().nullable(),
  owner_name: z.string().nullable(),
  every_minutes: z.number().int(),
  state: z.enum(["active", "paused", "capped"]),
  cap_cents: z.number().int(),
  last_wake_at: z.date().nullable(),
  version: z.number().int(),
  created_at: z.date(),
  spent: z.number(),
});

function toJob(r: Row | undefined): Job {
  const d = jobRow.parse(r);
  return {
    id: d.id,
    name: d.name,
    kind: d.kind,
    goal: d.goal,
    owner: d.owner_actor_id === null ? null : { actorId: d.owner_actor_id, name: d.owner_name },
    everyMinutes: d.every_minutes,
    state: d.state,
    capCents: d.cap_cents,
    spentMicrosThisMonth: d.spent,
    lastWakeAt: d.last_wake_at?.toISOString() ?? null,
    version: d.version,
    createdAt: d.created_at.toISOString(),
  };
}

/** Makes the built-in jobs that are missing, owned by the fallback if there is one. */
export async function ensureBuiltinJobs(
  db: Db,
  place: Place,
  owner: { actorId: string } | undefined,
  caps: { capture?: number | undefined } = {},
): Promise<void> {
  for (const builtin of BUILTIN_JOBS) {
    // Capture's cap follows its daily budget for a 31-day month when the job is made.
    const job =
      builtin.kind === "capture" && caps.capture !== undefined
        ? { ...builtin, capCents: caps.capture }
        : builtin;
    await db.query(
      `insert into jobs (source, workspace_id, name, kind, goal, owner_actor_id, cap_cents)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (source, workspace_id, name) do nothing`,
      [
        place.source,
        place.workspaceId,
        job.name,
        job.kind,
        job.goal,
        owner?.actorId ?? null,
        job.capCents,
      ],
    );
  }
}

/** The workspace's jobs, by name, with this month's spend. */
export async function listJobs(db: Db, place: Place): Promise<Job[]> {
  const rows = await db.query(
    `select ${columns} from jobs j where j.source = $1 and j.workspace_id = $2 order by j.name`,
    [place.source, place.workspaceId],
  );
  return rows.map(toJob);
}

/** One job by name. */
export async function findJob(db: Db, place: Place, name: string): Promise<Job | undefined> {
  const rows = await db.query(
    `select ${columns} from jobs j
     where j.source = $1 and j.workspace_id = $2 and j.name = lower($3)`,
    [place.source, place.workspaceId, name.trim()],
  );
  return rows[0] === undefined ? undefined : toJob(rows[0]);
}

const wakeRow = z.object({
  started_at: z.date(),
  ended_at: z.date().nullable(),
  outcome: z.enum(["said", "silent", "failed", "skipped"]).nullable(),
  summary: z.string().nullable(),
  cost: z.number(),
  error: z.string().nullable(),
});

/** A job's latest wakes, newest first. */
export async function jobWakes(db: Db, jobId: string, limit = 50): Promise<JobWake[]> {
  const rows = await db.query(
    `select started_at, ended_at, outcome, summary, cost_micros::float8 as cost, error
     from job_wakes where job_id = $1 order by started_at desc limit $2`,
    [jobId, limit],
  );
  return rows.map((r) => {
    const d = wakeRow.parse(r);
    return {
      startedAt: d.started_at.toISOString(),
      endedAt: d.ended_at?.toISOString() ?? null,
      // A wake still running reads as silent until it ends.
      outcome: d.outcome ?? "silent",
      summary: d.summary,
      costMicros: d.cost,
      error: d.error,
    };
  });
}

/**
 * Wakes a capped job whose month has turned: its cap applies to a calendar month (G21).
 */
export async function uncapForNewMonth(db: Db, place: Place): Promise<void> {
  await db.query(
    `update jobs set state = 'active', capped_month = null, updated_at = now()
     where source = $1 and workspace_id = $2 and state = 'capped'
       and (capped_month is null
            or capped_month < date_trunc('month', now() at time zone 'utc')::date)`,
    [place.source, place.workspaceId],
  );
}

/**
 * Takes the active jobs that are due, each by one run only: its last wake is moved to now
 * atomically, so an overlapping run finds it not due. Answers the jobs taken.
 */
export async function takeDueJobs(db: Db, place: Place): Promise<Job[]> {
  const rows = await db.query(
    `update jobs j set last_wake_at = now()
     where j.source = $1 and j.workspace_id = $2 and j.state = 'active'
       and (j.last_wake_at is null
            or date_trunc('minute', j.last_wake_at)
               <= date_trunc('minute', now()) - make_interval(mins => j.every_minutes))
     returning j.id`,
    [place.source, place.workspaceId],
  );
  const ids = rows.map((r) => z.object({ id: z.string() }).parse(r).id);
  if (ids.length === 0) return [];
  const jobs = await db.query(
    `select ${columns} from jobs j where j.id = any($1::uuid[]) order by j.name`,
    [ids],
  );
  return jobs.map(toJob);
}

/** Starts a wake's row; answers its id. */
export async function startWake(db: Db, jobId: string): Promise<string> {
  const rows = await db.query(`insert into job_wakes (job_id) values ($1) returning id`, [jobId]);
  return z.object({ id: z.string() }).parse(rows[0]).id;
}

/** Ends a wake with its outcome, what it said or why not, and its cost. */
export async function finishWake(
  db: Db,
  wakeId: string,
  end: {
    outcome: "said" | "silent" | "failed" | "skipped";
    summary?: string | undefined;
    costMicros?: number | undefined;
    error?: string | undefined;
  },
): Promise<void> {
  await db.query(
    `update job_wakes
     set ended_at = now(), outcome = $2, summary = $3, cost_micros = $4, error = $5
     where id = $1`,
    [
      wakeId,
      end.outcome,
      end.summary === undefined ? null : storable(end.summary).slice(0, 500),
      Math.max(0, Math.round(end.costMicros ?? 0)),
      end.error === undefined ? null : storable(end.error).slice(0, 500),
    ],
  );
}

/** Caps a job that reached its cap, for this month (G21). */
export async function capJob(db: Db, jobId: string): Promise<void> {
  await db.query(
    `update jobs set state = 'capped',
       capped_month = date_trunc('month', now() at time zone 'utc')::date, updated_at = now()
     where id = $1 and state = 'active'`,
    [jobId],
  );
}

/**
 * Ends wakes left unfinished for ten minutes (their process was killed or timed out) as failed,
 * so they read as failures, not silence, and are kept.
 */
export async function closeUnfinishedWakes(db: Db): Promise<void> {
  await db.query(
    `update job_wakes
     set ended_at = now(), outcome = 'failed', error = 'did not finish'
     where outcome is null and started_at < now() - interval '10 minutes'`,
  );
}

/** Silent and skipped wakes are kept 14 days; the rest are kept. */
export async function pruneWakes(db: Db): Promise<number> {
  const rows = await db.query(
    `delete from job_wakes
     where outcome in ('silent', 'skipped') and started_at < now() - interval '14 days'
     returning 1`,
  );
  return rows.length;
}
