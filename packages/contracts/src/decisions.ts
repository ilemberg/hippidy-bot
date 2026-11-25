import { z } from "zod";
import { messageSourceSchema } from "./messages.ts";

// Decisions on record (slice 2.2, decisions 190 to 192): what the team has decided, read by the
// API's routes and confirmed by a person from the source a proposal was posted in.

const id = z.string().min(1).max(255);

export const decisionStatusSchema = z.enum(["proposed", "active", "superseded", "rejected"]);
export type DecisionStatus = z.infer<typeof decisionStatusSchema>;

/** One decision, as the API returns it. */
export const decisionSchema = z.strictObject({
  id: z.guid(),
  /** The number people cite it by. */
  number: z.number().int().positive(),
  statement: z.string(),
  reason: z.string().nullable(),
  area: z.string().nullable(),
  status: decisionStatusSchema,
  decidedBy: z.strictObject({ actorId: z.string().nullable(), name: z.string().nullable() }),
  decidedAt: z.iso.datetime({ offset: true }),
  origin: z.enum(["thread", "import", "capture"]),
  /** For an import, the entry's number in the log. */
  originRef: z.string().nullable(),
  conversationId: z.guid().nullable(),
  /**
   * Where it was decided: the channel and thread (of its conversation, or of a listened channel
   * for a decision proposed from listening, slice 2.5) and the message.
   */
  channelId: z.string().nullable(),
  threadId: z.string().nullable(),
  messageId: z.string().nullable(),
  /** The number of the decision this one replaces. */
  supersedes: z.number().int().positive().nullable(),
  confirmedBy: z.strictObject({ actorId: z.string(), name: z.string().nullable() }).nullable(),
  confirmedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type Decision = z.infer<typeof decisionSchema>;

/** Query of `GET /v1/decisions`: words to search for, a status, and how many. */
export const listDecisionsQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(200).optional(),
  status: decisionStatusSchema.optional(),
  origin: z.enum(["thread", "import", "capture"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListDecisionsQuery = z.infer<typeof listDecisionsQuerySchema>;

export const decisionListSchema = z.strictObject({ decisions: z.array(decisionSchema) });
export type DecisionList = z.infer<typeof decisionListSchema>;

/** Body of `POST /v1/decisions/:decisionId/confirm`: who pressed Confirm, and where. */
export const confirmDecisionRequestSchema = z.strictObject({
  source: messageSourceSchema,
  workspaceId: id,
  actor: z.strictObject({ id, displayName: z.string().min(1).max(255).optional() }),
});
export type ConfirmDecisionRequest = z.infer<typeof confirmDecisionRequestSchema>;

/**
 * What a confirmation did. `confirmed`: the proposal is active now. `not_proposed`: it was
 * already active, superseded or rejected. `not_found`: no such decision in that workspace.
 */
export const confirmDecisionResultSchema = z.strictObject({
  status: z.enum(["confirmed", "not_proposed", "not_found"]),
});
export type ConfirmDecisionResult = z.infer<typeof confirmDecisionResultSchema>;
