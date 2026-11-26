import {
  goalTicketStateSchema,
  type EditGoalRequest,
  type GoalTicket,
  type GoalTicketState,
  type OutboundDelivery,
  type TaskProvider,
} from "@hippidy/contracts";
import { z } from "zod";
import type { AreaActor } from "./areas.ts";
import { enqueueDelivery } from "./conversations.ts";
import type { Db, Row } from "./db.ts";
import { storable, toJsonText } from "./json.ts";

// Feature goals (slice 4.4, decision 221): a goal job's thread, limit and tickets. A person makes
// and changes a goal (G16); its wakes only move its tickets on (settled, briefed, skipped),
// never its goal, tickets or limit.

/** A ticket as the tracker gave it when it was checked. */
export interface CheckedTicket {
  key: string;
  title: string;
  url: string | null;
}

/** A ticket of a goal, with what the wake needs to settle it. */
export interface StoredTicket {
  id: string;
  key: string;
  position: number;
  title: string;
  url: string | null;
  state: GoalTicketState;
  changeId: string | null;
  briefId: string | null;
  changeStatus: "waiting_for_start" | "started" | "stopped" | null;
  pullRequestUrl: string | null;
  failures: number;
  settledAt: Date | null;
}

/** A goal as stored: its thread and limit, and its tickets in order. */
export interface StoredGoal {
  jobId: string;
  conversationId: string;
  channelId: string;
  threadId: string;
  limit: number;
  settledSaidAt: Date | null;
  tickets: StoredTicket[];
}

const ticketRow = z.object({
  id: z.string(),
  key: z.string(),
  position: z.number().int(),
  title: z.string(),
  url: z.string().nullable(),
  state: goalTicketStateSchema,
  change_id: z.string().nullable(),
  brief_id: z.string().nullable(),
  change_status: z.enum(["waiting_for_start", "started", "stopped"]).nullable(),
  pull_request_url: z.string().nullable(),
  failures: z.number().int(),
  settled_at: z.date().nullable(),
});

const goalRow = z.object({
  job_id: z.string(),
  conversation_id: z.string(),
  channel_id: z.string(),
  thread_id: z.string(),
  open_limit: z.number().int(),
  settled_said_at: z.date().nullable(),
});

async function ticketsOf(db: Db, jobId: string): Promise<StoredTicket[]> {
  const rows = await db.query(
    `select t.id, t.key, t.position, t.title, t.url, t.state, t.change_id, t.brief_id,
            c.status as change_status, c.pull_request_url, t.failures, t.settled_at
     from goal_tickets t left join changes c on c.id = t.change_id
     where t.job_id = $1
     order by t.position, t.key`,
    [jobId],
  );
  return rows.map((row: Row) => {
    const r = ticketRow.parse(row);
    return {
      id: r.id,
      key: r.key,
      position: r.position,
      title: r.title,
      url: r.url,
      state: r.state,
      changeId: r.change_id,
      briefId: r.brief_id,
      changeStatus: r.change_status,
      pullRequestUrl: r.pull_request_url,
      failures: r.failures,
      settledAt: r.settled_at,
    };
  });
}

/** A goal job's thread, limit and tickets; undefined when the job has none (not a goal). */
export async function findGoal(db: Db, jobId: string): Promise<StoredGoal | undefined> {
  const rows = await db.query(
    `select g.job_id, g.conversation_id, v.channel_id, v.thread_id, g.open_limit,
            g.settled_said_at
     from goals g join conversations v on v.id = g.conversation_id
     where g.job_id = $1`,
    [jobId],
  );
  if (rows[0] === undefined) return undefined;
  const g = goalRow.parse(rows[0]);
  return {
    jobId: g.job_id,
    conversationId: g.conversation_id,
    channelId: g.channel_id,
    threadId: g.thread_id,
    limit: g.open_limit,
    settledSaidAt: g.settled_said_at,
    tickets: await ticketsOf(db, jobId),
  };
}

/** A ticket as the API shows it. */
export function toGoalTicket(ticket: StoredTicket): GoalTicket {
  return {
    key: ticket.key,
    title: ticket.title,
    url: ticket.url,
    state: ticket.state,
    change:
      ticket.changeId === null || ticket.changeStatus === null
        ? null
        : {
            id: ticket.changeId,
            status: ticket.changeStatus,
            pullRequestUrl: ticket.pullRequestUrl,
          },
    failures: ticket.failures,
    settledAt: ticket.settledAt?.toISOString() ?? null,
  };
}

/** Whether a ticket has had a brief: it then stays in its goal, whatever happens to it. */
export function wasBriefed(ticket: StoredTicket): boolean {
  return (
    ticket.briefId !== null ||
    ticket.changeId !== null ||
    ["briefed", "merged", "closed", "stopped"].includes(ticket.state)
  );
}

