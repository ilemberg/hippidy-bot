import type { Job, JobKind } from "@hippidy/contracts";
import type { Logger } from "../log.ts";
import type { Place } from "../store/areas.ts";
import { captureSpentSince } from "../store/capture.ts";
import type { Db } from "../store/db.ts";
import {
  capJob,
  ensureBuiltinJobs,
  finishWake,
  pruneWakes,
  startWake,
  takeDueJobs,
  uncapForNewMonth,
} from "../store/jobs.ts";
import { runBriefs, type BriefDeps } from "./briefs.ts";
import { runCapture, type CaptureDeps } from "./capture.ts";

// The scheduler (slice 4.1, decision 215), run from reconcile: makes the built-in jobs, takes
// each due job once, checks its monthly cap, runs it and logs the wake, silent ones included
// (rules 14 to 17 of `wave-4.md`). A job that throws never fails reconcile.

/** What one wake did. */
export interface WakeResult {
  outcome: "said" | "silent";
  summary: string;
  costMicros: number;
}

/** What each kind needs; a kind whose needs are missing wakes silent, saying so. */
export interface JobDeps {
  db: Db;
  place: Place | undefined;
  fallback?: { actorId: string } | undefined;
  capture?: CaptureDeps | undefined;
  briefs?: Omit<BriefDeps, "db" | "place"> | undefined;
  now?: () => Date;
}

type Runner = (deps: JobDeps, place: Place, log: Logger) => Promise<WakeResult>;

const RUNNERS: Record<JobKind, Runner> = {
  async capture(deps, _place, log) {
    if (deps.capture === undefined) {
      return { outcome: "silent", summary: "the agent is not configured", costMicros: 0 };
    }
    const started = deps.now?.() ?? new Date();
    const result = await runCapture(deps.capture, log);
    const cost = await captureSpentSince(deps.db, started);
    if (result.budgetReached && result.read === 0) {
      return { outcome: "silent", summary: "the day's capture budget is spent", costMicros: cost };
    }
    if (result.proposed > 0) {
      return {
        outcome: "said",
        summary: `${String(result.proposed)} proposal${result.proposed === 1 ? "" : "s"} from ${String(result.read)} thread${result.read === 1 ? "" : "s"}`,
        costMicros: cost,
      };
    }
    return {
      outcome: "silent",
      summary:
        result.read > 0
          ? `read ${String(result.read)} thread${result.read === 1 ? "" : "s"}; no decisions`
          : result.failed > 0
            ? `${String(result.failed)} thread${result.failed === 1 ? "" : "s"} could not be read`
            : "no quiet thread was due",
      costMicros: cost,
    };
  },
  async briefs(deps, place, log) {
    if (deps.briefs === undefined) {
      return { outcome: "silent", summary: "Slack is not configured", costMicros: 0 };
    }
    const result = await runBriefs({ ...deps.briefs, db: deps.db, place }, log);
    if (result.sent > 0) {
      return {
        outcome: "said",
        summary: `sent ${String(result.sent)} brief${result.sent === 1 ? "" : "s"}`,
        costMicros: 0,
      };
    }
    return {
      outcome: "silent",
      summary:
        result.failed > 0
          ? `${String(result.failed)} brief${result.failed === 1 ? "" : "s"} could not be sent`
          : result.empty > 0
            ? `nothing new for ${String(result.empty)} ${result.empty === 1 ? "person" : "people"}`
            : "nobody's brief was due",
      costMicros: 0,
    };
  },
};

export interface JobsRunResult {
  woke: number;
  said: number;
  failed: number;
  skipped: number;
}

/** One pass of the scheduler. Never throws. */
export async function runJobs(deps: JobDeps, log: Logger): Promise<JobsRunResult> {
  const result: JobsRunResult = { woke: 0, said: 0, failed: 0, skipped: 0 };
  const place = deps.place;
  if (place === undefined) return result;
  let due: Job[];
  try {
    await ensureBuiltinJobs(deps.db, place, deps.fallback);
    await uncapForNewMonth(deps.db, place);
    due = await takeDueJobs(deps.db, place);
  } catch (error) {
    log.error("jobs.schedule_failed", { error });
    return result;
  }
  for (const job of due) {
    const jobLog = log.child({ job: job.name });
    let wakeId: string | undefined;
    try {
      wakeId = await startWake(deps.db, job.id);
      result.woke++;
      // At its cap it pauses itself, and one wake says so (G21).
      if (job.spentMicrosThisMonth >= job.capCents * 10_000) {
        await capJob(deps.db, job.id);
        await finishWake(deps.db, wakeId, {
          outcome: "skipped",
          summary: `reached its cap of $${(job.capCents / 100).toFixed(2)} this month; paused until next month`,
        });
        result.skipped++;
        jobLog.warn("job.capped", { capCents: job.capCents });
        continue;
      }
      const wake = await RUNNERS[job.kind](deps, place, jobLog);
      await finishWake(deps.db, wakeId, wake);
      if (wake.outcome === "said") result.said++;
    } catch (error) {
      result.failed++;
      jobLog.error("job.wake_failed", { error });
      if (wakeId !== undefined) {
        await finishWake(deps.db, wakeId, { outcome: "failed", error: String(error) }).catch(
          (finishError: unknown) => {
            jobLog.error("job.finish_failed", { error: finishError });
          },
        );
      }
    }
  }
  try {
    await pruneWakes(deps.db);
  } catch (error) {
    log.warn("jobs.prune_failed", { error });
  }
  return result;
}
