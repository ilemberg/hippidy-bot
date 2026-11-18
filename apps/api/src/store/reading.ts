import {
  conversationStatusSchema,
  deliveryStatusSchema,
  messageSourceSchema,
  sessionStateSchema,
  type AgentEventView,
  type ConversationSummary,
  type TranscriptLine,
} from "@hippidy/contracts";
import { z } from "zod";
import { STARTING_PREFIX } from "./conversations.ts";
import type { Db, Row } from "./db.ts";

// Reading the record back (slice 3, decision 79). Everything here comes from the database
// alone: no agent runtime, no source system. Results are in the contract's own shapes.

// Counts are stored as bigint, which the production client returns as a string: they are
// read as float8, exact far beyond any count a session can reach.
const summaryColumns = `
  id, source, workspace_id, channel_id, thread_id, status, session_state,
  agent_session_id, agent_id, agent_version,
  usage_input_tokens::float8 as usage_input_tokens,
  usage_output_tokens::float8 as usage_output_tokens,
  usage_cache_read_tokens::float8 as usage_cache_read_tokens,
  usage_cache_creation_tokens::float8 as usage_cache_creation_tokens,
  usage_active_seconds,
  usage_list_cost_minor::float8 as usage_list_cost_minor,
  budget_list_cost_minor::float8 as budget_list_cost_minor,
  cost_currency, usage_updated_at, created_at, updated_at`;

const summaryRow = z.object({
  id: z.string(),
  source: messageSourceSchema,
  workspace_id: z.string(),
  channel_id: z.string(),
  thread_id: z.string(),
  status: conversationStatusSchema,
  session_state: sessionStateSchema,
  agent_session_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  agent_version: z.number().int().nullable(),
  usage_input_tokens: z.number().nullable(),
  usage_output_tokens: z.number().nullable(),
  usage_cache_read_tokens: z.number().nullable(),
  usage_cache_creation_tokens: z.number().nullable(),
  usage_active_seconds: z.number().nullable(),
  usage_list_cost_minor: z.number().nullable(),
  budget_list_cost_minor: z.number().nullable(),
  cost_currency: z.string().nullable(),
  usage_updated_at: z.date().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});

function toSummary(row: Row): ConversationSummary {
  const r = summaryRow.parse(row);
  const sessionId = r.agent_session_id;
  return {
    id: r.id,
    source: r.source,
    workspaceId: r.workspace_id,
    channelId: r.channel_id,
    threadId: r.thread_id,
    status: r.status,
    sessionState: r.session_state,
    // A session still being started is not a session yet.
    agent:
      sessionId === null || sessionId.startsWith(STARTING_PREFIX)
        ? null
        : { sessionId, agentId: r.agent_id, version: r.agent_version },
    usage: {
      inputTokens: r.usage_input_tokens,
      outputTokens: r.usage_output_tokens,
      cacheReadTokens: r.usage_cache_read_tokens,
      cacheCreationTokens: r.usage_cache_creation_tokens,
      activeSeconds: r.usage_active_seconds,
      listCostMinor: r.usage_list_cost_minor,
      budgetMinor: r.budget_list_cost_minor,
      currency: r.cost_currency,
      updatedAt: r.usage_updated_at === null ? null : r.usage_updated_at.toISOString(),
    },
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/**
 * Conversations, newest first. With `before` (a conversation's id), those older than it. An
 * id that names no conversation gives an empty page: callers check the id first.
 */
export async function listConversations(
  db: Db,
  options: { limit: number; before?: string | undefined },
): Promise<ConversationSummary[]> {
  const rows =
    options.before === undefined
      ? await db.query(
          `select ${summaryColumns} from conversations
           order by created_at desc, id desc limit $1`,
          [options.limit],
        )
      : await db.query(
          `select ${summaryColumns} from conversations
           where (created_at, id) < (select created_at, id from conversations where id = $2)
           order by created_at desc, id desc limit $1`,
          [options.limit, options.before],
        );
  return rows.map(toSummary);
}

/** One conversation, or undefined if there is none with that id. */
export async function readConversation(
  db: Db,
  id: string,
): Promise<ConversationSummary | undefined> {
  const rows = await db.query(`select ${summaryColumns} from conversations where id = $1`, [id]);
  return rows[0] === undefined ? undefined : toSummary(rows[0]);
}

const transcriptRow = z.object({
  role: z.enum(["user", "agent", "note"]),
  text: z.string().nullable(),
  occurred_at: z.date(),
  actor_id: z.string().nullable(),
  actor_name: z.string().nullable(),
  ref: z.string(),
  message_status: z.enum(["received", "answered", "failed", "stopped"]).nullable(),
  delivery_status: deliveryStatusSchema.nullable(),
});

/** The conversation as people saw it, oldest first. */
export async function readTranscript(db: Db, conversationId: string): Promise<TranscriptLine[]> {
  const rows = await db.query(
    `select role, text, occurred_at, actor_id, actor_name, ref, message_status, delivery_status
     from conversation_transcript
     where conversation_id = $1
     order by occurred_at, recorded_at, position`,
    [conversationId],
  );
  return rows.map((row): TranscriptLine => {
    const r = transcriptRow.parse(row);
    const text = r.text ?? "";
    const at = r.occurred_at.toISOString();
    switch (r.role) {
      case "user":
        return {
          role: "user",
          text,
          at,
          actor: {
            id: r.actor_id ?? "",
            ...(r.actor_name === null ? {} : { displayName: r.actor_name }),
          },
          messageId: r.ref,
          status: r.message_status ?? "received",
        };
      case "agent":
        return { role: "agent", text, at, eventId: r.ref, delivery: r.delivery_status };
      case "note":
        return { role: "note", text, at, delivery: r.delivery_status };
    }
  });
}

const eventRow = z.object({
  event_id: z.string(),
  type: z.string(),
  kind: z.string().nullable(),
  processed_at: z.date().nullable(),
  payload: z.unknown(),
  position: z.number().int(),
  updated_at: z.date(),
});

/**
 * The session's events as the runtime reported them, in the order they were stored. With
 * `after`, those stored after that position.
 */
export async function readAgentEvents(
  db: Db,
  conversationId: string,
  options: { limit: number; after?: number | undefined },
): Promise<AgentEventView[]> {
  const rows = await db.query(
    `select event_id, type, kind, processed_at, payload, seq::float8 as position, updated_at
     from agent_events
     where conversation_id = $1 and seq > $2
     order by seq limit $3`,
    [conversationId, options.after ?? 0, options.limit],
  );
  return rows.map((row) => {
    const r = eventRow.parse(row);
    return {
      id: r.event_id,
      type: r.type,
      kind: r.kind,
      processedAt: r.processed_at === null ? null : r.processed_at.toISOString(),
      payload: r.payload,
      position: r.position,
      updatedAt: r.updated_at.toISOString(),
    };
  });
}
