import type { ErrorCode, ErrorResponse } from "@hippidy/contracts";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Builds an error response in the shape every API client expects. */
export function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
  issues?: { path: string; message: string }[],
): Response {
  const body: ErrorResponse = {
    error: issues === undefined ? { code, message } : { code, message, issues },
  };
  return c.json(body, status);
}
