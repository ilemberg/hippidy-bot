import { z } from "zod";

export const errorCodeSchema = z.enum([
  "invalid_request",
  "unauthorized",
  "not_found",
  "not_configured",
  "internal",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** Body of every error response from the API. */
export const errorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: errorCodeSchema,
    message: z.string(),
    /** Field-level problems for `invalid_request`. */
    issues: z.array(z.strictObject({ path: z.string(), message: z.string() })).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
