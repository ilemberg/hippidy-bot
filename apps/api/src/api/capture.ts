import type { DecisionExtractor, ExtractResult } from "../agent/extractor.ts";
import { costMicros, MAX_DECISIONS_PER_THREAD } from "../agent/extractor.ts";
import type { Logger } from "../log.ts";
import {
  captureSpentSince,
  claimDueThreads,
  failCapture,
  finishCapture,
  releaseThread,
  readObservedThread,
  threadDecisionStatements,
  threadWriters,
  type CapturedDecision,
  type CaptureRun,
  type ObservedLine,
} from "../store/capture.ts";
import type { Db } from "../store/db.ts";
import { storable } from "../store/json.ts";
import type { ObservedThread } from "../store/listening.ts";

// Capture (slice 2.5, decisions 198 to 200), run from reconcile after the conversations: it
// reads a few quiet threads once each and writes what it finds as proposals. It holds no sync
// lease and never fails reconcile. Deleting what listening keeps is reconcile's own first step.

/** Threads read per reconcile run. */
export const THREADS_PER_RUN = 3;
/** The most of a thread one call reads: its latest messages. */
export const MAX_MESSAGES = 200;
export const MAX_CHARACTERS = 60_000;
/** No new call starts after this long, so capture keeps reconcile short. */
export const CAPTURE_TIME_LIMIT_MS = 40_000;

const STATEMENT_MAX = 500;
const REASON_MAX = 2000;
const AREA_MAX = 100;

export interface CaptureDeps {
  db: Db;
  extractor: DecisionExtractor;
  dailyBudgetCents: number;
  now?: () => Date;
}

