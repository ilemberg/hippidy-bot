import { randomUUID } from "node:crypto";
import {
  CORRELATION_ID_HEADER,
  inboundMessageSchema,
  type AcceptedMessage,
} from "@hippidy/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ApiConfig } from "../config.ts";
import type { Logger } from "../log.ts";
import { requireServiceToken } from "./auth.ts";
import { errorResponse } from "./errors.ts";
import type { ApiEnv } from "./types.ts";

export interface ApiDeps {
  config: ApiConfig;
  log: Logger;
  /** Id generator for accepted messages. Replaced in tests. */
  newId?: () => string;
}

const MAX_BODY_BYTES = 64 * 1024;
const correlationIdPattern = /^[\w.:-]{1,255}$/;

/** The core API: channel-agnostic, the only door to the system. */
export function createApi(deps: ApiDeps): Hono<ApiEnv> {
  const newId = deps.newId ?? randomUUID;
  const api = new Hono<ApiEnv>();

  api.use(async (c, next) => {
    const given = c.req.header(CORRELATION_ID_HEADER);
    const correlationId =
      given !== undefined && correlationIdPattern.test(given) ? given : randomUUID();
    c.set("correlationId", correlationId);
    c.set("log", deps.log.child({ correlationId }));
    c.header(CORRELATION_ID_HEADER, correlationId);
    await next();
  });

  api.get("/health", (c) => c.json({ status: "ok" }));

  api.post(
    "/v1/messages",
    requireServiceToken(deps.config.serviceToken),
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => errorResponse(c, 413, "invalid_request", "Request body is too large"),
    }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return errorResponse(c, 400, "invalid_request", "Request body must be JSON");
      }

      const parsed = inboundMessageSchema.safeParse(body);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        }));
        c.var.log.warn("message.invalid", { issues });
        return errorResponse(c, 400, "invalid_request", "Request body is invalid", issues);
      }

      if (c.var.correlationId !== parsed.data.sourceEventId) {
        c.var.log.warn("message.correlation_mismatch", {
          sourceEventId: parsed.data.sourceEventId,
        });
      }

      const accepted: AcceptedMessage = { id: newId(), status: "accepted" };
      c.var.log.info("message.received", { messageId: accepted.id, message: parsed.data });
      return c.json(accepted, 202);
    },
  );

  return api;
}
