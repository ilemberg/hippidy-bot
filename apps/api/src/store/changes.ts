import { messageSourceSchema, sessionStateSchema, type MessageSource } from "@hippidy/contracts";
import { z } from "zod";
import type { SessionState } from "./conversations.ts";
import { STARTING_PREFIX } from "./conversations.ts";
import type { Db, Row } from "./db.ts";
import { toJsonText } from "./json.ts";

// Changes, their briefs and their coding workers' sessions (slice 2.1, decisions 181 and 184).
// A change's worker has a loop of its own beside the thread's: these are its store functions,
// shaped like the conversation's in `conversations.ts`.

export interface ChangeActor {
  source: MessageSource;
  workspaceId: string;
  actorId: string;
  name: string | null;
}

export type ChangeStatus = "waiting_for_start" | "started" | "stopped";

export interface Change {
  id: string;
  conversationId: string;
  requestedBy: ChangeActor;
  status: ChangeStatus;
  /** The worker's session, or a start claim (`starting:…`), or null before it is started. */
  agentSessionId: string | null;
  sessionState: SessionState;
  /** When the worker was given a brief it has not finished with. */
  waitingSince: Date | null;
  agentEventCursor: string | null;
}

const changeRow = z.object({
  id: z.string(),
  conversation_id: z.string(),
  requested_by_source: messageSourceSchema,
  requested_by_workspace_id: z.string(),
  requested_by_actor_id: z.string(),
  requested_by_name: z.string().nullable(),
  status: z.enum(["waiting_for_start", "started", "stopped"]),
  agent_session_id: z.string().nullable(),
  session_state: sessionStateSchema,
  waiting_since: z.date().nullable(),
  agent_event_cursor: z.string().nullable(),
});

const changeColumns =
  "id, conversation_id, requested_by_source, requested_by_workspace_id, requested_by_actor_id, " +
  "requested_by_name, status, agent_session_id, session_state, waiting_since, agent_event_cursor";

function toChange(row: Row): Change {
  const r = changeRow.parse(row);
  return {
    id: r.id,
    conversationId: r.conversation_id,
    requestedBy: {
      source: r.requested_by_source,
      workspaceId: r.requested_by_workspace_id,
      actorId: r.requested_by_actor_id,
      name: r.requested_by_name,
    },
    status: r.status,
    agentSessionId: r.agent_session_id,
    sessionState: r.session_state,
    waitingSince: r.waiting_since,
    agentEventCursor: r.agent_event_cursor,
  };
}

