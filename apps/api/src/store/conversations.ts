import { messageSourceSchema, type InboundMessage, type MessageSource } from "@hippidy/contracts";
import { z } from "zod";
import type { Db, Row } from "./db.ts";

export interface ConversationKey {
  source: MessageSource;
  workspaceId: string;
  channelId: string;
  threadId: string;
}

export const conversationStatusSchema = z.enum(["new", "waiting", "answered", "failed", "stopped"]);
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;

/** Final states a conversation's pending messages can be settled into. */
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
  "id, source, workspace_id, channel_id, thread_id, agent_session_id, agent_id, agent_version, status, waiting_since, agent_event_cursor";

/** The database's clock. Cutoffs are taken from it so they compare with stored timestamps. */
export async function databaseNow(db: Db): Promise<Date> {
  return z.object({ now: z.date() }).parse(one(await db.query("select now() as now"))).now;
}

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

/** Reads a conversation and locks it until the surrounding transaction ends. */
export async function lockConversation(tx: Db, id: string): Promise<Conversation> {
  const rows = await tx.query(
    `select ${conversationColumns} from conversations where id = $1 for update`,
    [id],
  );
  return toConversation(one(rows));
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

export interface RecordedInbound {
  id: string;
  /** True when this message was already recorded (a retry, or the same message twice). */
  duplicate: boolean;
  /** True when the message has already been handed to the agent. */
  forwarded: boolean;
}

/** Marks an inbound message as handed to the agent. */
export async function markForwarded(db: Db, inboundId: string): Promise<void> {
  await db.query(
    `update inbound_messages set forwarded_at = coalesce(forwarded_at, now()) where id = $1`,
    [inboundId],
  );
}

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
        actor_id, text, sent_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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

/** Marks a session as being started; never a real session id. */
const STARTING_PREFIX = "starting:";
/** A session start that has not finished after this long is assumed lost. */
const STALE_START_SECONDS = 60;

/** The conversation's agent session id, or undefined if none has started yet. */
export function sessionIdOf(conversation: Conversation): string | undefined {
  const id = conversation.agentSessionId;
  return id === null || id.startsWith(STARTING_PREFIX) ? undefined : id;
}

/**
 * Claims the right to start the conversation's agent session, so two first messages in one
 * thread start one session. Returns false if a session exists or another start is under way.
 * The claim is committed before the agent is called: no transaction stays open meanwhile.
 */
export async function claimSessionStart(db: Db, conversationId: string): Promise<boolean> {
  const rows = await db.query(
    `update conversations
     set agent_session_id = $2 || gen_random_uuid()::text, updated_at = now()
     where id = $1
       and (agent_session_id is null
            or (agent_session_id like $3 and updated_at < now() - make_interval(secs => $4)))
     returning id`,
    [conversationId, STARTING_PREFIX, `${STARTING_PREFIX}%`, STALE_START_SECONDS],
  );
  return rows.length > 0;
}

/** Gives up a claimed session start, so the next message can try again. */
export async function releaseSessionStart(db: Db, conversationId: string): Promise<void> {
  await db.query(
    `update conversations set agent_session_id = null, updated_at = now()
     where id = $1 and agent_session_id like $2`,
    [conversationId, `${STARTING_PREFIX}%`],
  );
}

export async function getConversation(db: Db, id: string): Promise<Conversation> {
  const rows = await db.query(`select ${conversationColumns} from conversations where id = $1`, [
    id,
  ]);
  return toConversation(one(rows));
}

export interface PendingForward {
  id: string;
  actorId: string;
  text: string;
}

/** Messages recorded but not yet handed to the agent, older than `olderThanSeconds`. */
export async function pendingForwards(
  db: Db,
  conversationId: string,
  olderThanSeconds: number,
): Promise<PendingForward[]> {
  const rows = await db.query(
    `select id, actor_id, text from inbound_messages
     where conversation_id = $1 and forwarded_at is null and status = 'received'
       and created_at < now() - make_interval(secs => $2)
     order by created_at`,
    [conversationId, olderThanSeconds],
  );
  return rows.map((row) => {
    const r = z.object({ id: z.string(), actor_id: z.string(), text: z.string() }).parse(row);
    return { id: r.id, actorId: r.actor_id, text: r.text };
  });
}

export async function attachSession(
  db: Db,
  conversationId: string,
  session: { sessionId: string; agentId: string; agentVersion: number },
): Promise<void> {
  await db.query(
    `update conversations
     set agent_session_id = $2, agent_id = $3, agent_version = $4, updated_at = now()
     where id = $1`,
    [conversationId, session.sessionId, session.agentId, session.agentVersion],
  );
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

/**
 * Settles the pending messages the agent has dealt with: those handed to it no later than
 * `forwardedBefore`, a time from `databaseNow` taken before the agent's state was read.
 * Messages handed over later stay pending, and so does the conversation while any remain.
 * A conversation already settled is not changed (a "stopped" is never turned into "answered").
 * Returns the settled messages' ids in the source system, oldest first, so their status can
 * be shown there (for Slack: reactions).
 */
export async function settleConversation(
  db: Db,
  conversationId: string,
  status: SettledStatus,
  options: { forwardedBefore: Date },
): Promise<string[]> {
  return db.transaction(async (tx) => {
    await lockConversation(tx, conversationId);
    const settled = await tx.query(
      `update inbound_messages set status = $2
       where conversation_id = $1 and status = 'received'
         and forwarded_at is not null and forwarded_at <= $3
       returning message_id, sent_at`,
      [conversationId, status, options.forwardedBefore],
    );
    await tx.query(
      `update conversations c
       set status = case when p.oldest is null then $2 else 'waiting' end,
           waiting_since = case when p.oldest is null then null
                                else coalesce(c.waiting_since, p.oldest) end,
           updated_at = now()
       from (select min(created_at) as oldest from inbound_messages
             where conversation_id = $1 and status = 'received') p
       where c.id = $1 and c.status in ('new', 'waiting')`,
      [conversationId, status],
    );
    return settled
      .map((row) => z.object({ message_id: z.string(), sent_at: z.date() }).parse(row))
      .sort((a, b) => a.sent_at.getTime() - b.sent_at.getTime())
      .map((row) => row.message_id);
  });
}

export type DeliveryKind = "reply" | "failure" | "stopped";

/** Deliveries are given up after this many attempts. */
export const MAX_DELIVERY_ATTEMPTS = 5;

/** A delivery stuck in "sending" this long is assumed lost and may be claimed again. */
export const STALE_SENDING_SECONDS = 120;

/** The right to send one delivery, for one attempt. */
export interface DeliveryClaim {
  id: string;
  attempt: number;
}

/**
 * Claims the right to send one delivery. Returns a claim if this caller should send it now:
 * the first time, after a failed attempt, or when an earlier attempt went silent. Returns
 * undefined if it was sent, is being sent by someone else, or has used up its attempts.
 */
export async function claimDelivery(
  db: Db,
  conversationId: string,
  agentEventId: string,
  kind: DeliveryKind,
): Promise<DeliveryClaim | undefined> {
  const rows = await db.query(
    `insert into deliveries (conversation_id, agent_event_id, kind)
     values ($1, $2, $3)
     on conflict (conversation_id, agent_event_id) do update
       set status = 'sending', attempts = deliveries.attempts + 1, updated_at = now()
       where deliveries.attempts < $4
         and (deliveries.status = 'failed'
              or (deliveries.status = 'sending'
                  and deliveries.updated_at < now() - make_interval(secs => $5)))
     returning id, attempts`,
    [conversationId, agentEventId, kind, MAX_DELIVERY_ATTEMPTS, STALE_SENDING_SECONDS],
  );
  if (rows[0] === undefined) return undefined;
  const row = z.object({ id: z.string(), attempts: z.number().int() }).parse(rows[0]);
  return { id: row.id, attempt: row.attempts };
}

/**
 * Records how an attempt ended: sent, or failed with `error`. Only the latest attempt can
 * record: a slow attempt that was taken over cannot overwrite the result of its replacement.
 */
export async function finishDelivery(db: Db, claim: DeliveryClaim, error?: string): Promise<void> {
  await db.query(
    `update deliveries set status = $3, last_error = $4, updated_at = now()
     where id = $1 and attempts = $2 and status = 'sending'`,
    [
      claim.id,
      claim.attempt,
      error === undefined ? "sent" : "failed",
      error === undefined ? null : error.slice(0, 1000),
    ],
  );
}

/**
 * Conversations the reconcile job should look at: waiting on the agent for longer than
 * `waitingForSeconds`, with a message never handed to the agent after that long, or with a
 * delivery that failed or went silent and still has attempts left. Oldest first.
 */
export async function conversationsToReconcile(
  db: Db,
  options: { waitingForSeconds: number; limit: number },
): Promise<Conversation[]> {
  const rows = await db.query(
    `select ${conversationColumns} from conversations c
     where (c.status = 'waiting' and c.waiting_since < now() - make_interval(secs => $1))
        or exists (select 1 from inbound_messages m
                   where m.conversation_id = c.id and m.forwarded_at is null
                     and m.status = 'received'
                     and m.created_at < now() - make_interval(secs => $1))
        or exists (select 1 from deliveries d
                   where d.conversation_id = c.id and d.attempts < $3
                     and (d.status = 'failed'
                          or (d.status = 'sending'
                              and d.updated_at < now() - make_interval(secs => $4))))
     order by c.waiting_since nulls last
     limit $2`,
    [options.waitingForSeconds, options.limit, MAX_DELIVERY_ATTEMPTS, STALE_SENDING_SECONDS],
  );
  return rows.map(toConversation);
}
