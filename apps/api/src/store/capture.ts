import { messageSourceSchema } from "@hippidy/contracts";
import { z } from "zod";
import type { Db } from "./db.ts";
import { recordConflict } from "./conflicts.ts";
import { storable } from "./json.ts";
import type { ObservedThread } from "./listening.ts";

// Capture (slice 2.5, decision 199): threads of listened channels gone quiet are read once by a
// small model, and what it finds is written as proposals. Nothing here holds a conversation's
// sync lease, and no transaction is held across the model call.

/** How long a thread must be quiet before it is read. */
export const QUIET_MINUTES = 30;
/** How long a claimed thread is held for one capture. */
export const CAPTURE_LEASE_MINUTES = 5;
/** Failed captures in a row after which a thread waits for a new message. */
export const MAX_CAPTURE_FAILURES = 3;

const threadRow = z.object({
  id: z.string(),
  source: messageSourceSchema,
  workspace_id: z.string(),
  channel_id: z.string(),
  thread_id: z.string(),
  last_message_at: z.date(),
});

/**
 * Claims up to `limit` threads due for capture: in a listened channel, with two or more
 * messages, quiet for 30 minutes, with messages newer than the last capture, not given up,
 * not held by another capture, and not a conversation (the teammate records decisions in a
 * thread the bot was mentioned in).
 */
export async function claimDueThreads(db: Db, now: Date, limit: number): Promise<ObservedThread[]> {
  const rows = await db.query(
    `update observed_threads t
     set capture_lease_until = $2::timestamptz + make_interval(mins => $4::int), updated_at = now()
     where t.id in (
       select o.id from observed_threads o
       join listening_channels l
         on l.source = o.source and l.workspace_id = o.workspace_id
        and l.channel_id = o.channel_id and l.listening
       where (o.captured_through is null or o.captured_through < o.last_message_at)
         and o.last_message_at <= $2::timestamptz - make_interval(mins => $3::int)
         and (o.capture_lease_until is null or o.capture_lease_until < $2::timestamptz)
         and o.capture_failures < $5::int
         and o.message_count >= 2
         and not exists (
           select 1 from conversations c
           where c.source = o.source and c.workspace_id = o.workspace_id
             and c.channel_id = o.channel_id and c.thread_id = o.thread_id
         )
       order by o.last_message_at
       limit $1::int
       for update of o skip locked
     )
     returning t.id, t.source, t.workspace_id, t.channel_id, t.thread_id, t.last_message_at`,
    [limit, now.toISOString(), QUIET_MINUTES, CAPTURE_LEASE_MINUTES, MAX_CAPTURE_FAILURES],
  );
  return rows.map((r) => {
    const d = threadRow.parse(r);
    return {
      id: d.id,
      source: d.source,
      workspaceId: d.workspace_id,
      channelId: d.channel_id,
      threadId: d.thread_id,
      lastMessageAt: d.last_message_at.toISOString(),
    };
  });
}

/** One kept message of a thread, as capture reads it. */
export interface ObservedLine {
  messageId: string;
  actorId: string;
  actorName: string | null;
  text: string;
  sentAt: string;
}

const lineRow = z.object({
  message_id: z.string(),
  actor_id: z.string(),
  actor_name: z.string().nullable(),
  text: z.string(),
  sent_at: z.date(),
});

/**
 * The thread's messages, oldest first: the latest `maxMessages` that fit in `maxCharacters`.
 * `truncated` says older ones were left out.
 */
export async function readObservedThread(
  db: Db,
  thread: ObservedThread,
  limits: { maxMessages: number; maxCharacters: number },
): Promise<{ lines: ObservedLine[]; truncated: boolean }> {
  const rows = await db.query(
    `select message_id, actor_id, actor_name, text, sent_at from observed_messages
     where source = $1 and workspace_id = $2 and channel_id = $3 and thread_id = $4
     order by sent_at desc, message_id desc
     limit $5::int`,
    [thread.source, thread.workspaceId, thread.channelId, thread.threadId, limits.maxMessages + 1],
  );
  const lines: ObservedLine[] = [];
  let characters = 0;
  let truncated = rows.length > limits.maxMessages;
  for (const r of rows.slice(0, limits.maxMessages)) {
    const d = lineRow.parse(r);
    if (characters + d.text.length > limits.maxCharacters && lines.length > 0) {
      truncated = true;
      break;
    }
    characters += d.text.length;
    lines.push({
      messageId: d.message_id,
      actorId: d.actor_id,
      actorName: d.actor_name,
      text: d.text,
      sentAt: d.sent_at.toISOString(),
    });
  }
  return { lines: lines.reverse(), truncated };
}

/** The statements of decisions already proposed or recorded from this thread. */
export async function threadDecisionStatements(db: Db, thread: ObservedThread): Promise<string[]> {
  const rows = await db.query(
    `select statement from decisions
     where origin = 'capture' and decided_by_source = $1 and decided_by_workspace_id = $2
       and channel_id = $3 and thread_id = $4
     order by number`,
    [thread.source, thread.workspaceId, thread.channelId, thread.threadId],
  );
  return rows.map((r) => z.object({ statement: z.string() }).parse(r).statement);
}

/** What capture's calls have cost since `since`, in millionths of a dollar. */
export async function captureSpentSince(db: Db, since: Date): Promise<number> {
  const rows = await db.query(
    `select coalesce(sum(cost_micros), 0)::float8 as spent from capture_runs
     where finished_at >= $1`,
    [since.toISOString()],
  );
  return z.object({ spent: z.number() }).parse(rows[0]).spent;
}

