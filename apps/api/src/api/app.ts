import { randomUUID } from "node:crypto";
import {
  CORRELATION_ID_HEADER,
  inboundMessageSchema,
  listAgentEventsQuerySchema,
  listConversationsQuerySchema,
  stopRequestSchema,
  type AcceptedMessage,
  type AgentEventList,
  type ConversationDetail,
  type ConversationList,
} from "@hippidy/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { VerifyAgentWebhook } from "../agent/webhooks.ts";
import type { ApiConfig } from "../config.ts";
import type { Logger } from "../log.ts";
import { findConversationBySession } from "../store/conversations.ts";
import {
  listConversations,
  readAgentEvents,
  readConversation,
  readTranscript,
} from "../store/reading.ts";
import { requireServiceToken } from "./auth.ts";
import {
  reconcile,
  receiveMessage,
  stopConversation,
  syncConversation,
  type ConversationDeps,
} from "./conversations.ts";
import { errorResponse } from "./errors.ts";
import { addProjectRoutes } from "./projects.ts";
import { backfillRecord } from "./record.ts";
import { readStatus, type StatusDeps } from "./status.ts";
import type { ApiEnv } from "./types.ts";

const conversationIdSchema = z.guid();

export interface ApiDeps {
  config: ApiConfig;
  log: Logger;
  /** Storage, agent runtime and deliverers. Undefined until they are configured. */
  conversations: ConversationDeps | undefined;
  /** Checks Anthropic's webhook signatures. Undefined until the signing key is set. */
  verifyAgentWebhook: VerifyAgentWebhook | undefined;
  /** What `GET /status` checks. */
  status: StatusDeps;
}

/** Webhook types after which the session may have something new to deliver. */
const SYNC_ON_WEBHOOK = new Set(["session.status_idled", "session.status_terminated"]);

const MAX_BODY_BYTES = 64 * 1024;
const correlationIdPattern = /^[\w.:-]{1,255}$/;

