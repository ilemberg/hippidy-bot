import { z } from "zod";
import { messageSourceSchema } from "./messages.ts";

// Listening in channels (slice 2.5, decisions 176, 198 and 199): a channel someone switched it
// on in, and the messages its source reports there, kept as text for 30 days.

const id = z.string().min(1).max(255);
const timestamp = z.iso.datetime({ offset: true });
const actorSchema = z.strictObject({
  id,
  displayName: z.string().min(1).max(255).optional(),
});

/** How long a listened message is kept after it was sent (G8). */
export const OBSERVED_MESSAGE_RETENTION_DAYS = 30;
/**
 * The longest message text kept, in characters: always within the API's 64 KB body limit. The
 * adapter clips a longer message to it.
 */
export const OBSERVED_TEXT_MAX = 12_000;

/** Body of `PUT /v1/listening`: switch listening on or off in a channel. */
export const setListeningRequestSchema = z.strictObject({
  source: messageSourceSchema,
  workspaceId: id,
  channelId: id,
  listening: z.boolean(),
  actor: actorSchema,
});
export type SetListeningRequest = z.infer<typeof setListeningRequestSchema>;

/** A channel listening was switched on in, at some point. */
export const listeningChannelSchema = z.strictObject({
  source: messageSourceSchema,
  workspaceId: z.string(),
  channelId: z.string(),
  listening: z.boolean(),
  /** When it was last switched on. */
  startedAt: timestamp,
  changedAt: timestamp,
  changedBy: z.strictObject({ actorId: z.string(), name: z.string().nullable() }),
});
export type ListeningChannel = z.infer<typeof listeningChannelSchema>;

/** Response of `PUT /v1/listening`: whether anything changed, and the channel as it is now. */
export const setListeningResponseSchema = z.strictObject({
  changed: z.boolean(),
  channel: listeningChannelSchema,
});
export type SetListeningResponse = z.infer<typeof setListeningResponseSchema>;

/** Response of `GET /v1/listening`: every channel ever switched on, and how long text is kept. */
export const listeningListSchema = z.strictObject({
  channels: z.array(listeningChannelSchema),
  retentionDays: z.number().int().positive(),
});
export type ListeningList = z.infer<typeof listeningListSchema>;

const where = {
  source: messageSourceSchema,
  workspaceId: id,
  channelId: id,
  messageId: id,
};

/**
 * Body of `POST /v1/observations`: something that happened to a message in a channel. The API
 * keeps it only if the channel is listened to.
 */
export const observationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("posted"),
    ...where,
    /** The thread's root message; a message that starts no thread is its own root. */
    threadId: id,
    actor: actorSchema,
    text: z.string().max(OBSERVED_TEXT_MAX),
    sentAt: timestamp,
  }),
  z.strictObject({
    kind: z.literal("edited"),
    ...where,
    text: z.string().max(OBSERVED_TEXT_MAX),
    editedAt: timestamp,
  }),
  z.strictObject({ kind: z.literal("deleted"), ...where }),
]);
export type Observation = z.infer<typeof observationSchema>;

/** Response of `POST /v1/observations`: what the API did with it. */
export const observationResultSchema = z.strictObject({
  result: z.enum(["kept", "already_kept", "updated", "deleted", "not_listening", "not_found"]),
});
export type ObservationResult = z.infer<typeof observationResultSchema>;
