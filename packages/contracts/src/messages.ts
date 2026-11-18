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
});
export type AcceptedMessage = z.infer<typeof acceptedMessageSchema>;
