import { z } from "zod";
import { messageSourceSchema } from "./messages.ts";

/** Where a delivery goes: the thread a conversation lives in, in its source system. */
export const deliveryTargetSchema = z.strictObject({
  source: messageSourceSchema,
  workspaceId: z.string().min(1),
  channelId: z.string().min(1),
  threadId: z.string().min(1),
});
export type DeliveryTarget = z.infer<typeof deliveryTargetSchema>;

/**
 * People the text mentions (slice 3.1): each is written `{@id}` in the text, and the source
 * turns it into its own mention (Slack: `<@id>`), so the person is told. Only the ids listed
 * here are turned into mentions; any other `{@…}` stays as text.
 */
const mentionsSchema = z
  .array(z.string().regex(/^[A-Z0-9]{2,40}$/))
  .max(10)
  .optional();

/** `{@id}`, the way a delivery's text marks a mention. */
export function mentionToken(actorId: string): string {
  return `{@${actorId}}`;
}

/**
 * Something the API sends back to a source (decision 53): a reply in the thread, a brief, or
 * the status of the messages it answered (for Slack: reactions).
 */
export const outboundDeliverySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("reply"),
    target: deliveryTargetSchema,
    /** Markdown. Each source converts it to its own format. */
    text: z.string().min(1),
    mentions: mentionsSchema,
  }),
  z.strictObject({
    /**
     * A brief for a coding worker (slice 2.1): posted in the thread before the worker gets it.
     * With `needsStart`, the source offers a way for a person to start it, which calls
     * `POST /v1/briefs/:briefId/start`.
     */
    kind: z.literal("brief"),
    target: deliveryTargetSchema,
    briefId: z.guid(),
    /** Markdown. Each source converts it to its own format. */
    text: z.string().min(1),
    needsStart: z.boolean(),
  }),
  z.strictObject({
    /**
     * A decision recorded in the thread (slice 2.2). With `needsConfirm` it is a proposal, and
     * the source offers a way for a person to confirm it, which calls
     * `POST /v1/decisions/:decisionId/confirm`.
     */
    kind: z.literal("decision"),
    target: deliveryTargetSchema,
    decisionId: z.guid(),
    /** Markdown. Each source converts it to its own format. */
    text: z.string().min(1),
    needsConfirm: z.boolean(),
    mentions: mentionsSchema,
  }),
  z.strictObject({
    kind: z.literal("status"),
    target: deliveryTargetSchema,
    /** The settled messages, by their id in the source system. */
    messageIds: z.array(z.string().min(1)).min(1),
    status: z.enum(["answered", "failed", "stopped"]),
  }),
]);
export type OutboundDelivery = z.infer<typeof outboundDeliverySchema>;

/**
 * Implemented by each source's adapter and registered with the API by source. Throws when
 * the delivery did not go out, so the API can retry it.
 */
export interface Deliverer {
  deliver(delivery: OutboundDelivery, correlationId: string): Promise<void>;
  /**
   * Sends a person a direct message (slice 3.4): Markdown, converted like a reply. Throws when
   * it did not go out. Optional: a source without direct messages sends no briefs.
   */
  direct?(message: DirectMessage, correlationId: string): Promise<void>;
  /** A person's IANA time zone (`Europe/London`), or undefined if the source cannot say. */
  timeZone?(person: { workspaceId: string; userId: string }): Promise<string | undefined>;
}

/** A direct message to one person (slice 3.4). */
export interface DirectMessage {
  workspaceId: string;
  userId: string;
  /** Markdown. Each source converts it to its own format. */
  text: string;
}
