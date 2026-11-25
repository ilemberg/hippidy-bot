import type { DecisionExtractor, ExtractResult } from "../agent/extractor.ts";
import { costMicros, MAX_DECISIONS_PER_THREAD } from "../agent/extractor.ts";
import type { Logger } from "../log.ts";
import {
  captureSpentSince,
  claimDueThreads,
  finishCapture,
  readObservedThread,
  threadDecisionStatements,
  threadWriters,
  type CapturedDecision,
  type CaptureRun,
  type ObservedLine,
} from "../store/capture.ts";
import type { Db } from "../store/db.ts";
import { deleteExpiredObservations, type ObservedThread } from "../store/listening.ts";

// Capture (slice 2.5, decisions 198 and 199), run from reconcile after the conversations: it
// deletes what listening keeps past 30 days, then reads a few quiet threads once each and
// writes what it finds as proposals. It holds no sync lease and never fails reconcile.

/** Threads read per reconcile run. */
export const THREADS_PER_RUN = 3;
/** The most of a thread one call reads: its latest messages. */
export const MAX_MESSAGES = 200;
export const MAX_CHARACTERS = 60_000;

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
  expiredMessages: number;
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
  const flat = text.trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Keeps only what the thread backs up: a decision naming someone who wrote in it and a message
 * in it, not already on record, at most five. Statements are clipped to the decision limits.
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
    if (message === undefined || !names.has(decidedBy) || statement.length === 0) continue;
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

/** One capture pass: retention, then up to three quiet threads within the day's budget. */
export async function runCapture(deps: CaptureDeps, log: Logger): Promise<CaptureResult> {
  const now = deps.now?.() ?? new Date();
  const expired = await deleteExpiredObservations(deps.db, now);
  const result: CaptureResult = {
    expiredMessages: expired.messages,
    read: 0,
    proposed: 0,
    failed: 0,
    budgetReached: false,
  };
  const budgetMicros = deps.dailyBudgetCents * 10_000;
  let spent = await captureSpentSince(deps.db, startOfUtcDay(now));
  if (spent >= budgetMicros) {
    result.budgetReached = true;
    log.warn("capture.budget_reached", { spentMicros: spent, budgetMicros });
    return result;
  }
  const threads = await claimDueThreads(deps.db, now, THREADS_PER_RUN);
  for (const thread of threads) {
    const threadLog = log.child({ observedThreadId: thread.id });
    if (spent >= budgetMicros) {
      // Let the rest go at once, rather than holding them until their lease ends.
      result.budgetReached = true;
      await deps.db.query(`update observed_threads set capture_lease_until = null where id = $1`, [
        thread.id,
      ]);
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
    }
  }
  if (result.budgetReached)
    log.warn("capture.budget_reached", { spentMicros: spent, budgetMicros });
  return result;
}
