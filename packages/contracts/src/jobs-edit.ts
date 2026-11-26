import { z } from "zod";
import { jobSchema } from "./jobs.ts";

// Changing a standing job (slice 4.2, decision 217): a signed-in person, on the version seen.

const timestamp = z.iso.datetime({ offset: true });
const person = z.strictObject({ actorId: z.string(), name: z.string().nullable() });

/** Body of `PATCH /v1/jobs/:id`: what changes, on the version seen. */
export const editJobRequestSchema = z
  .strictObject({
    version: z.number().int().positive(),
    state: z.enum(["active", "paused"]).optional(),
    capCents: z.number().int().min(0).max(10_000).optional(),
    everyMinutes: z.number().int().min(1).max(1440).optional(),
    goal: z
      .string()
      .trim()
      .max(2000)
      .refine((v) => !v.includes("\u0000"), { message: "Must not contain a null character" })
      .nullable()
      .optional(),
  })
  .refine(
    (e) =>
      e.state !== undefined ||
      e.capCents !== undefined ||
      e.everyMinutes !== undefined ||
      e.goal !== undefined,
    { message: "Change the state, the cap, the interval or the goal" },
  );
export type EditJobRequest = z.infer<typeof editJobRequestSchema>;

/**
 * What an edit did. `changed`: edited since the version named; nothing was done.
 * `still_capped`: resuming a capped job needs a cap above this month's spend.
 */
export const jobActionResultSchema = z.strictObject({
  status: z.enum(["edited", "unchanged", "changed", "still_capped", "not_found"]),
  job: jobSchema.optional(),
});
export type JobActionResult = z.infer<typeof jobActionResultSchema>;

const jobFields = z.strictObject({
  state: z.string(),
  capCents: z.number(),
  everyMinutes: z.number(),
  goal: z.string().nullable(),
});

/** One change a person made to a job. */
export const jobEventSchema = z.strictObject({
  actor: person,
  at: timestamp,
  before: jobFields,
  after: jobFields,
});
export type JobEvent = z.infer<typeof jobEventSchema>;
