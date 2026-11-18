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
});

export interface Conversation {
  id: string;
  key: ConversationKey;
  agentSessionId: string | null;
  agentId: string | null;
  agentVersion: number | null;
  status: ConversationStatus;
  waitingSince: Date | null;
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
  };
}

function one(rows: Row[]): Row {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

const conversationColumns =
  "id, source, workspace_id, channel_id, thread_id, agent_session_id, agent_id, agent_version, status, waiting_since";

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
    return { id: z.string().parse(inserted[0].id), duplicate: false };
  }
  const existing = await db.query(
    `select id from inbound_messages
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
  return { id: z.string().parse(one(existing).id), duplicate: true };
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
 * Settles a conversation and every message still pending in it. Returns the settled messages'
 * ids in the source system, so their status can be shown there (for Slack: reactions).
 */
export async function settleConversation(
  db: Db,
  conversationId: string,
  status: SettledStatus,
): Promise<string[]> {
  await db.query(
    `update conversations set status = $2, waiting_since = null, updated_at = now() where id = $1`,
    [conversationId, status],
  );
  const rows = await db.query(
    `update inbound_messages set status = $2
     where conversation_id = $1 and status = 'received'
     returning message_id, sent_at`,
    [conversationId, status],
  );
  return rows
    .map((row) => z.object({ message_id: z.string(), sent_at: z.date() }).parse(row))
    .sort((a, b) => a.sent_at.getTime() - b.sent_at.getTime())
    .map((row) => row.message_id);
}

export type DeliveryKind = "reply" | "failure" | "stopped";

/** Deliveries are given up after this many attempts. */
export const MAX_DELIVERY_ATTEMPTS = 5;

/** A delivery stuck in "sending" this long is assumed lost and may be claimed again. */
const STALE_SENDING = "2 minutes";

/**
 * Claims the right to send one delivery. Returns its id if this caller should send it now:
 * the first time, after a failed attempt, or when an earlier attempt went silent. Returns
 * undefined if it was sent or is being sent by someone else, so it goes out exactly once.
 */
export async function claimDelivery(
  db: Db,
  conversationId: string,
  agentEventId: string,
  kind: DeliveryKind,
): Promise<string | undefined> {
  const rows = await db.query(
    `insert into deliveries (conversation_id, agent_event_id, kind)
     values ($1, $2, $3)
     on conflict (conversation_id, agent_event_id) do update
       set status = 'sending', attempts = deliveries.attempts + 1, updated_at = now()
       where deliveries.attempts < $4
         and (deliveries.status = 'failed'
              or (deliveries.status = 'sending'
                  and deliveries.updated_at < now() - interval '${STALE_SENDING}'))
     returning id`,
    [conversationId, agentEventId, kind, MAX_DELIVERY_ATTEMPTS],
  );
  return rows[0] === undefined ? undefined : z.string().parse(rows[0].id);
}

export async function finishDelivery(
  db: Db,
  deliveryId: string,
  outcome: { ok: true } | { ok: false; error: string },
): Promise<void> {
  await db.query(
    `update deliveries set status = $2, last_error = $3, updated_at = now() where id = $1`,
    [deliveryId, outcome.ok ? "sent" : "failed", outcome.ok ? null : outcome.error.slice(0, 1000)],
  );
}

/**
 * Conversations the reconcile job should look at: waiting on the agent for longer than
 * `waitingForSeconds`, or with a failed delivery that still has attempts left. Oldest first.
 */
export async function conversationsToReconcile(
  db: Db,
  options: { waitingForSeconds: number; limit: number },
): Promise<Conversation[]> {
  const rows = await db.query(
    `select ${conversationColumns} from conversations c
     where (c.status = 'waiting' and c.waiting_since < now() - make_interval(secs => $1))
        or exists (select 1 from deliveries d
                   where d.conversation_id = c.id and d.status = 'failed' and d.attempts < $3)
     order by c.waiting_since nulls last
     limit $2`,
    [options.waitingForSeconds, options.limit, MAX_DELIVERY_ATTEMPTS],
  );
  return rows.map(toConversation);
}