export interface CaptureResult {
  read: number;
  proposed: number;
  failed: number;
  /** Set when capture stopped for the day at its budget. */
  budgetReached: boolean;
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function clip(text: string, max: number): string {
  // What Postgres cannot store goes first, so a statement of nothing but null characters is
  // found empty here rather than failing the write.
  const flat = storable(text).trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Keeps only what the thread backs up: a decision whose message is in the thread and was
 * written by the person it says decided, not already on record, at most five. Statements are
 * clipped to the decision limits. Naming the message's own author means no one can put a
 * decision in someone else's name by writing "Ada decided X" (as 195 did for threads).
 */
export function checkDecisions(
  result: Extract<ExtractResult, { kind: "ok" }>,
  lines: readonly ObservedLine[],
  existing: readonly string[],
): CapturedDecision[] {
  const byMessage = new Map(lines.map((line) => [line.messageId, line]));
  const names = new Map(lines.map((line) => [line.actorId, line.actorName]));
  const seen = new Set(existing.map((s) => s.trim().toLowerCase()));
  const kept: CapturedDecision[] = [];
  for (const d of result.decisions) {
    const message = byMessage.get(d.messageId.trim());
    const decidedBy = d.decidedBy.trim();
    const statement = clip(d.statement, STATEMENT_MAX);
    if (message === undefined) continue;
    if (message.actorId !== decidedBy || statement.length === 0) continue;
    if (seen.has(statement.toLowerCase())) continue;
    seen.add(statement.toLowerCase());
    const reason = d.reason === null ? "" : clip(d.reason, REASON_MAX);
    const area = d.area === null ? "" : clip(d.area, AREA_MAX).toLowerCase();
    kept.push({
      statement,
      reason: reason.length === 0 ? null : reason,
      area: area.length === 0 ? null : area,
      decidedBy: { actorId: decidedBy, name: names.get(decidedBy) ?? null },
      messageId: message.messageId,
      decidedAt: message.sentAt,
    });
    if (kept.length === MAX_DECISIONS_PER_THREAD) break;
  }
  return kept;
}

async function captureThread(
  deps: CaptureDeps,
  thread: ObservedThread,
  log: Logger,
): Promise<{ outcome: CaptureRun["outcome"]; proposed: number; spentMicros: number }> {
  const startedAt = deps.now?.() ?? new Date();
  const { lines, truncated } = await readObservedThread(deps.db, thread, {
    maxMessages: MAX_MESSAGES,
    maxCharacters: MAX_CHARACTERS,
  });
  const base = {
    thread,
    model: deps.extractor.model,
    messagesRead: lines.length,
    truncated,
    startedAt,
    decisions: [] as CapturedDecision[],
    writers: [] as string[],
  };
  if (lines.length === 0) {
    // Every message was deleted in the source: nothing to read, and no call.
    await finishCapture(deps.db, {
      ...base,
      outcome: "nothing",
      inputTokens: null,
      outputTokens: null,
      costMicros: null,
      error: null,
    });
    return { outcome: "nothing", proposed: 0, spentMicros: 0 };
  }
  const existing = await threadDecisionStatements(deps.db, thread);
  const result = await deps.extractor.extract({ lines, existing, truncated });
  const usage = result.usage;
  const spent = usage === null ? 0 : costMicros(usage);
  const usageColumns = {
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    costMicros: usage === null ? null : spent,
  };
  if (result.kind !== "ok") {
    const error = result.kind === "failed" ? result.error : null;
    log.warn("capture.not_read", { outcome: result.kind, error });
    await finishCapture(deps.db, { ...base, ...usageColumns, outcome: result.kind, error });
    return { outcome: result.kind, proposed: 0, spentMicros: spent };
  }
  const decisions = checkDecisions(result, lines, existing);
  const dropped = result.decisions.length - decisions.length;
  if (dropped > 0) log.info("capture.decisions_dropped", { dropped });
  const { proposed } = await finishCapture(deps.db, {
    ...base,
    ...usageColumns,
    outcome: decisions.length > 0 ? "proposed" : "nothing",
    error: null,
    decisions,
    writers: await threadWriters(deps.db, thread),
  });
  return { outcome: decisions.length > 0 ? "proposed" : "nothing", proposed, spentMicros: spent };
}

/** Whether the day's budget is spent. */
function stopped(spent: number, budgetMicros: number): boolean {
  return spent >= budgetMicros;
}

/**
 * One capture pass: up to three quiet threads within the day's budget and the time limit. A
 * thread whose capture throws counts a failure and is let go.
 */
export async function runCapture(deps: CaptureDeps, log: Logger): Promise<CaptureResult> {
  const now = deps.now?.() ?? new Date();
  const result: CaptureResult = { read: 0, proposed: 0, failed: 0, budgetReached: false };
  const budgetMicros = deps.dailyBudgetCents * 10_000;
  let spent = await captureSpentSince(deps.db, startOfUtcDay(now));
  if (stopped(spent, budgetMicros)) {
    // Every reconcile while stopped: logged once an hour, not every minute.
    if (now.getUTCMinutes() === 0) log.info("capture.stopped_for_today", { spentMicros: spent });
    return { ...result, budgetReached: true };
  }
  const started = Date.now();
  const threads = await claimDueThreads(deps.db, now, THREADS_PER_RUN);
  for (const thread of threads) {
    const threadLog = log.child({ observedThreadId: thread.id });
    if (stopped(spent, budgetMicros) || Date.now() - started > CAPTURE_TIME_LIMIT_MS) {
      // Let the rest go at once, rather than holding them until their lease ends.
      result.budgetReached ||= stopped(spent, budgetMicros);
      await releaseThread(deps.db, thread);
      continue;
    }
    try {
      const done = await captureThread(deps, thread, threadLog);
      spent += done.spentMicros;
      if (done.outcome === "proposed" || done.outcome === "nothing") result.read++;
      else result.failed++;
      result.proposed += done.proposed;
      threadLog.info("capture.thread_done", { outcome: done.outcome, proposed: done.proposed });
    } catch (error) {
      result.failed++;
      threadLog.error("capture.thread_failed", { error });
      await failCapture(deps.db, thread).catch((failError: unknown) => {
        threadLog.error("capture.release_failed", { error: failError });
      });
    }
  }
  if (result.budgetReached)
    log.warn("capture.budget_reached", { spentMicros: spent, budgetMicros });
  return result;
}