export type GoalWrite =
  | { status: "created" | "edited" | "unchanged" | "changed"; name: string }
  | { status: "no_thread" | "thread_taken" | "name_taken" | "not_found" }
  | { status: "briefed_tickets" | "unknown_tickets"; tickets: string[] };

/**
 * A signed-in person makes a goal for a thread the bot is in (slice 4.4): a job of kind `goal`
 * that they own, its thread and limit, and its tickets in order, already checked in the
 * tracker. One goal per thread: the thread's row is locked while it is made. Kept in the job's
 * history as made by the person.
 */
export async function createGoal(
  db: Db,
  actor: AreaActor,
  goal: {
    name: string;
    goal: string;
    channelId: string;
    threadId: string;
    limit: number;
    capCents: number;
    everyMinutes: number;
  },
  tickets: readonly CheckedTicket[],
): Promise<GoalWrite> {
  return db.transaction(async (tx) => {
    const conversations = await tx.query(
      `select id from conversations
       where source = $1 and workspace_id = $2 and channel_id = $3 and thread_id = $4
       for update`,
      [actor.source, actor.workspaceId, goal.channelId, goal.threadId],
    );
    if (conversations[0] === undefined) return { status: "no_thread" };
    const conversationId = z.object({ id: z.string() }).parse(conversations[0]).id;
    const taken = await tx.query(`select 1 from goals where conversation_id = $1`, [
      conversationId,
    ]);
    if (taken.length > 0) return { status: "thread_taken" };
    const text = storable(goal.goal).trim();
    const jobs = await tx.query(
      `insert into jobs (source, workspace_id, name, kind, goal, owner_actor_id, owner_name,
         cap_cents, every_minutes)
       values ($1, $2, $3, 'goal', $4, $5, $6, $7, $8)
       on conflict (source, workspace_id, name) do nothing
       returning id`,
      [
        actor.source,
        actor.workspaceId,
        goal.name,
        text,
        actor.actorId,
        actor.name,
        goal.capCents,
        goal.everyMinutes,
      ],
    );
    if (jobs[0] === undefined) return { status: "name_taken" };
    const jobId = z.object({ id: z.string() }).parse(jobs[0]).id;
    await tx.query(`insert into goals (job_id, conversation_id, open_limit) values ($1, $2, $3)`, [
      jobId,
      conversationId,
      goal.limit,
    ]);
    await insertTickets(tx, jobId, tickets, 0);
    await tx.query(
      `insert into job_events (job_id, actor_id, actor_name, before, after)
       values ($1, $2, $3, '{}'::jsonb, $4::text::jsonb)`,
      [
        jobId,
        actor.actorId,
        actor.name,
        toJsonText({
          goal: text,
          tickets: tickets.map((ticket) => ticket.key),
          limit: goal.limit,
          capCents: goal.capCents,
          everyMinutes: goal.everyMinutes,
        }),
      ],
    );
    return { status: "created", name: goal.name };
  });
}

async function insertTickets(
  tx: Db,
  jobId: string,
  tickets: readonly CheckedTicket[],
  from: number,
): Promise<void> {
  for (const [index, ticket] of tickets.entries()) {
    await tx.query(
      `insert into goal_tickets (job_id, key, position, title, url) values ($1, $2, $3, $4, $5)`,
      [
        jobId,
        ticket.key,
        from + index,
        storable(ticket.title).slice(0, 500),
        ticket.url === null ? null : storable(ticket.url).slice(0, 500),
      ],
    );
  }
}

/** The keys of a goal's tickets, in order: what an edit compares against. */
export async function goalTicketKeys(
  db: Db,
  actor: AreaActor,
  jobId: string,
): Promise<string[] | undefined> {
  const rows = await db.query(
    `select t.key from goals g join jobs j on j.id = g.job_id
     left join goal_tickets t on t.job_id = g.job_id
     where g.job_id = $1 and j.source = $2 and j.workspace_id = $3
     order by t.position, t.key`,
    [jobId, actor.source, actor.workspaceId],
  );
  if (rows.length === 0) return undefined;
  return rows.flatMap((row) => {
    const key = z.object({ key: z.string().nullable() }).parse(row).key;
    return key === null ? [] : [key];
  });
}

/**
 * A person changes a goal's tickets (adding ones checked in the tracker, removing ones not yet
 * briefed, reordering) or its limit, on the job's version they saw. Each change is kept in the
 * job's history and moves its version on. Adding a ticket lets the goal say again, later, that
 * every ticket is settled.
 */
