import { z } from "zod";

/** Header that carries one id through every log line for a single inbound event. */
export const CORRELATION_ID_HEADER = "x-correlation-id";

/** Where a message came from. The API knows sources, never source-specific rules. */
export const messageSourceSchema = z.enum(["slack", "ui"]);
export type MessageSource = z.infer<typeof messageSourceSchema>;

const id = z.string().min(1).max(255);

/**
 * One message arriving at the API from any channel.
 *
 * Request body of `POST /v1/messages`.
 */
export const inboundMessageSchema = z.strictObject({
  source: messageSourceSchema,
  /** The source's own id for this delivery (Slack: `event_id`). Also the correlation id. */
  sourceEventId: id,
  conversation: z.strictObject({
    /** Slack: team id. */
    workspaceId: id,
    /** Slack: channel id. */
    channelId: id,
    /**
     * Always present. Slack: the parent message's `thread_ts`, or the message's own `ts`
     * for a top-level message.
     */
    threadId: id,
    /** Identifies the message within its channel (Slack: `ts`). */
    messageId: id,
  }),
  actor: z.strictObject({
    /** The sender's id in the source system (Slack: user id). */
    id,
    /** How the sender is called, when the source could tell (Slack: display name). */
    displayName: z.string().min(1).max(255).optional(),
  }),
  /** Message text, with the bot's own mention removed. May be empty. */
  text: z.string().max(40_000),
  /** When the message was sent, as an ISO 8601 timestamp. */
  sentAt: z.iso.datetime({ offset: true }),
});
export type InboundMessage = z.infer<typeof inboundMessageSchema>;

/** Response body of `POST /v1/messages` (status 202). */
export const acceptedMessageSchema = z.strictObject({
  id: z.uuid(),
  status: z.literal("accepted"),
  /** True when this message had already been received; nothing new was done. */
  duplicate: z.boolean().optional(),
});
export type AcceptedMessage = z.infer<typeof acceptedMessageSchema>;

/**
 * A request to stop the agent in a conversation (decision 60). Body of `POST /v1/stop`.
 * Names the conversation by its thread, or by one of its messages (for Slack: the message a
 * 🛑 reaction was put on).
 */
export const stopRequestSchema = z.strictObject({
  source: messageSourceSchema,
  /** The source's id for this delivery; also the correlation id. */
  sourceEventId: id,
  workspaceId: id,
  channelId: id,
  threadId: id.optional(),
  /** A message in the conversation; required when `threadId` is not given. */
  messageId: id.optional(),
  /** The stop message itself, when the stop was a message: it is settled as stopped too. */
  stopMessage: z
    .strictObject({ messageId: id, sentAt: z.iso.datetime({ offset: true }) })
    .optional(),
  actor: z.strictObject({ id }),
});
export type StopRequest = z.infer<typeof stopRequestSchema>;

/** Response body of `POST /v1/stop` (status 202). */
export const stopResultSchema = z.strictObject({
  status: z.enum(["stopped", "nothing_to_stop", "unknown_conversation"]),
});
export type StopResult = z.infer<typeof stopResultSchema>;
