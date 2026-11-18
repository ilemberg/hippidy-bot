import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { errorResponse } from "./errors.ts";
import type { ApiEnv } from "./types.ts";

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/** Compares in constant time. Hashing first hides the length of the expected token. */
export function tokensMatch(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * Requires `Authorization: Bearer <token>`. Fails closed: with no token configured, every
 * request is rejected.
 */
export function requireServiceToken(expected: string | undefined): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (expected === undefined) {
      c.var.log.error("auth.rejected", { reason: "service_token_not_configured" });
      return errorResponse(c, 401, "unauthorized", "Missing or invalid service token");
    }
    const header = c.req.header("authorization");
    const given = header === undefined ? undefined : /^Bearer (\S+)$/i.exec(header)?.[1];
    if (given === undefined || !tokensMatch(given, expected)) {
      const reason =
        header === undefined
          ? "missing_token"
          : given === undefined
            ? "malformed_header"
            : "wrong_token";
      c.var.log.warn("auth.rejected", { reason });
      return errorResponse(c, 401, "unauthorized", "Missing or invalid service token");
    }
    await next();
    return;
  };
}
