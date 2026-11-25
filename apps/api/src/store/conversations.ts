import {
  conversationStatusSchema,
  messageSourceSchema,
  outboundDeliverySchema,
  sessionStateSchema,
  type ConversationStatus,
  type InboundMessage,
  type MessageSource,
  type OutboundDelivery,
  type SessionState,
} from "@hippidy/contracts";
import { z } from "zod";
import type { AgentKind } from "../agent/runtime.ts";
import type { Db, Row } from "./db.ts";
import { toJsonText } from "./json.ts";

export interface ConversationKey {
  source: MessageSource;
  workspaceId: string;
  channelId: string;
  threadId: string;
}

// The statuses are part of the contract (clients read them); the store uses the same ones.
export { conversationStatusSchema, sessionStateSchema };
export type { ConversationStatus, SessionState };

/** Final states a message can be settled into. */
export type SettledStatus = Exclude<ConversationStatus, "new" | "waiting">;

const conversationRow = z.object({
  id: z.string(),
  source: messageSourceSchema,
  workspace_id: z.string(),
  channel_id: z.string(),
  thread_id: z.string(),
  agent_session_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  agent_version: z.number().int().nullable(),
  status: conversationStatusSchema,
  session_state: sessionStateSchema,
  waiting_since: z.date().nullable(),
  agent_event_cursor: z.string().nullable(),
});

export interface Conversation {
  id: string;
  key: ConversationKey;
  agentSessionId: string | null;
  agentId: string | null;
  agentVersion: number | null;
  status: ConversationStatus;
  sessionState: SessionState;
  waitingSince: Date | null;
  /** The last agent runtime event already handled. */
  agentEventCursor: string | null;
}