/** A decision capture proposes, checked against the thread. */
export interface CapturedDecision {
  statement: string;
  reason: string | null;
  area: string | null;
  decidedBy: { actorId: string; name: string | null };
  messageId: string;
  decidedAt: string;
  /**
   * The active decision it replaces (slice 3.2, decision 208), its area, and who alone decides
   * the replacement.
   */
  replaces?: { id: string; area: string | null; deciders: string[] } | undefined;
}

export interface CaptureRun {
  thread: ObservedThread;
  model: string;
  outcome: "proposed" | "nothing" | "refused" | "cut_off" | "failed";
  messagesRead: number;
  truncated: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  error: string | null;
  startedAt: Date;
  /** For a capture that read the thread: its proposals, and who wrote in the thread. */
  decisions: CapturedDecision[];
  writers: string[];
}

/**
 * Records one capture's call and its cost, on its own, before anything else is written: a
 * failure after the call must not take the cost out of the day's budget.
 */
async function recordRun(db: Db, run: CaptureRun): Promise<string> {
  const inserted = await db.query(
    `insert into capture_runs (observed_thread_id, source, workspace_id, channel_id,
       thread_id, model, outcome, messages_read, truncated, input_tokens, output_tokens,
       cost_micros, error, started_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     returning id`,
    [
      run.thread.id,
      run.thread.source,
      run.thread.workspaceId,
      run.thread.channelId,
      run.thread.threadId,
      run.model,
      run.outcome,
      run.messagesRead,
      run.truncated,
      run.inputTokens,
      run.outputTokens,
      run.costMicros === null ? null : Math.round(run.costMicros),
      run.error === null ? null : storable(run.error).slice(0, 2000),
      run.startedAt.toISOString(),
    ],
  );
  return z.object({ id: z.string() }).parse(inserted[0]).id;
}

/** Counts a failed capture and lets the thread go: it is read again on a later reconcile. */
export async function failCapture(db: Db, thread: ObservedThread): Promise<void> {
  await db.query(
    `update observed_threads
     set capture_failures = capture_failures + 1, capture_lease_until = null, updated_at = now()
     where id = $1`,
    [thread.id],
  );
}

/** Lets a claimed thread go without reading it, so the next reconcile may. */
export async function releaseThread(db: Db, thread: ObservedThread): Promise<void> {
  await db.query(`update observed_threads set capture_lease_until = null where id = $1`, [
    thread.id,
  ]);
}

/**
 * Records one capture: first its run and cost, then, together, its proposals (a statement
 * already proposed from the thread is skipped) and where the thread is now. A read thread is
 * done up to the message it was claimed at; a refused or failed one counts a failure. Either
 * way the thread is let go.
 */
export async function finishCapture(db: Db, run: CaptureRun): Promise<{ proposed: number }> {
  const runId = await recordRun(db, run);
  const read = run.outcome === "proposed" || run.outcome === "nothing";
  if (!read) {
    await failCapture(db, run.thread);
    return { proposed: 0 };
  }
  return db.transaction(async (tx) => {
    let proposed = 0;
    for (const decision of run.decisions) {
      const rows = await tx.query(
        `insert into decisions (statement, reason, area, status, decided_by_source,
           decided_by_workspace_id, decided_by_actor_id, decided_by_name, decided_at, origin,
           message_id, channel_id, thread_id, capture_run_id, confirmable_by, supersedes_id,
           deciders)
         values ($1, $2, $3, 'proposed', $4, $5, $6, $7, $8, 'capture', $9, $10, $11, $12,
                 $13::text[], $14, $15::text[])
         on conflict do nothing
         returning id`,
        [
          storable(decision.statement),
          decision.reason === null ? null : storable(decision.reason),
          decision.area === null ? null : storable(decision.area),
          run.thread.source,
          run.thread.workspaceId,
          decision.decidedBy.actorId,
          decision.decidedBy.name,
          decision.decidedAt,
          decision.messageId,
          run.thread.channelId,
          run.thread.threadId,
          runId,
          run.writers,
          decision.replaces?.id ?? null,
          decision.replaces?.deciders ?? null,
        ],
      );
      proposed += rows.length;
      const inserted = rows[0];
      if (inserted !== undefined && decision.replaces !== undefined) {
        // Nothing is posted in a listened thread (176): the conflict is listed for its deciders.
        await recordConflict(tx, {
          place: { source: run.thread.source, workspaceId: run.thread.workspaceId },
          kind: "capture",
          summary: `Listening found a decision that would replace an active one: ${decision.statement}`,
          conversationId: null,
          channelId: run.thread.channelId,
          threadId: run.thread.threadId,
          area: decision.replaces.area,
          decisionIds: [decision.replaces.id],
          proposalId: z.object({ id: z.string() }).parse(inserted).id,
          positions: [
            {
              actorId: decision.decidedBy.actorId,
              name: decision.decidedBy.name,
              says: decision.statement,
            },
          ],
          deciders: decision.replaces.deciders,
        });
      }
    }
    // Only up to the message it was claimed at: one that arrived during the call keeps the
    // thread due.
    await tx.query(
      `update observed_threads
       set captured_through = $2, capture_failures = 0, capture_lease_until = null, updated_at = now()
       where id = $1`,
      [run.thread.id, run.thread.lastMessageAt],
    );
    await tx.query(`update capture_runs set proposals = $2 where id = $1`, [runId, proposed]);
    return { proposed };
  });
}

/** Who wrote in the thread, among its kept messages: who may confirm its proposals (G11). */
export async function threadWriters(db: Db, thread: ObservedThread): Promise<string[]> {
  const rows = await db.query(
    `select distinct actor_id from observed_messages
     where source = $1 and workspace_id = $2 and channel_id = $3 and thread_id = $4
     order by actor_id`,
    [thread.source, thread.workspaceId, thread.channelId, thread.threadId],
  );
  return rows.map((r) => z.object({ actor_id: z.string() }).parse(r).actor_id);
}