export async function editGoal(
  db: Db,
  actor: AreaActor,
  jobId: string,
  request: EditGoalRequest,
  checked: ReadonlyMap<string, CheckedTicket>,
): Promise<GoalWrite> {
  return db.transaction(async (tx) => {
    const jobs = await tx.query(
      `select j.name, j.version, g.open_limit from jobs j join goals g on g.job_id = j.id
       where j.id = $1 and j.source = $2 and j.workspace_id = $3 and j.kind = 'goal'
       for update of j, g`,
      [jobId, actor.source, actor.workspaceId],
    );
    if (jobs[0] === undefined) return { status: "not_found" };
    const job = z
      .object({ name: z.string(), version: z.number().int(), open_limit: z.number().int() })
      .parse(jobs[0]);
    if (job.version !== request.version) return { status: "changed", name: job.name };
    const current = await ticketsOf(tx, jobId);
    const keys = request.tickets ?? current.map((ticket) => ticket.key);
    const kept = new Set(keys);
    const briefedOut = current.filter((ticket) => !kept.has(ticket.key) && wasBriefed(ticket));
    if (briefedOut.length > 0) {
      return { status: "briefed_tickets", tickets: briefedOut.map((ticket) => ticket.key) };
    }
    const known = new Set(current.map((ticket) => ticket.key));
    const added = keys.filter((key) => !known.has(key));
    const unchecked = added.filter((key) => !checked.has(key));
    // Checked before the transaction against what the goal had then: a key not checked means
    // the goal changed in between.
    if (unchecked.length > 0) return { status: "changed", name: job.name };
    const before = { tickets: current.map((ticket) => ticket.key), limit: job.open_limit };
    const after = { tickets: keys, limit: request.limit ?? job.open_limit };
    if (JSON.stringify(before) === JSON.stringify(after)) {
      return { status: "unchanged", name: job.name };
    }
    await tx.query(`delete from goal_tickets where job_id = $1 and not (key = any($2::text[]))`, [
      jobId,
      keys,
    ]);
    // Out of the way first, then in their new places.
    await tx.query(`update goal_tickets set position = position + 50 where job_id = $1`, [jobId]);
    for (const [index, key] of keys.entries()) {
      const ticket = checked.get(key);
      if (!known.has(key) && ticket !== undefined) {
        await insertTickets(tx, jobId, [ticket], index);
      } else {
        await tx.query(
          `update goal_tickets set position = $3, updated_at = now() where job_id = $1 and key = $2`,
          [jobId, key, index],
        );
      }
    }
    await tx.query(
      `update goals set open_limit = $2,
         settled_said_at = case when $3 then null else settled_said_at end, updated_at = now()
       where job_id = $1`,
      [jobId, after.limit, added.length > 0],
    );
    await tx.query(`update jobs set version = version + 1, updated_at = now() where id = $1`, [
      jobId,
    ]);
    await tx.query(
      `insert into job_events (job_id, actor_id, actor_name, before, after)
       values ($1, $2, $3, $4::text::jsonb, $5::text::jsonb)`,
      [jobId, actor.actorId, actor.name, toJsonText(before), toJsonText(after)],
    );
    return { status: "edited", name: job.name };
  });
}

// ---------------------------------------------------------------------------------------
// What a wake does: each step one short transaction, never across a call to another service.

/** A line for the goal's thread, keyed so a retried wake queues it once. */
export interface ThreadLine {
  conversationId: string;
  key: string;
  payload: OutboundDelivery;
}

/**
 * Settles a briefed ticket (merged, closed or stopped) and queues its line in the thread, with,
 * for a merged built-in task, marking it done (`also`), all at once. Answers whether this call
 * settled it (a ticket another wake settled first is left).
 */
export async function settleTicket(
  db: Db,
  ticketId: string,
  state: "merged" | "closed" | "stopped",
  line: ThreadLine | undefined,
  also?: (tx: Db) => Promise<void>,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx.query(
      `update goal_tickets set state = $2, settled_at = now(), updated_at = now()
       where id = $1 and state = 'briefed'
       returning id`,
      [ticketId, state],
    );
    if (rows.length === 0) return false;
    if (also !== undefined) await also(tx);
    if (line !== undefined) {
      await enqueueDelivery(tx, line.conversationId, line.key, "note", line.payload);
    }
    return true;
  });
}

/**
 * Settles a pending ticket without a brief: done in the tracker already, or skipped (no longer
 * in the tracker), with its line if it has one. Answers whether this call settled it.
 */
export async function settlePendingTicket(
  db: Db,
  ticketId: string,
  state: "done_elsewhere" | "skipped",
  error: string | undefined,
  line: ThreadLine | undefined,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx.query(
      `update goal_tickets set state = $2, error = $3, settled_at = now(), updated_at = now()
       where id = $1 and state = 'pending'
       returning id`,
      [ticketId, state, error === undefined ? null : storable(error).slice(0, 500)],
    );
    if (rows.length === 0) return false;
    if (line !== undefined) {
      await enqueueDelivery(tx, line.conversationId, line.key, "note", line.payload);
    }
    return true;
  });
}