function toConversation(row: Row): Conversation {
  const r = conversationRow.parse(row);
  return {
    id: r.id,
    key: {
      source: r.source,
      workspaceId: r.workspace_id,
      channelId: r.channel_id,
      threadId: r.thread_id,
    },
    agentSessionId: r.agent_session_id,
    agentId: r.agent_id,
    agentVersion: r.agent_version,
    status: r.status,
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

const conversationColumns =
  "id, source, workspace_id, channel_id, thread_id, agent_session_id, agent_id, agent_version, status, session_state, waiting_since, agent_event_cursor";

/** The database's clock. Cutoffs are taken from it so they compare with stored timestamps. */
export async function databaseNow(db: Db): Promise<Date> {
  return z.object({ now: z.date() }).parse(one(await db.query("select now() as now"))).now;
}

// ---------------------------------------------------------------------------------------
// Conversations

/** Returns the conversation for a thread, creating it on first use. Safe to race. */
export async function findOrCreateConversation(
  db: Db,
  key: ConversationKey,
): Promise<Conversation> {
  const rows = await db.query(
    `insert into conversations (source, workspace_id, channel_id, thread_id)
     values ($1, $2, $3, $4)
     on conflict (source, workspace_id, channel_id, thread_id)
       do update set updated_at = conversations.updated_at
     returning ${conversationColumns}`,
    [key.source, key.workspaceId, key.channelId, key.threadId],
  );
  return toConversation(one(rows));
}

export async function getConversation(db: Db, id: string): Promise<Conversation> {
  const rows = await db.query(`select ${conversationColumns} from conversations where id = $1`, [
    id,
  ]);
  return toConversation(one(rows));
}

/** Reads a conversation and locks it until the surrounding transaction ends. */
export async function lockConversation(tx: Db, id: string): Promise<Conversation> {
  const rows = await tx.query(
    `select ${conversationColumns} from conversations where id = $1 for update`,
    [id],
  );
  return toConversation(one(rows));
}

/** The conversation for a thread, if there is one (never creates it). */
export async function findConversationByKey(
  db: Db,
  key: ConversationKey,
): Promise<Conversation | undefined> {
  const rows = await db.query(
    `select ${conversationColumns} from conversations
     where source = $1 and workspace_id = $2 and channel_id = $3 and thread_id = $4`,
    [key.source, key.workspaceId, key.channelId, key.threadId],
  );
  return rows[0] === undefined ? undefined : toConversation(rows[0]);
}

/** The conversation one of its inbound messages belongs to, if the message is known. */
export async function findConversationByMessage(
  db: Db,
  message: { source: MessageSource; workspaceId: string; channelId: string; messageId: string },
): Promise<Conversation | undefined> {
  const rows = await db.query(
    `select ${conversationColumns
      .split(", ")
      .map((c) => `c.${c}`)
      .join(", ")}
     from conversations c join inbound_messages m on m.conversation_id = c.id
     where m.source = $1 and m.workspace_id = $2 and m.channel_id = $3 and m.message_id = $4`,
    [message.source, message.workspaceId, message.channelId, message.messageId],
  );
  return rows[0] === undefined ? undefined : toConversation(rows[0]);
}

export async function findConversationBySession(
  db: Db,
  agentSessionId: string,
): Promise<Conversation | undefined> {
  const rows = await db.query(
    `select ${conversationColumns} from conversations where agent_session_id = $1`,
    [agentSessionId],
  );
  return rows[0] === undefined ? undefined : toConversation(rows[0]);
}

/** Marks a conversation as waiting on the agent, keeping the time it first started waiting. */
export async function markWaiting(db: Db, conversationId: string): Promise<void> {
  await db.query(
    `update conversations
     set status = 'waiting',
         waiting_since = case when status = 'waiting' then waiting_since else now() end,
         updated_at = now()
     where id = $1`,
    [conversationId],
  );
}

export async function setSessionState(
  db: Db,
  conversationId: string,
  state: SessionState,
): Promise<void> {
  await db.query(`update conversations set session_state = $2, updated_at = now() where id = $1`, [
    conversationId,
    state,
  ]);
}

/** Records the last agent event handled. Only the sync lease holder writes it. */
export async function setAgentEventCursor(
  db: Db,
  conversationId: string,
  eventId: string,
): Promise<void> {
  await db.query(
    `update conversations set agent_event_cursor = $2, updated_at = now() where id = $1`,
    [conversationId, eventId],
  );
}

/** A sync that has not finished after this long is assumed dead; another may take over. */
export const SYNC_LEASE_SECONDS = 120;

/** Proof of holding a conversation's sync lease: only its holder can renew or release it. */
export interface SyncLease {
  conversationId: string;
  owner: string;
}

/**
 * Takes the right to sync a conversation, so a webhook and reconcile never sync the same
 * conversation at once. Returns undefined if someone else holds it. Each claim gets a new
 * owner, so a sync that outlived its lease cannot release or renew the next holder's.
 */
export async function claimSyncLease(
  db: Db,
  conversationId: string,
): Promise<SyncLease | undefined> {
  const rows = await db.query(
    `update conversations
     set sync_lease_until = now() + make_interval(secs => $2),
         sync_lease_owner = gen_random_uuid()
     where id = $1 and (sync_lease_until is null or sync_lease_until < now())
     returning sync_lease_owner::text as owner`,
    [conversationId, SYNC_LEASE_SECONDS],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return { conversationId, owner: z.object({ owner: z.string() }).parse(row).owner };
}

/** Extends the lease. False if it is no longer this holder's (it expired and was taken). */
export async function renewSyncLease(db: Db, lease: SyncLease): Promise<boolean> {
  const rows = await db.query(
    `update conversations set sync_lease_until = now() + make_interval(secs => $3)
     where id = $1 and sync_lease_owner = $2::uuid and sync_lease_until >= now()
     returning id`,
    [lease.conversationId, lease.owner, SYNC_LEASE_SECONDS],
  );
  return rows.length > 0;
}

/** Releases the lease, unless another sync has taken it since. */
export async function releaseSyncLease(db: Db, lease: SyncLease): Promise<void> {
  await db.query(
    `update conversations set sync_lease_until = null, sync_lease_owner = null
     where id = $1 and sync_lease_owner = $2::uuid`,
    [lease.conversationId, lease.owner],
  );
}

// ---------------------------------------------------------------------------------------
// Agent sessions

/** Marks a session as being started; never a real session id. */
export const STARTING_PREFIX = "starting:";
/** A session start not finished after this long is assumed lost (above the runtime's retries). */
const STALE_START_SECONDS = 180;

/** The conversation's agent session id, or undefined if none has started yet. */
export function sessionIdOf(conversation: Conversation): string | undefined {
  const id = conversation.agentSessionId;
  return id === null || id.startsWith(STARTING_PREFIX) ? undefined : id;
}

/**
 * Claims the right to start the conversation's agent session, so two first messages in one
 * thread start one session. Returns a claim token, or undefined if a session exists or another
 * start is under way. The claim is committed before the agent is called.
 */
export async function claimSessionStart(
  db: Db,
  conversationId: string,
): Promise<string | undefined> {
  const rows = await db.query(
    `update conversations
     set agent_session_id = $2 || gen_random_uuid()::text, updated_at = now()
     where id = $1
       and (agent_session_id is null
            or (agent_session_id like $3 and updated_at < now() - make_interval(secs => $4)))
     returning agent_session_id`,
    [conversationId, STARTING_PREFIX, `${STARTING_PREFIX}%`, STALE_START_SECONDS],
  );
  return rows[0] === undefined ? undefined : z.string().parse(rows[0].agent_session_id);
}

/** Gives up a claimed session start, so the next message can try again. */
export async function releaseSessionStart(
  db: Db,
  conversationId: string,
  claim: string,
): Promise<void> {
  await db.query(
    `update conversations set agent_session_id = null, updated_at = now()
     where id = $1 and agent_session_id = $2`,
    [conversationId, claim],
  );
}

const agentKindRow = z.object({ agent_kind: z.enum(["engineer", "product"]).nullable() });

/** The agent a conversation was given; null (every thread from before part E3) is the engineer. */
export async function readAgentKind(
  db: Db,
  conversationId: string,
): Promise<"engineer" | "product"> {
  const rows = await db.query(`select agent_kind from conversations where id = $1`, [
    conversationId,
  ]);
  const row = rows[0];
  return row === undefined ? "engineer" : (agentKindRow.parse(row).agent_kind ?? "engineer");
}

/**
 * The agent that runs the conversation's sessions (decisions 153, 167), stored on the
 * conversation the first time a session is started for it, and kept from then on. A thread
 * gets the product agent when the sender of its first message is a product manager or a
 * designer in `actor_roles` (exact source, workspace and person); everyone else, and anyone
 * with no role, gets the engineer. A conversation that had a session before this was stored
 * keeps null, which is the engineer. Called by the holder of the session start claim.
 */
export async function chooseAgentKind(db: Db, conversationId: string): Promise<AgentKind> {
  const rows = await db.query(
    `update conversations c
     set agent_kind = coalesce(
       c.agent_kind,
       case when c.agent_id is null then (
         select case when (select r.role from actor_roles r
                           where r.source = m.source
                             and r.workspace_id = m.workspace_id
                             and r.actor_id = m.actor_id) in ('product_manager', 'designer')
                     then 'product' else 'engineer' end
         from inbound_messages m
         where m.conversation_id = c.id
         order by m.sent_at, m.created_at, m.id
         limit 1
       ) end)
     where c.id = $1
     returning c.agent_kind`,
    [conversationId],
  );
  return agentKindRow.parse(one(rows)).agent_kind ?? "engineer";
}

/**
 * Attaches a started session, if the start claim is still ours. Returns false if the claim
 * was taken over meanwhile: the caller then uses the session that was attached instead.
 */
export async function attachSession(
  db: Db,
  conversationId: string,
  claim: string,
  session: { sessionId: string; agentId: string; agentVersion: number },
): Promise<boolean> {
  const rows = await db.query(
    `update conversations
     set agent_session_id = $3, agent_id = $4, agent_version = $5, session_state = 'active',
         updated_at = now()
     where id = $1 and agent_session_id = $2
     returning id`,
    [conversationId, claim, session.sessionId, session.agentId, session.agentVersion],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------------------
// Inbound messages

export interface RecordedInbound {
  id: string;
  /** True when this message was already recorded (a retry, or the same message twice). */
  duplicate: boolean;
  /** True when the message has already been handed to the agent. */
  forwarded: boolean;
}

/** Records an inbound message once. A repeat returns the first record with `duplicate: true`. */
export async function recordInbound(
  db: Db,
  conversationId: string,
  message: InboundMessage,
): Promise<RecordedInbound> {
  const { conversation } = message;
  const inserted = await db.query(
    `insert into inbound_messages
       (conversation_id, source, source_event_id, workspace_id, channel_id, message_id,
        actor_id, text, sent_at, actor_name)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict do nothing
     returning id`,
    [
      conversationId,
      message.source,
      message.sourceEventId,
      conversation.workspaceId,
      conversation.channelId,
      conversation.messageId,
      message.actor.id,
      message.text,
      message.sentAt,
      message.actor.displayName ?? null,
    ],
  );
  if (inserted[0] !== undefined) {
    return { id: z.string().parse(inserted[0].id), duplicate: false, forwarded: false };
  }
  const existing = await db.query(
    `select id, forwarded_at from inbound_messages
     where source = $1
       and (source_event_id = $2
            or (workspace_id = $3 and channel_id = $4 and message_id = $5))
     limit 1`,
    [
      message.source,
      message.sourceEventId,
      conversation.workspaceId,
      conversation.channelId,
      conversation.messageId,
    ],
  );
  const row = z.object({ id: z.string(), forwarded_at: z.date().nullable() }).parse(one(existing));
  return { id: row.id, duplicate: true, forwarded: row.forwarded_at !== null };
}

/** The number of messages in the conversation still waiting for an outcome. */
export async function pendingMessageCount(db: Db, conversationId: string): Promise<number> {
  const rows = await db.query(
    `select count(*)::int as n from inbound_messages
     where conversation_id = $1 and status = 'received'`,
    [conversationId],
  );
  return z.object({ n: z.number().int() }).parse(one(rows)).n;
}

/** Whether an inbound message is still waiting for an outcome (not stopped meanwhile). */
export async function isStillPending(db: Db, inboundId: string): Promise<boolean> {
  const rows = await db.query(`select status from inbound_messages where id = $1`, [inboundId]);
  return z.object({ status: z.string() }).parse(one(rows)).status === "received";
}

/** Marks an inbound message as handed to the agent, with the event id the runtime gave it. */
export async function markForwarded(
  db: Db,
  inboundId: string,
  agentEventId: string | undefined,
): Promise<void> {
  await db.query(
    `update inbound_messages
     set forwarded_at = coalesce(forwarded_at, now()), agent_event_id = coalesce($2, agent_event_id)
     where id = $1`,
    [inboundId, agentEventId ?? null],
  );
}

/** Counts a failed hand-over to the agent. Returns the number of failures so far. */
export async function recordForwardFailure(db: Db, inboundId: string): Promise<number> {
  const rows = await db.query(
    `update inbound_messages set forward_attempts = forward_attempts + 1 where id = $1
     returning forward_attempts`,
    [inboundId],
  );
  return z.object({ forward_attempts: z.number().int() }).parse(one(rows)).forward_attempts;
}

export interface PendingForward {
  id: string;
  actorId: string;
  actorName: string | undefined;
  text: string;
}

/** Messages recorded but not yet handed to the agent, older than `olderThanSeconds`. */
export async function pendingForwards(
  db: Db,
  conversationId: string,
  olderThanSeconds: number,
): Promise<PendingForward[]> {
  const rows = await db.query(
    `select id, actor_id, actor_name, text from inbound_messages
     where conversation_id = $1 and forwarded_at is null and status = 'received'
       and created_at < now() - make_interval(secs => $2)
     order by created_at`,
    [conversationId, olderThanSeconds],
  );
  return rows.map((row) => {
    const r = z
      .object({
        id: z.string(),
        actor_id: z.string(),
        actor_name: z.string().nullable(),
        text: z.string(),
      })
      .parse(row);
    return { id: r.id, actorId: r.actor_id, actorName: r.actor_name ?? undefined, text: r.text };
  });
}

/**
 * Which pending messages to settle. The first three are the thread's own session's: they
 * leave out messages that led to a brief, which a coding worker's turn settles instead
 * (slice 2.1, decision 184).
 */
export type Settlement =
  /** Messages whose agent events are listed: the agent processed them. */
  | { kind: "agent_events"; ids: string[] }
  /** Messages handed to the agent at or before `cutoff`, with no agent event id recorded. */
  | { kind: "forwarded_without_event"; cutoff: Date }
  /** Every message handed to the agent (the session can take no more). */
  | { kind: "all_forwarded" }
  /** Every pending message, handed over or not (a stop). */
  | { kind: "all_pending" }
  /** Specific inbound messages, by their id here. */
  | { kind: "inbound"; ids: string[] }
  /** Messages that led to briefs the worker has processed, by the briefs' worker event ids. */
  | { kind: "briefs"; workerEventIds: string[] }
  /** Messages that led to any brief of this change already handed to its worker. */
  | { kind: "handed_over"; changeId: string }
  /** Every message that led to a brief of this change (its worker can do no more). */
  | { kind: "change"; changeId: string };

/**
 * Settles the selected pending messages. The conversation stays waiting while any message
 * remains pending, with its waiting time reset to the oldest of them, so a busy thread is
 * never cut off by the time limit of an earlier turn. A conversation already settled is not
 * changed by a later answer (a "stopped" is never turned into "answered"). Returns the settled
 * messages' ids in the source system, oldest first, so their status can be shown there.
 */
export async function settleMessages(
  db: Db,
  conversationId: string,
  status: SettledStatus,
  settlement: Settlement,
): Promise<string[]> {
  return db.transaction(async (tx) => {
    await lockConversation(tx, conversationId);
    const where = {
      agent_events: "agent_event_id = any($3::text[]) and change_brief_id is null",
      forwarded_without_event:
        "agent_event_id is null and forwarded_at is not null and forwarded_at <= $3 " +
        "and change_brief_id is null",
      all_forwarded: "forwarded_at is not null and change_brief_id is null",
      all_pending: "true",
      inbound: "id = any($3::uuid[])",
      briefs:
        "change_brief_id in (select id from change_briefs where worker_event_id = any($3::text[]))",
      handed_over:
        "change_brief_id in (select id from change_briefs " +
        "where change_id = $3::uuid and worker_event_id is not null)",
      change: "change_brief_id in (select id from change_briefs where change_id = $3::uuid)",
    }[settlement.kind];
    const params: unknown[] = [conversationId, status];
    if (settlement.kind === "agent_events" || settlement.kind === "inbound") {
      params.push(settlement.ids);
    } else if (settlement.kind === "forwarded_without_event") {
      params.push(settlement.cutoff);
    } else if (settlement.kind === "briefs") {
      params.push(settlement.workerEventIds);
    } else if (settlement.kind === "change" || settlement.kind === "handed_over") {
      params.push(settlement.changeId);
    }
    const settled = await tx.query(
      `update inbound_messages set status = $2
       where conversation_id = $1 and status = 'received' and ${where}
       returning message_id, sent_at`,
      params,
    );
    // The thread waits on its own session only for messages that led to no brief: a coding
    // worker keeps its own clock (decision 184).
    await tx.query(
      `update conversations c
       set status = case when p.oldest is null then $2 else 'waiting' end,
           waiting_since = p.oldest,
           updated_at = now()
       from (select min(coalesce(forwarded_at, created_at)) as oldest from inbound_messages
             where conversation_id = $1 and status = 'received'
               and change_brief_id is null) p
       where c.id = $1 and c.status in ('new', 'waiting')`,
      [conversationId, status],
    );
    return settled
      .map((row) => z.object({ message_id: z.string(), sent_at: z.date() }).parse(row))
      .sort((a, b) => a.sent_at.getTime() - b.sent_at.getTime())
      .map((row) => row.message_id);
  });
}

// ---------------------------------------------------------------------------------------
// Deliveries

export type DeliveryKind = "reply" | "note" | "status";

/** Deliveries are given up (abandoned) after this many failed attempts. */
export const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Queues one delivery under a key that makes it unique in the conversation (for a reply, the
 * agent event id). Queuing the same key again does nothing, so a reply is queued once.
 */
export async function enqueueDelivery(
  db: Db,
  conversationId: string,
  key: string,
  kind: DeliveryKind,
  payload: OutboundDelivery,
): Promise<void> {
  await db.query(
    // Rows from before the payload was cast from text hold a JSON string, and are read both
    // ways (decision 90).
    `insert into deliveries (conversation_id, agent_event_id, kind, payload)
     values ($1, $2, $3, $4::text::jsonb)
     on conflict (conversation_id, agent_event_id) do nothing`,
    [conversationId, key, kind, toJsonText(payload)],
  );
}

export interface QueuedDelivery {
  id: string;
  key: string;
  attempts: number;
  payload: OutboundDelivery;
}

/** Deliveries still to send, in the order they were queued. */
export async function unsentDeliveries(db: Db, conversationId: string): Promise<QueuedDelivery[]> {
  const rows = await db.query(
    `select id, agent_event_id, attempts, payload from deliveries
     where conversation_id = $1 and status in ('pending', 'sending', 'failed')
     order by seq`,
    [conversationId],
  );
  return rows.map((row) => {
    const r = z
      .object({
        id: z.string(),
        agent_event_id: z.string(),
        attempts: z.number().int(),
        payload: z.unknown(),
      })
      .parse(row);
    const payload = typeof r.payload === "string" ? (JSON.parse(r.payload) as unknown) : r.payload;
    return {
      id: r.id,
      key: r.agent_event_id,
      attempts: r.attempts,
      payload: outboundDeliverySchema.parse(payload),
    };
  });
}

export async function markDeliverySent(db: Db, deliveryId: string): Promise<void> {
  await db.query(
    `update deliveries set status = 'sent', last_error = null, updated_at = now() where id = $1`,
    [deliveryId],
  );
}

/**
 * Records a failed attempt. Returns true if the delivery has now used up its attempts and is
 * abandoned: it will not be tried again.
 */
export async function markDeliveryFailed(
  db: Db,
  deliveryId: string,
  error: string,
): Promise<boolean> {
  const rows = await db.query(
    `update deliveries
     set attempts = attempts + 1,
         status = case when attempts + 1 >= $3 then 'abandoned' else 'failed' end,
         last_error = $2, updated_at = now()
     where id = $1
     returning status`,
    [deliveryId, error.slice(0, 1000), MAX_DELIVERY_ATTEMPTS],
  );
  return z.object({ status: z.string() }).parse(one(rows)).status === "abandoned";
}

// ---------------------------------------------------------------------------------------
// Reconcile

/**
 * Conversations the reconcile job should look at: waiting on the agent for longer than
 * `waitingForSeconds`, with a message never handed to the agent after that long, or with
 * deliveries still to send. Least recently touched first, so none is starved; conversations
 * being synced right now are skipped.
 */
export async function conversationsToReconcile(
  db: Db,
  options: { waitingForSeconds: number; limit: number },
): Promise<Conversation[]> {
  const rows = await db.query(
    `select ${conversationColumns} from conversations c
     where (c.sync_lease_until is null or c.sync_lease_until < now())
       and ((c.status = 'waiting' and c.waiting_since < now() - make_interval(secs => $1))
            or exists (select 1 from inbound_messages m
                       where m.conversation_id = c.id and m.forwarded_at is null
                         and m.status = 'received'
                         and m.created_at < now() - make_interval(secs => $1))
            or exists (select 1 from deliveries d
                       where d.conversation_id = c.id
                         and d.status in ('pending', 'sending', 'failed')))
     order by c.updated_at
     limit $2`,
    [options.waitingForSeconds, options.limit],
  );
  return rows.map(toConversation);
}
