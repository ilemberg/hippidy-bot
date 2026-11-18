import { z } from "zod";
import { messageSourceSchema } from "./messages.ts";

// Reading the record: what a client (the future UI) gets back about conversations. All of
// it comes from the API's own database, never from the agent runtime at request time.

const timestamp = z.iso.datetime({ offset: true });
/** A conversation's id: any UUID the database accepts, whatever its version. */
const conversationId = z.guid();

/** Where a conversation stands: waiting on the agent, or how its last turn ended. */
export const conversationStatusSchema = z.enum(["new", "waiting", "answered", "failed", "stopped"]);
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;

/** Whether the conversation's agent session can still take messages. */
export const sessionStateSchema = z.enum(["active", "budget_reached", "terminated"]);
export type SessionState = z.infer<typeof sessionStateSchema>;

/**
 * What the conversation's agent session has used so far, as the agent runtime reported it.
 * A value is null when the runtime has not reported it (yet). Money is in minor units of
 * `currency`: cents for USD.
 */
export const conversationUsageSchema = z.strictObject({
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  cacheReadTokens: z.number().nullable(),
  cacheCreationTokens: z.number().nullable(),
  /** Seconds the session was running: what its runtime cost is priced on. */
  activeSeconds: z.number().nullable(),
  /** Cost so far at public list prices. */
  listCostMinor: z.number().nullable(),
  /** The session's spend ceiling. */
  budgetMinor: z.number().nullable(),
  currency: z.string().nullable(),
  /** When the figures were last read from the runtime. */
  updatedAt: timestamp.nullable(),
});
export type ConversationUsage = z.infer<typeof conversationUsageSchema>;

/** One conversation: a thread of work in its source, and the agent session behind it. */
export const conversationSummarySchema = z.strictObject({
  id: conversationId,
  source: messageSourceSchema,
  workspaceId: z.string(),
  channelId: z.string(),
  threadId: z.string(),
  status: conversationStatusSchema,
  sessionState: sessionStateSchema,
  /** The agent session, once one has started. The version is the one it was started with. */
  agent: z
    .strictObject({
      sessionId: z.string(),
      agentId: z.string().nullable(),
      version: z.number().int().nullable(),
    })
    .nullable(),
  usage: conversationUsageSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

/** Query of `GET /v1/conversations`. */
export const listConversationsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /**
   * The `next` of the page before: lists the conversations older than that one. An id that
   * names no conversation is an error, not an empty page.
   */
  before: conversationId.optional(),
});
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

/** Response of `GET /v1/conversations`: newest first. */
export const conversationListSchema = z.strictObject({
  conversations: z.array(conversationSummarySchema),
  /** Pass as `before` for the next page; null when this is the last one. */
  next: conversationId.nullable(),
});
export type ConversationList = z.infer<typeof conversationListSchema>;

/** Whether something the API sent back reached the source. Null: nothing was sent for it. */
export const deliveryStatusSchema = z.enum(["pending", "sending", "sent", "failed", "abandoned"]);
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;

/**
 * One line of a conversation as people saw it: what someone wrote, what the agent answered,
 * or a note the API posted itself (for example that the spending limit was reached).
 */
export const transcriptLineSchema = z.discriminatedUnion("role", [
  z.strictObject({
    role: z.literal("user"),
    text: z.string(),
    at: timestamp,
    actor: z.strictObject({ id: z.string(), displayName: z.string().optional() }),
    /** The message's id in its source (Slack: `ts`). */
    messageId: z.string(),
    /** How the message ended; `received` while it still waits for the agent. */
    status: z.enum(["received", "answered", "failed", "stopped"]),
  }),
  z.strictObject({
    role: z.literal("agent"),
    /** Markdown, as the agent wrote it. */
    text: z.string(),
    at: timestamp,
    /** The agent runtime's id for the event that carried this message. */
    eventId: z.string(),
    delivery: deliveryStatusSchema.nullable(),
  }),
  z.strictObject({
    role: z.literal("note"),
    text: z.string(),
    at: timestamp,
    delivery: deliveryStatusSchema.nullable(),
  }),
]);
export type TranscriptLine = z.infer<typeof transcriptLineSchema>;

/** Response of `GET /v1/conversations/:id`. The transcript is oldest first. */
export const conversationDetailSchema = z.strictObject({
  conversation: conversationSummarySchema,
  transcript: z.array(transcriptLineSchema),
});
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;

/**
 * One event of the conversation's agent session, as the agent runtime reported it. Most are
 * detail the transcript leaves out: tool use, thinking, model requests.
 */
export const agentEventSchema = z.strictObject({
  /** The runtime's own id for the event. */
  id: z.string(),
  /** The runtime's own name for it, for example `agent.message`. */
  type: z.string(),
  /** What the API made of it (`agent_message`, `idle`, ...); null if it was only recorded. */
  kind: z.string().nullable(),
  /** The runtime's clock. Null while a user message still waits in the session's queue. */
  processedAt: timestamp.nullable(),
  /** The event exactly as the runtime sent it. Its shape belongs to the runtime. */
  payload: z.unknown(),
  /**
   * The event's place in the order events were first stored, which is not always the order
   * they happened in: a message queued during a turn is stored before the rest of that turn.
   * Pass the last one as `after`.
   */
  position: z.number().int(),
  /**
   * When the stored event last changed. An event can change after it is first listed (a
   * queued user message gains its processed time), and paging with `after` does not return
   * it again.
   */
  updatedAt: timestamp,
});
export type AgentEventView = z.infer<typeof agentEventSchema>;

/** Query of `GET /v1/conversations/:id/events`. */
export const listAgentEventsQuerySchema = z.strictObject({
  /** Events carry their whole payload, which can be large: pages are small by default. */
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** The `next` of the page before: lists the events stored after that position. */
  after: z.coerce.number().int().min(0).optional(),
});
export type ListAgentEventsQuery = z.infer<typeof listAgentEventsQuerySchema>;

/** Response of `GET /v1/conversations/:id/events`: in the order the events were stored. */
export const agentEventListSchema = z.strictObject({
  events: z.array(agentEventSchema),
  /** Pass as `after` for the next page; null when this is the last one. */
  next: z.number().int().nullable(),
});
export type AgentEventList = z.infer<typeof agentEventListSchema>;