/** The core API: channel-agnostic, the only door to the system. */
export function createApi(deps: ApiDeps): Hono<ApiEnv> {
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

  // Public, like /health, but checks the parts the API depends on. It says only whether each
  // works, never why not; the reason is logged.
  api.get("/status", async (c) => {
    const status = await readStatus(deps.status, c.var.log);
    return c.json(status, status.status === "ok" ? 200 : 503);
  });

  const limitBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => errorResponse(c, 413, "invalid_request", "Request body is too large"),
  });

  api.post("/v1/messages", requireServiceToken(deps.config.serviceToken), limitBody, async (c) => {
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

    c.var.log.info("message.received", { message: parsed.data });
    if (deps.conversations === undefined) {
      c.var.log.error("message.not_configured", { reason: "storage or agent not configured" });
      return errorResponse(c, 503, "not_configured", "Conversations are not configured");
    }
    const result = await receiveMessage(deps.conversations, parsed.data, c.var.log);
    const accepted: AcceptedMessage = {
      id: result.id,
      status: "accepted",
      ...(result.duplicate ? { duplicate: true } : {}),
    };
    return c.json(accepted, 202);
  });

  // Stops the agent in a conversation (decision 60).
  api.post("/v1/stop", requireServiceToken(deps.config.serviceToken), limitBody, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "invalid_request", "Request body must be JSON");
    }
    const parsed = stopRequestSchema.safeParse(body);
    if (
      !parsed.success ||
      (parsed.data.threadId === undefined && parsed.data.messageId === undefined)
    ) {
      return errorResponse(c, 400, "invalid_request", "Request body is invalid");
    }
    if (deps.conversations === undefined) {
      return errorResponse(c, 503, "not_configured", "Conversations are not configured");
    }
    return c.json(await stopConversation(deps.conversations, parsed.data, c.var.log), 202);
  });

  // Reading the record (decision 79). Everything below is answered from the database alone:
  // the agent runtime is not asked, so a conversation reads the same when it is unreachable.
  const readers = requireServiceToken(deps.config.serviceToken);

  /** The issues of a bad query string, in the error shape. */
  const invalidQuery = (c: Context<ApiEnv>, error: z.ZodError) =>
    errorResponse(
      c,
      400,
      "invalid_request",
      "Query is invalid",
      error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    );

  api.get("/v1/conversations", readers, async (c) => {
    const query = listConversationsQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidQuery(c, query.error);
    if (deps.conversations === undefined) {
      return errorResponse(c, 503, "not_configured", "Conversations are not configured");
    }
    const { limit, before } = query.data;
    // A cursor that names nothing must not look like the end of the list.
    if (
      before !== undefined &&
      (await readConversation(deps.conversations.db, before)) === undefined
    ) {
      return errorResponse(c, 400, "invalid_request", "Query is invalid", [
        { path: "before", message: "No such conversation" },
      ]);
    }
    // One more than asked for, to know whether there is a next page.
    const found = await listConversations(deps.conversations.db, { limit: limit + 1, before });
    const conversations = found.slice(0, limit);
    const last = conversations.at(-1);
    const body: ConversationList = {
      conversations,
      next: found.length > limit && last !== undefined ? last.id : null,
    };
    c.var.log.info("conversations.listed", { count: conversations.length });
    return c.json(body);
  });

  api.get("/v1/conversations/:id", readers, async (c) => {
    const id = conversationIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return errorResponse(c, 404, "not_found", "No such conversation");
    if (deps.conversations === undefined) {
      return errorResponse(c, 503, "not_configured", "Conversations are not configured");
    }
    const conversation = await readConversation(deps.conversations.db, id.data);
    if (conversation === undefined) {
      return errorResponse(c, 404, "not_found", "No such conversation");
    }
    const body: ConversationDetail = {
      conversation,
      transcript: await readTranscript(deps.conversations.db, id.data),
    };
    c.var.log.info("conversation.read", { conversationId: id.data, lines: body.transcript.length });
    return c.json(body);
  });

  api.get("/v1/conversations/:id/events", readers, async (c) => {
    const id = conversationIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return errorResponse(c, 404, "not_found", "No such conversation");
    const query = listAgentEventsQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidQuery(c, query.error);
    if (deps.conversations === undefined) {
      return errorResponse(c, 503, "not_configured", "Conversations are not configured");
    }
    if ((await readConversation(deps.conversations.db, id.data)) === undefined) {
      return errorResponse(c, 404, "not_found", "No such conversation");
    }
    const found = await readAgentEvents(deps.conversations.db, id.data, {
      limit: query.data.limit + 1,
      after: query.data.after,
    });
    const events = found.slice(0, query.data.limit);
    const last = events.at(-1);
    const body: AgentEventList = {
      events,
      next: found.length > query.data.limit && last !== undefined ? last.position : null,
    };
    // Raw events can hold whatever the agent saw: reading them leaves a trace.
    c.var.log.info("conversation.events_read", { conversationId: id.data, count: events.length });
    return c.json(body);
  });

  // Projects, roles and approvals (slice 5A). They need only storage, which comes with the
  // conversations' dependencies.
  addProjectRoutes(api, { db: deps.conversations?.db, auth: readers, limitBody });

  // Anthropic calls this when a session changes state (decision 13). The body is thin: it
  // names the session, and the current state is fetched from Anthropic.
  api.post("/v1/webhooks/agent", limitBody, async (c) => {
    if (deps.conversations === undefined || deps.verifyAgentWebhook === undefined) {
      c.var.log.error("webhook.not_configured", {});
      return errorResponse(c, 503, "not_configured", "Agent webhooks are not configured");
    }
    const body = await c.req.text();
    let event;
    try {
      event = deps.verifyAgentWebhook(body, c.req.header());
    } catch {
      c.var.log.warn("webhook.rejected", { reason: "invalid signature" });
      return errorResponse(c, 400, "invalid_request", "Invalid webhook signature");
    }
    const log = c.var.log.child({ webhookId: event.id, webhookType: event.type });
    if (SYNC_ON_WEBHOOK.has(event.type)) {
      const conversation = await findConversationBySession(deps.conversations.db, event.resourceId);
      if (conversation === undefined) {
        log.warn("webhook.unknown_session", { sessionId: event.resourceId });
      } else {
        await syncConversation(deps.conversations, conversation, log);
        log.info("webhook.synced", { conversationId: conversation.id });
      }
    }
    return c.body(null, 204);
  });

  // The safety net, called about every minute by Supabase pg_cron (decision 54). It has its
  // own token: the database holds it, and it must not be able to post messages.
  api.post("/v1/reconcile", requireServiceToken(deps.config.reconcileToken), async (c) => {
    if (deps.conversations === undefined) {
      return errorResponse(c, 503, "not_configured", "Conversations are not configured");
    }
    const result = await reconcile(deps.conversations, c.var.log);
    // Then catch up a few conversations from before the record existed (decision 80).
    const backfilled = await backfillRecord(deps.conversations, c.var.log);
    if (result.checked > 0 || backfilled > 0) {
      c.var.log.info("reconcile.done", { ...result, backfilled });
    }
    return c.json({ ...result, backfilled });
  });

  return api;
}