function one(rows: Row[]): Row {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

/** The worker's session id, or undefined if none has started yet. */
export function workerSessionIdOf(change: Change): string | undefined {
  const id = change.agentSessionId;
  return id === null || id.startsWith(STARTING_PREFIX) ? undefined : id;
}

export async function getChange(db: Db, id: string): Promise<Change> {
  return toChange(one(await db.query(`select ${changeColumns} from changes where id = $1`, [id])));
}

export async function findChangeBySession(
  db: Db,
  agentSessionId: string,
): Promise<Change | undefined> {
  const rows = await db.query(`select ${changeColumns} from changes where agent_session_id = $1`, [
    agentSessionId,
  ]);
  return rows[0] === undefined ? undefined : toChange(rows[0]);
}

/** A thread's changes, oldest first. */
export async function changesOfConversation(db: Db, conversationId: string): Promise<Change[]> {
  const rows = await db.query(
    `select ${changeColumns} from changes where conversation_id = $1 order by created_at, id`,
    [conversationId],
  );
  return rows.map(toChange);
}

// ---------------------------------------------------------------------------------------
// Briefs

export interface BriefText {
  title: string;
  what: string;
  why: string;
  doneWhen: string;
  links: string[];
}

export type CreateBriefResult =
  | {
      kind: "created" | "existing";
      changeId: string;
      briefId: string;
      /** Whether the worker may have it now: no person needs to start it. */
      started: boolean;
    }
  /** `changeId` names no change of this thread. */
  | { kind: "no_change" }
  /** `changeId` names a change that was stopped. */
  | { kind: "stopped" };

/**
 * Writes the brief of one `start_change` call (decision 167's pattern: keyed on the call's id,
 * so answering the call again writes nothing twice): a new change, or a further brief for one
 * of the thread's changes. A brief that needs no person is started as it is written. The
 * thread's messages the call's turn is answering (`turnEventIds`, their agent event ids) are
 * linked to it, so the worker's turn settles them (decision 184). One short transaction, with
 * no other service called inside it.
 */
export async function createBrief(
  db: Db,
  input: {
    conversationId: string;
    customToolUseId: string;
    changeId: string | undefined;
    requestedBy: ChangeActor;
    brief: BriefText;
    /** Why a person must start it, or undefined if no one needs to. */
    startReason: string | undefined;
    turnEventIds: readonly string[];
  },
): Promise<CreateBriefResult> {
  return db.transaction(async (tx) => {
    const existing = await tx.query(
      `select b.id, b.change_id, b.started_at from change_briefs b
       where b.custom_tool_use_id = $1`,
      [input.customToolUseId],
    );
    if (existing[0] !== undefined) {
      const r = z
        .object({ id: z.string(), change_id: z.string(), started_at: z.date().nullable() })
        .parse(existing[0]);
      return {
        kind: "existing",
        changeId: r.change_id,
        briefId: r.id,
        started: r.started_at !== null,
      };
    }

    let changeId: string;
    if (input.changeId !== undefined) {
      const rows = await tx.query(
        `select status from changes where id = $1 and conversation_id = $2 for update`,
        [input.changeId, input.conversationId],
      );
      if (rows[0] === undefined) return { kind: "no_change" };
      if (z.object({ status: z.string() }).parse(rows[0]).status === "stopped") {
        return { kind: "stopped" };
      }
      changeId = input.changeId;
    } else {
      const created = await tx.query(
        `insert into changes (conversation_id, requested_by_source, requested_by_workspace_id,
           requested_by_actor_id, requested_by_name)
         values ($1, $2, $3, $4, $5) returning id`,
        [
          input.conversationId,
          input.requestedBy.source,
          input.requestedBy.workspaceId,
          input.requestedBy.actorId,
          input.requestedBy.name,
        ],
      );
      changeId = z.object({ id: z.string() }).parse(one(created)).id;
    }

    const started = input.startReason === undefined;
    const brief = await tx.query(
      `insert into change_briefs (change_id, custom_tool_use_id, title, what, why, done_when,
         links, start_needed, start_reason, started_at)
       values ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8, $9,
               case when $8 then null else now() end)
       returning id`,
      [
        changeId,
        input.customToolUseId,
        input.brief.title,
        input.brief.what,
        input.brief.why,
        input.brief.doneWhen,
        toJsonText(input.brief.links),
        !started,
        input.startReason ?? null,
      ],
    );
    const briefId = z.object({ id: z.string() }).parse(one(brief)).id;
    if (started) {
      await tx.query(
        `update changes set status = 'started', updated_at = now()
         where id = $1 and status = 'waiting_for_start'`,
        [changeId],
      );
    }
    if (input.turnEventIds.length > 0) {
      await tx.query(
        `update inbound_messages set change_brief_id = $3
         where conversation_id = $1 and status = 'received' and change_brief_id is null
           and agent_event_id = any($2::text[])`,
        [input.conversationId, input.turnEventIds, briefId],
      );
    }
    return { kind: "created", changeId, briefId, started };
  });
}

export type StartBriefStatus = "started" | "already_started" | "stopped" | "not_found";

/**
 * A person starts a brief the start rule held back. Only a brief of a thread in the same source
 * and workspace as the person, and only once; never one of a stopped change.
 */
export async function startBrief(
  db: Db,
  briefId: string,
  person: ChangeActor,
): Promise<{ status: StartBriefStatus; changeId?: string; conversationId?: string }> {
  const started = await db.query(
    `update change_briefs b
     set started_at = now(), started_by_source = $2, started_by_workspace_id = $3,
         started_by_actor_id = $4, started_by_name = $5
     from changes c, conversations v
     where b.id = $1 and c.id = b.change_id and v.id = c.conversation_id
       and v.source = $2 and v.workspace_id = $3
       and b.started_at is null and c.status <> 'stopped'
     returning b.change_id, c.conversation_id`,
    [briefId, person.source, person.workspaceId, person.actorId, person.name],
  );
  if (started[0] !== undefined) {
    const r = z.object({ change_id: z.string(), conversation_id: z.string() }).parse(started[0]);
    await db.query(
      `update changes set status = 'started', updated_at = now()
       where id = $1 and status = 'waiting_for_start'`,
      [r.change_id],
    );
    return { status: "started", changeId: r.change_id, conversationId: r.conversation_id };
  }
  const found = await db.query(
    `select b.started_at, c.status, c.id as change_id, c.conversation_id
     from change_briefs b join changes c on c.id = b.change_id
     join conversations v on v.id = c.conversation_id
     where b.id = $1 and v.source = $2 and v.workspace_id = $3`,
    [briefId, person.source, person.workspaceId],
  );
  if (found[0] === undefined) return { status: "not_found" };
  const r = z
    .object({
      started_at: z.date().nullable(),
      status: z.string(),
      change_id: z.string(),
      conversation_id: z.string(),
    })
    .parse(found[0]);
  return {
    status: r.started_at !== null ? "already_started" : "stopped",
    changeId: r.change_id,
    conversationId: r.conversation_id,
  };
}

export interface BriefToSend extends BriefText {
  id: string;
  /** Whether an earlier brief of the same change was handed over before this one. */
  followUp: boolean;
}

/** The change's started briefs not yet handed to its worker, in order. */
export async function unsentBriefs(db: Db, changeId: string): Promise<BriefToSend[]> {
  const rows = await db.query(
    `select b.id, b.title, b.what, b.why, b.done_when, b.links::text as links,
            exists (select 1 from change_briefs e
                    where e.change_id = b.change_id and e.worker_event_id is not null) as follow_up
     from change_briefs b
     where b.change_id = $1 and b.started_at is not null and b.worker_event_id is null
     order by b.seq`,
    [changeId],
  );
  return rows.map((row) => {
    const r = z
      .object({
        id: z.string(),
        title: z.string(),
        what: z.string(),
        why: z.string(),
        done_when: z.string(),
        links: z.string(),
        follow_up: z.boolean(),
      })
      .parse(row);
    return {
      id: r.id,
      title: r.title,
      what: r.what,
      why: r.why,
      doneWhen: r.done_when,
      links: z.array(z.string()).parse(JSON.parse(r.links)),
      followUp: r.follow_up,
    };
  });
}

/** Records that the brief was handed to the worker, under the event id it was given. */
export async function markBriefSent(db: Db, briefId: string, eventId: string): Promise<void> {
  await db.query(
    `update change_briefs set worker_event_id = $2 where id = $1 and worker_event_id is null`,
    [briefId, eventId],
  );
}

/** The latest brief's title, to say which change a worker's report is about. */
export async function latestBriefTitle(db: Db, changeId: string): Promise<string | undefined> {
  const rows = await db.query(
    `select title from change_briefs where change_id = $1 order by seq desc limit 1`,
    [changeId],
  );
  return z.object({ title: z.string() }).optional().parse(rows[0])?.title;
}

/** Messages that led to briefs of this change and still wait for an outcome. */
export async function pendingChangeMessageCount(db: Db, changeId: string): Promise<number> {
  const rows = await db.query(
    `select count(*)::int as n from inbound_messages m
     join change_briefs b on b.id = m.change_brief_id
     where b.change_id = $1 and m.status = 'received'`,
    [changeId],
  );
  return z.object({ n: z.number().int() }).parse(one(rows)).n;
}

// ---------------------------------------------------------------------------------------
// The worker's session and its loop

/** A session start not finished after this long is assumed lost, as for conversations. */
const STALE_START_SECONDS = 180;

/** Claims the right to start the change's worker. Undefined if one exists or is starting. */
export async function claimWorkerStart(db: Db, changeId: string): Promise<string | undefined> {
  const rows = await db.query(
    `update changes
     set agent_session_id = $2 || gen_random_uuid()::text, updated_at = now()
     where id = $1
       and (agent_session_id is null
            or (agent_session_id like $3 and updated_at < now() - make_interval(secs => $4)))
     returning agent_session_id`,
    [changeId, STARTING_PREFIX, `${STARTING_PREFIX}%`, STALE_START_SECONDS],
  );
  return rows[0] === undefined ? undefined : z.string().parse(rows[0].agent_session_id);
}

export async function releaseWorkerStart(db: Db, changeId: string, claim: string): Promise<void> {
  await db.query(
    `update changes set agent_session_id = null, updated_at = now()
     where id = $1 and agent_session_id = $2`,
    [changeId, claim],
  );
}

/** Attaches the started worker, if the start claim is still ours. */
export async function attachWorker(
  db: Db,
  changeId: string,
  claim: string,
  session: { sessionId: string; agentId: string; agentVersion: number },
): Promise<boolean> {
  const rows = await db.query(
    `update changes
     set agent_session_id = $3, agent_id = $4, agent_version = $5, session_state = 'active',
         updated_at = now()
     where id = $1 and agent_session_id = $2
     returning id`,
    [changeId, claim, session.sessionId, session.agentId, session.agentVersion],
  );
  return rows.length > 0;
}

/** Proof of holding a change's sync lease, as for conversations. */
export interface ChangeLease {
  changeId: string;
  owner: string;
}

/** A worker's sync that has not finished after this long is assumed dead. */
export const CHANGE_LEASE_SECONDS = 120;

export async function claimChangeLease(db: Db, changeId: string): Promise<ChangeLease | undefined> {
  const rows = await db.query(
    `update changes
     set sync_lease_until = now() + make_interval(secs => $2),
         sync_lease_owner = gen_random_uuid()
     where id = $1 and (sync_lease_until is null or sync_lease_until < now())
     returning sync_lease_owner::text as owner`,
    [changeId, CHANGE_LEASE_SECONDS],
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : { changeId, owner: z.object({ owner: z.string() }).parse(row).owner };
}

export async function renewChangeLease(db: Db, lease: ChangeLease): Promise<boolean> {
  const rows = await db.query(
    `update changes set sync_lease_until = now() + make_interval(secs => $3)
     where id = $1 and sync_lease_owner = $2::uuid and sync_lease_until >= now()
     returning id`,
    [lease.changeId, lease.owner, CHANGE_LEASE_SECONDS],
  );
  return rows.length > 0;
}

export async function releaseChangeLease(db: Db, lease: ChangeLease): Promise<void> {
  await db.query(
    `update changes set sync_lease_until = null, sync_lease_owner = null
     where id = $1 and sync_lease_owner = $2::uuid`,
    [lease.changeId, lease.owner],
  );
}

export async function setChangeCursor(db: Db, changeId: string, eventId: string): Promise<void> {
  await db.query(`update changes set agent_event_cursor = $2, updated_at = now() where id = $1`, [
    changeId,
    eventId,
  ]);
}

export async function setChangeSessionState(
  db: Db,
  changeId: string,
  state: SessionState,
): Promise<void> {
  await db.query(`update changes set session_state = $2, updated_at = now() where id = $1`, [
    changeId,
    state,
  ]);
}

/** The worker has a brief to work on: keeps the time it first started waiting. */
export async function markChangeWaiting(db: Db, changeId: string): Promise<void> {
  await db.query(
    `update changes set waiting_since = coalesce(waiting_since, now()), updated_at = now()
     where id = $1`,
    [changeId],
  );
}

/** The worker has finished with everything it was given. */
export async function clearChangeWaiting(db: Db, changeId: string): Promise<void> {
  await db.query(`update changes set waiting_since = null, updated_at = now() where id = $1`, [
    changeId,
  ]);
}

/**
 * Stops every change of a thread: nothing more is handed to their workers. Returns the workers
 * that were working, to interrupt.
 */
export async function stopChanges(db: Db, conversationId: string): Promise<string[]> {
  const rows = await db.query(
    `update changes c
     set status = 'stopped', waiting_since = null, updated_at = now()
     from (select id, waiting_since as was_waiting from changes
           where conversation_id = $1 and status <> 'stopped' for update) o
     where c.id = o.id
     returning c.agent_session_id, o.was_waiting`,
    [conversationId],
  );
  return rows.flatMap((row) => {
    const r = z
      .object({ agent_session_id: z.string().nullable(), was_waiting: z.date().nullable() })
      .parse(row);
    return r.agent_session_id !== null &&
      !r.agent_session_id.startsWith(STARTING_PREFIX) &&
      r.was_waiting !== null
      ? [r.agent_session_id]
      : [];
  });
}

/**
 * Changes the reconcile job should look at: started, with a brief not yet handed over, or with
 * a worker that has had work for longer than `waitingForSeconds`. Those being synced right now
 * are skipped.
 */
export async function changesToReconcile(
  db: Db,
  options: { waitingForSeconds: number; limit: number },
): Promise<Change[]> {
  const rows = await db.query(
    `select ${changeColumns} from changes c
     where c.status = 'started'
       and (c.sync_lease_until is null or c.sync_lease_until < now())
       and ((c.waiting_since is not null
             and c.waiting_since < now() - make_interval(secs => $1))
            or exists (select 1 from change_briefs b
                       where b.change_id = c.id and b.started_at is not null
                         and b.worker_event_id is null))
     order by c.updated_at
     limit $2`,
    [options.waitingForSeconds, options.limit],
  );
  return rows.map(toChange);
}

/** The thread's changes with a started brief not yet handed to their worker. */
export async function changesWithUnsentBriefs(db: Db, conversationId: string): Promise<Change[]> {
  const rows = await db.query(
    `select ${changeColumns} from changes c
     where c.conversation_id = $1 and c.status = 'started'
       and exists (select 1 from change_briefs b
                   where b.change_id = c.id and b.started_at is not null
                     and b.worker_event_id is null)
     order by c.created_at`,
    [conversationId],
  );
  return rows.map(toChange);
}

// ---------------------------------------------------------------------------------------
// The teammate's view of its workers

export interface WorkerReport {
  /** The change's latest brief title. */
  title: string;
  text: string;
}

/**
 * What the thread's workers posted in the thread after `since` (the last event of the
 * thread's own session): the last message of each of their turns, oldest first, at most ten.
 * Given to the teammate with the next message (decision 184).
 */
export async function workerReportsSince(
  db: Db,
  conversationId: string,
  since: Date | undefined,
): Promise<WorkerReport[]> {
  const rows = await db.query(
    `select (select b.title from change_briefs b where b.change_id = c.id
             order by b.seq desc limit 1) as title,
            e.text
     from agent_events e
     join changes c on c.conversation_id = e.conversation_id
                   and c.agent_session_id = e.agent_session_id
     join deliveries d on d.conversation_id = e.conversation_id
                      and d.agent_event_id = e.event_id
     where e.conversation_id = $1 and e.kind = 'agent_message' and e.text is not null
       and ($2::timestamptz is null or e.processed_at > $2::timestamptz)
     order by e.processed_at desc, e.seq desc
     limit 10`,
    [conversationId, since ?? null],
  );
  return rows
    .map((row) => {
      const r = z.object({ title: z.string().nullable(), text: z.string() }).parse(row);
      return { title: r.title ?? "a change", text: r.text };
    })
    .reverse();
}

/** The name a person last went by in the thread, if the source said. */
export async function actorNameInConversation(
  db: Db,
  conversationId: string,
  actorId: string,
): Promise<string | null> {
  const rows = await db.query(
    `select actor_name from inbound_messages
     where conversation_id = $1 and actor_id = $2 and actor_name is not null
     order by created_at desc limit 1`,
    [conversationId, actorId],
  );
  return z.object({ actor_name: z.string() }).optional().parse(rows[0])?.actor_name ?? null;
}
