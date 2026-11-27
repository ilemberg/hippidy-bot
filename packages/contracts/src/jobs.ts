import { z } from "zod";
import { goalSchema } from "./goals.ts";

// Standing jobs (wave 4, slice 4.1, decisions 214 and 215): what the bot is responsible for,
// each wake it makes, and what it costs.

const timestamp = z.iso.datetime({ offset: true });
const person = z.strictObject({ actorId: z.string(), name: z.string().nullable() });

/**
 * The kinds of job: capture (2.5) and briefs (3.4) first, then the checker (4.3), which reviews
 * pull requests, and goals (4.4), which people make to work through a feature's tickets.
 */
export const jobKindSchema = z.enum(["capture", "briefs", "checker", "goal"]);
export type JobKind = z.infer<typeof jobKindSchema>;

/** `capped`: it reached its monthly cap and paused itself (rule 17 of `wave-4.md`). */
export const jobStateSchema = z.enum(["active", "paused", "capped"]);
export type JobState = z.infer<typeof jobStateSchema>;

/** One job, as the API returns it. */
export const jobSchema = z.strictObject({
  id: z.guid(),
  name: z.string(),
  kind: jobKindSchema,
  /** What it is for, in words; a person's to change (G16). */
  goal: z.string().nullable(),
  owner: person.nullable(),
  everyMinutes: z.number().int().min(1).max(1440),
  state: jobStateSchema,
  /** Its monthly cap, in cents (G21). */
  capCents: z.number().int().min(0),
  /** What its wakes cost this calendar month (UTC), in millionths of a dollar. */
  spentMicrosThisMonth: z.number().min(0),
  lastWakeAt: timestamp.nullable(),
  version: z.number().int().positive(),
  createdAt: timestamp,
});
export type Job = z.infer<typeof jobSchema>;

/**
 * One wake. `said`: it posted, proposed or sent something; `silent`: nothing to do, and
 * `summary` says why; `failed`: it threw; `skipped`: it did not run (its cap).
 */
export const jobWakeSchema = z.strictObject({
  startedAt: timestamp,
  endedAt: timestamp.nullable(),
  outcome: z.enum(["said", "silent", "failed", "skipped"]),
  summary: z.string().nullable(),
  costMicros: z.number().min(0),
  error: z.string().nullable(),
});
export type JobWake = z.infer<typeof jobWakeSchema>;

/** Response of `GET /v1/jobs`. */
export const jobListSchema = z.strictObject({ jobs: z.array(jobSchema) });
export type JobList = z.infer<typeof jobListSchema>;

/**
 * Response of `GET /v1/jobs/:name`: a job, its latest wakes (newest first), the changes people
 * made to it (oldest first, slice 4.2), and, for a goal, its thread and tickets (slice 4.4).
 */
export const jobDetailSchema = z.strictObject({
  job: jobSchema,
  goal: goalSchema.nullable(),
  wakes: z.array(jobWakeSchema),
  history: z.array(
    z.strictObject({
      actor: z.strictObject({ actorId: z.string(), name: z.string().nullable() }),
      at: timestamp,
      before: z.record(z.string(), z.unknown()),
      after: z.record(z.string(), z.unknown()),
    }),
  ),
});
export type JobDetail = z.infer<typeof jobDetailSchema>;
