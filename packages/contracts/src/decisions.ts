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
  /** Which wording it is at: 1 as recorded, one more for each edit (slice 2.6). */
  wordingVersion: z.number().int().positive(),
  /** Who rejected a proposal, and when (slice 2.6). */
  rejectedBy: z.strictObject({ actorId: z.string(), name: z.string().nullable() }).nullable(),
  rejectedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type Decision = z.infer<typeof decisionSchema>;

/** Query of `GET /v1/decisions`: words to search for, a status, and how many. */
export const listDecisionsQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(200).optional(),
  /** One status, or `all`; active when left out. */
  status: z.union([decisionStatusSchema, z.literal("all")]).optional(),
  origin: z.enum(["thread", "import", "capture"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
export type ListDecisionsQuery = z.infer<typeof listDecisionsQuerySchema>;

export const decisionListSchema = z.strictObject({ decisions: z.array(decisionSchema) });
export type DecisionList = z.infer<typeof decisionListSchema>;

/** Body of `POST /v1/decisions/:decisionId/confirm`: who pressed Confirm, and where. */
export const confirmDecisionRequestSchema = z.strictObject({
  source: messageSourceSchema,
  workspaceId: id,
  actor: z.strictObject({ id, displayName: z.string().min(1).max(255).optional() }),
  /** The wording the person saw; a Slack button is the wording first posted, 1. */
  wordingVersion: z.number().int().positive().optional(),
});

/** Body of a signed-in person's confirm or reject: only the wording they saw. */
export const personDecisionActionSchema = z.strictObject({
  wordingVersion: z.number().int().positive(),
});
export type ConfirmDecisionRequest = z.infer<typeof confirmDecisionRequestSchema>;

/** Why a person may not act on a proposal (slice 2.6, decisions 201 and 202). */
export const notAllowedReasonSchema = z.enum([
  /** They did not write in the thread it came from. */
  "not_in_thread",
  /** It was imported from the decision log, which is its source. */
  "read_only",
  /**
   * It replaces someone else's decision, so only its deciders (the area's owner, the fallback,
   * the replaced decision's own decider) may confirm or reword it (slice 3.2, decision 208).
   */
  "not_decider",
]);
export type NotAllowedReason = z.infer<typeof notAllowedReasonSchema>;

/**
 * What confirming, rejecting or editing a proposal did. `confirmed`: it is active now.
 * `rejected`: it is rejected now. `edited`: its wording changed; it is still proposed.
 * `not_proposed`: it was already active, superseded or rejected. `not_found`: no such decision
 * in that workspace. `not_allowed`: the person may not act on it, and `reason` says why.
 * `changed`: its wording changed since the person saw it; nothing was done.
 */
export const decisionActionResultSchema = z.strictObject({
  status: z.enum([
    "confirmed",
    "rejected",
    "edited",
    "not_proposed",
    "not_found",
    "not_allowed",
    "changed",
  ]),
  reason: notAllowedReasonSchema.optional(),
});
export type DecisionActionResult = z.infer<typeof decisionActionResultSchema>;

/** What `POST /v1/decisions/:decisionId/confirm` answers. */
export const confirmDecisionResultSchema = decisionActionResultSchema;
export type ConfirmDecisionResult = DecisionActionResult;

/** Body of `PATCH /v1/decisions/:decisionId` from a person: a proposal's new wording. */
export const editDecisionRequestSchema = z
  .strictObject({
    statement: z.string().trim().min(1).max(500).optional(),
    reason: z.string().trim().max(2000).nullable().optional(),
    area: z.string().trim().max(100).nullable().optional(),
    /** The wording the person edited from. */
    wordingVersion: z.number().int().positive(),
  })
  .refine(
    (edit) => edit.statement !== undefined || edit.reason !== undefined || edit.area !== undefined,
    { message: "Change the statement, the reason or the area" },
  );
export type EditDecisionRequest = z.infer<typeof editDecisionRequestSchema>;

const wordingSchema = z.strictObject({
  statement: z.string(),
  reason: z.string().nullable(),
  area: z.string().nullable(),
  /** Before an edit by someone else: who it named as deciding until then (decision 203). */
  decidedBy: z
    .strictObject({ actorId: z.string().nullable(), name: z.string().nullable() })
    .optional(),
});

/** One change to a decision after it was recorded. */
export const decisionEventSchema = z.strictObject({
  kind: z.enum(["edited", "confirmed", "rejected", "superseded"]),
  actor: z.strictObject({ actorId: z.string(), name: z.string().nullable() }),
  at: z.iso.datetime({ offset: true }),
  before: wordingSchema.nullable(),
  after: wordingSchema.nullable(),
});
export type DecisionEvent = z.infer<typeof decisionEventSchema>;

/** Response of `GET /v1/decisions/:number`: a decision, its history, and what the caller may do. */
export const decisionDetailSchema = z.strictObject({
  decision: decisionSchema,
  /** Oldest first. Its recording is the decision itself (who decided, when). */
  history: z.array(decisionEventSchema),
  /** For a signed-in person: whether they may act on it now, and why not. */
  youMay: z.strictObject({
    act: z.boolean(),
    reason: notAllowedReasonSchema.nullable(),
    /** May reject (withdraw) a proposal they may not confirm (slice 3.2, decision 208). */
    withdraw: z.boolean().optional(),
  }),
});
export type DecisionDetail = z.infer<typeof decisionDetailSchema>;
