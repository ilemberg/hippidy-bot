import { z } from "zod";

/**
 * One part the API depends on: `ok`, `not_configured` (its variables are missing or bad), or
 * `down` (configured, but it did not answer).
 */
export const componentStatusSchema = z.enum(["ok", "not_configured", "down"]);
export type ComponentStatus = z.infer<typeof componentStatusSchema>;

/**
 * Response body of `GET /status`. Public, so it says only whether each part works, never why
 * not. `ok` (200) when every part is ok, otherwise `degraded` (503).
 */
export const statusResponseSchema = z.strictObject({
  status: z.enum(["ok", "degraded"]),
  checks: z.strictObject({
    database: componentStatusSchema,
    agent: componentStatusSchema,
    slack: componentStatusSchema,
    github: componentStatusSchema,
  }),
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;