/** Most model calls in a row that may fail on one ticket before it is skipped. */
export const MAX_BRIEF_FAILURES = 3;

/**
 * Counts a model call that gave no brief for a ticket; the third in a row skips it, with its
 * line queued in the same transaction. Answers the failures so far and whether it was skipped.
 */
export async function recordBriefFailure(
  db: Db,
  ticketId: string,
  error: string,
  skippedLine: (failures: number) => ThreadLine,
): Promise<{ failures: number; skipped: boolean }> {
  return db.transaction(async (tx) => {
    const rows = await tx.query(
      `update goal_tickets
       set failures = least(failures + 1, 10), error = $2, updated_at = now(),
           state = case when failures + 1 >= $3 then 'skipped' else state end,
           settled_at = case when failures + 1 >= $3 then now() else settled_at end
       where id = $1 and state = 'pending'
       returning failures, state`,
      [ticketId, storable(error).slice(0, 500), MAX_BRIEF_FAILURES],
    );
    if (rows[0] === undefined) return { failures: 0, skipped: false };
    const r = z.object({ failures: z.number().int(), state: z.string() }).parse(rows[0]);
    const skipped = r.state === "skipped";
    if (skipped) {
      const line = skippedLine(r.failures);
      await enqueueDelivery(tx, line.conversationId, line.key, "note", line.payload);
    }
    return { failures: r.failures, skipped };
  });
}

/**
 * Marks a pending ticket briefed with its change and brief, and queues the brief in the thread
 * under the brief's id (as `start_change` does, 2.1), at once. Its title is refreshed from the
 * tracker. Answers whether this call marked it.
 */
export async function markTicketBriefed(
  db: Db,
  ticketId: string,
  briefed: { changeId: string; briefId: string; title: string },
  brief: ThreadLine,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx.query(
      `update goal_tickets
       set state = 'briefed', change_id = $2, brief_id = $3, title = $4, failures = 0,
           error = null, updated_at = now()
       where id = $1 and state = 'pending'
       returning id`,
      [ticketId, briefed.changeId, briefed.briefId, storable(briefed.title).slice(0, 500)],
    );
    if (rows.length === 0) return false;
    await enqueueDelivery(tx, brief.conversationId, brief.key, "note", brief.payload);
    return true;
  });
}

/** A brief written for a ticket earlier, kept by its key though its ticket was not marked. */
export interface EarlierBrief {
  changeId: string;
  briefId: string;
  title: string;
  what: string;
  why: string;
  doneWhen: string;
  links: string[];
  startReason: string | null;
}

/** The brief already written under a key, if a wake died after writing it. */
export async function briefByKey(db: Db, key: string): Promise<EarlierBrief | undefined> {
  const rows = await db.query(
    `select id, change_id, title, what, why, done_when, links::text as links, start_reason
     from change_briefs where custom_tool_use_id = $1`,
    [key],
  );
  if (rows[0] === undefined) return undefined;
  const r = z
    .object({
      id: z.string(),
      change_id: z.string(),
      title: z.string(),
      what: z.string(),
      why: z.string(),
      done_when: z.string(),
      links: z.string(),
      start_reason: z.string().nullable(),
    })
    .parse(rows[0]);
  return {
    changeId: r.change_id,
    briefId: r.id,
    title: r.title,
    what: r.what,
    why: r.why,
    doneWhen: r.done_when,
    links: z.array(z.string()).parse(JSON.parse(r.links)),
    startReason: r.start_reason,
  };
}

/**
 * Claims saying, once, that every ticket is settled, and queues the line in the same
 * transaction. Answers whether this call said it.
 */
export async function claimAllSettled(
  db: Db,
  jobId: string,
  line: (claimedAt: Date) => ThreadLine,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx.query(
      `update goals set settled_said_at = now(), updated_at = now()
       where job_id = $1 and settled_said_at is null
       returning settled_said_at`,
      [jobId],
    );
    if (rows[0] === undefined) return false;
    const at = z.object({ settled_said_at: z.date() }).parse(rows[0]).settled_said_at;
    const queued = line(at);
    await enqueueDelivery(tx, queued.conversationId, queued.key, "note", queued.payload);
    return true;
  });
}

/** The goal as the API shows it, from what is stored. */
export function goalView(goal: StoredGoal, provider: TaskProvider) {
  return {
    conversationId: goal.conversationId,
    channelId: goal.channelId,
    threadId: goal.threadId,
    limit: goal.limit,
    open: goal.tickets.filter((ticket) => ticket.state === "briefed").length,
    provider,
    tickets: goal.tickets.map(toGoalTicket),
  };
}
