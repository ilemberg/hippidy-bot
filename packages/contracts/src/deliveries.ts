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
 * Something the API sends back to a source (decision 53): a reply in the thread, or the
 * status of the messages it answered (for Slack: reactions).
 */
export const outboundDeliverySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("reply"),
    target: deliveryTargetSchema,
    /** Markdown. Each source converts it to its own format. */
    text: z.string().min(1),
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
}
