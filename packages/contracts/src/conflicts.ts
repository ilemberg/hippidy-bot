import { z } from "zod";
import { decisionStatusSchema } from "./decisions.ts";

// Conflicts and who decides them (slice 3.2, decision 208).

const timestamp = z.iso.datetime({ offset: true });
const person = z.strictObject({ actorId: z.string(), name: z.string().nullable() });

/** A decision a conflict bears on, or the proposal that would replace one. */
const decisionRef = z.strictObject({
  number: z.number().int().positive(),
  statement: z.string(),
  status: decisionStatusSchema,
  decidedBy: z.strictObject({ actorId: z.string().nullable(), name: z.string().nullable() }),
});

/** Who wants what. */
export const conflictPositionSchema = z.strictObject({
  actorId: z.string(),
  name: z.string().nullable(),
  says: z.string(),
});

export const conflictOutcomeSchema = z.enum(["kept", "changed", "dismissed"]);
export type ConflictOutcome = z.infer<typeof conflictOutcomeSchema>;

/** One conflict, as the API returns it. */
export const conflictSchema = z.strictObject({
  id: z.guid(),
  number: z.number().int().positive(),
  /**
   * `replacement`: a proposal that replaces someone else's decision; `raised`: the teammate
   * raised it; `capture`: listening proposed a replacement.
   */
  kind: z.enum(["replacement", "raised", "capture"]),
  summary: z.string(),
  area: z.string().nullable(),
  decisions: z.array(decisionRef),
  proposal: decisionRef.nullable(),
  positions: z.array(conflictPositionSchema),
  /** Who decides it; empty when nobody is set to (no owner and no fallback). */
  deciders: z.array(person),
  status: z.enum(["open", "settled"]),
  outcome: conflictOutcomeSchema.nullable(),
  note: z.string().nullable(),
  settledBy: person.nullable(),
  settledAt: timestamp.nullable(),
  conversationId: z.guid().nullable(),
  channelId: z.string().nullable(),
  threadId: z.string().nullable(),
  createdAt: timestamp,
});
export type Conflict = z.infer<typeof conflictSchema>;

/** Query of `GET /v1/conflicts`: open ones by default, or those bearing on one decision. */
export const listConflictsQuerySchema = z.strictObject({
  status: z.enum(["open", "settled", "all"]).optional(),
  /** Only those bearing on this decision, or proposing to replace it. */
  decision: z.coerce.number().int().positive().max(1_000_000_000).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListConflictsQuery = z.infer<typeof listConflictsQuerySchema>;

export const conflictListSchema = z.strictObject({ conflicts: z.array(conflictSchema) });
export type ConflictList = z.infer<typeof conflictListSchema>;

/**
 * Why a person may not settle a conflict here. `not_decider`: they are not among its deciders.
 * `has_proposal`: it is settled by confirming or rejecting its proposal. `settled`: it already is.
 */
export const conflictRefusalSchema = z.enum(["not_decider", "has_proposal", "settled"]);
export type ConflictRefusal = z.infer<typeof conflictRefusalSchema>;

/** Response of `GET /v1/conflicts/:number`: a conflict and whether the caller may settle it. */
export const conflictDetailSchema = z.strictObject({
  conflict: conflictSchema,
  youMay: z.strictObject({ settle: z.boolean(), reason: conflictRefusalSchema.nullable() }),
});
export type ConflictDetail = z.infer<typeof conflictDetailSchema>;

/** Body of `POST /v1/conflicts/:id/settle` from a signed-in decider. */
export const settleConflictRequestSchema = z.strictObject({
  outcome: conflictOutcomeSchema,
  note: z.string().trim().max(500).optional(),
});
export type SettleConflictRequest = z.infer<typeof settleConflictRequestSchema>;

/** What settling did. */
export const settleConflictResultSchema = z.strictObject({
  status: z.enum(["settled", "not_allowed", "not_found"]),
  reason: conflictRefusalSchema.optional(),
  conflict: conflictSchema.optional(),
});
export type SettleConflictResult = z.infer<typeof settleConflictResultSchema>;
