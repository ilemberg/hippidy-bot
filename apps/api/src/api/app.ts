import { randomUUID } from "node:crypto";
import {
  CORRELATION_ID_HEADER,
  inboundMessageSchema,
  listAgentEventsQuerySchema,
  listConversationsQuerySchema,
  listSessionsQuerySchema,
  observationSchema,
  setListeningRequestSchema,
  OBSERVED_MESSAGE_RETENTION_DAYS,
  type ListeningList,
  type ObservationResult,
  type SessionList,
  MAX_INBOUND_MESSAGE_BYTES,
  confirmDecisionRequestSchema,
  listDecisionsQuerySchema,
  startBriefRequestSchema,
  type DecisionList,
  stopRequestSchema,
  type AcceptedMessage,
  type AgentEventList,
  type ConversationDetail,
  type ConversationList,
  type MeResponse,
} from "@hippidy/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { VerifyAgentWebhook } from "../agent/webhooks.ts";
import type { ApiConfig } from "../config.ts";
import type { Logger } from "../log.ts";
import { findChangeBySession } from "../store/changes.ts";
import { listSessions } from "../store/sessions.ts";
import { listListening, recordObservation, setListening } from "../store/listening.ts";
import { searchDecisions } from "../store/decisions.ts";
import { findConversationBySession } from "../store/conversations.ts";
import {
  listConversations,
  readAgentEvents,
  readConversation,
  readTranscript,
} from "../store/reading.ts";
import { requireServiceOrPerson, requireServiceToken } from "./auth.ts";
import { startBriefByPerson, syncChange } from "./changes.ts";
import { runCapture, type CaptureDeps } from "./capture.ts";
import { confirmDecisionByPerson } from "./decisions.ts";
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
  /** Capture from listened channels (slice 2.5). Undefined until storage and the agent are. */
  capture?: CaptureDeps | undefined;
}

/** Webhook types after which the session may have something new to deliver. */
const SYNC_ON_WEBHOOK = new Set(["session.status_idled", "session.status_terminated"]);

/** The contract's limit; the Slack adapter trims a message's context to fit it. */
const MAX_BODY_BYTES = MAX_INBOUND_MESSAGE_BYTES;
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

  // Listening in a channel switched on or off (slice 2.5, decision 199). The source says who.
  api.put("/v1/listening", requireServiceToken(deps.config.serviceToken), limitBody, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "invalid_request", "Request body must be JSON");
    }
    const parsed = setListeningRequestSchema.safeParse(body);
    if (!parsed.success) return errorResponse(c, 400, "invalid_request", "Request body is invalid");
    const db = deps.conversations?.db ?? deps.status.db;
    if (db === undefined) {
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    }
    const result = await setListening(db, parsed.data);
    c.var.log.info("listening.set", {
      channelId: parsed.data.channelId,
      listening: parsed.data.listening,
      changed: result.changed,
      actorId: parsed.data.actor.id,
    });
    return c.json(result);
  });

  // A message posted, edited or deleted in a channel. Kept only if the channel is listened to.
  api.post(
    "/v1/observations",
    requireServiceToken(deps.config.serviceToken),
    limitBody,
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return errorResponse(c, 400, "invalid_request", "Request body must be JSON");
      }
      const parsed = observationSchema.safeParse(body);
      if (!parsed.success) {
        return errorResponse(c, 400, "invalid_request", "Request body is invalid");
      }
      const db = deps.conversations?.db ?? deps.status.db;
      if (db === undefined) {
        return errorResponse(c, 503, "not_configured", "Storage is not configured");
      }
      const result: ObservationResult = { result: await recordObservation(db, parsed.data) };
      if (result.result !== "not_listening") {
        c.var.log.info("observation.recorded", { kind: parsed.data.kind, result: result.result });
      }
      return c.json(result);
    },
  );

  // A person starts a brief the start rule held back (slice 2.1, decision 181). The source
  // says who pressed Start; the brief must belong to a thread in their source and workspace.
  api.post(
    "/v1/briefs/:briefId/start",
    requireServiceToken(deps.config.serviceToken),
    limitBody,
    async (c) => {
      const briefId = conversationIdSchema.safeParse(c.req.param("briefId"));
      if (!briefId.success) {
        return errorResponse(c, 404, "not_found", "No such brief");
      }
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return errorResponse(c, 400, "invalid_request", "Request body must be JSON");
      }
      const parsed = startBriefRequestSchema.safeParse(body);
      if (!parsed.success) {
        return errorResponse(c, 400, "invalid_request", "Request body is invalid");
      }
      if (deps.conversations === undefined) {
        return errorResponse(c, 503, "not_configured", "Conversations are not configured");
      }
      const result = await startBriefByPerson(
        deps.conversations,
        briefId.data,
        parsed.data,
        c.var.log,
      );
      return c.json(result, 202);
    },
  );

  // A person confirms a proposed decision (slice 2.2, decision 192), from the source it was
  // posted in. The decision must belong to a thread in their source and workspace.
  api.post(
    "/v1/decisions/:decisionId/confirm",
    requireServiceToken(deps.config.serviceToken),
    limitBody,
    async (c) => {
      const decisionId = conversationIdSchema.safeParse(c.req.param("decisionId"));
      if (!decisionId.success) return errorResponse(c, 404, "not_found", "No such decision");
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return errorResponse(c, 400, "invalid_request", "Request body must be JSON");
      }
      const parsed = confirmDecisionRequestSchema.safeParse(body);
      if (!parsed.success) {
        return errorResponse(c, 400, "invalid_request", "Request body is invalid");
      }
      if (deps.conversations === undefined) {
        return errorResponse(c, 503, "not_configured", "Conversations are not configured");
      }
      const result = await confirmDecisionByPerson(
        deps.conversations,
        decisionId.data,
        parsed.data,
        c.var.log,
      );
      return c.json(result, 202);
    },
  );

  // Who the API takes the caller to be: a service, or a person signed in to the web app
  // (decisions 193 and 194). The web app reads it to show who is signed in.
  const people = requireServiceOrPerson(deps.config.serviceToken, deps.config.personAuth);
  api.get("/v1/me", people, (c) => {
    const caller = c.var.caller;
    const body: MeResponse =
      caller.kind === "person"
        ? {
            kind: "person",
            workspaceId: caller.workspaceId,
            actorId: caller.actorId,
            name: caller.name,
          }
        : { kind: "service" };
    return c.json(body);
  });

  // Reading the record (decision 79). Everything below is answered from the database alone:
  // the agent runtime is not asked, so a conversation reads the same when it is unreachable.
  // A signed-in person may read it too (slice 2.4's monitoring page); every route that
  // writes still takes the service token only.
  const serviceOnly = requireServiceToken(deps.config.serviceToken);
  const readers = people;

  /** The issues of a bad query string, in the error shape. */
  const invalidQuery = (c: Context<ApiEnv>, error: z.ZodError) =>
    errorResponse(
      c,
      400,
      "invalid_request",
      "Query is invalid",
      error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    );

  // The agents at work (slice 2.4): every thread's session and every change's worker, the ones
  // working first. From the database alone, like the routes below.
  // Where the bot listens (slice 2.5, G9): for the web app's page about listening.
  api.get("/v1/listening", readers, async (c) => {
    const db = deps.conversations?.db ?? deps.status.db;
    if (db === undefined) {
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    }
    const body: ListeningList = {
      channels: await listListening(db),
      retentionDays: OBSERVED_MESSAGE_RETENTION_DAYS,
    };
    return c.json(body);
  });

  api.get("/v1/sessions", readers, async (c) => {
    const query = listSessionsQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidQuery(c, query.error);
    const db = deps.conversations?.db ?? deps.status.db;
    if (db === undefined) {
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    }
    const list: SessionList = { sessions: await listSessions(db, query.data.limit) };
    c.var.log.info("sessions.listed", { count: list.sessions.length });
    return c.json(list);
  });

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

  // Projects, roles and approvals (slice 5A). They need only storage, so they take the
  // database the status check uses, which is there even when the agent is not configured.
  // They write as well as read, so they stay on the service token.
  addProjectRoutes(api, { db: deps.status.db, auth: serviceOnly, limitBody });

  // The decisions on record (slice 2.2): read from the database alone, newest or best matching
  // first. The web app's wiki (slice 2.6) builds on this.
  api.get("/v1/decisions", readers, async (c) => {
    const query = listDecisionsQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidQuery(c, query.error);
    const db = deps.conversations?.db ?? deps.status.db;
    if (db === undefined) {
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    }
    const list: DecisionList = {
      decisions: await searchDecisions(db, {
        query: query.data.q,
        statuses: query.data.status === undefined ? undefined : [query.data.status],
        origin: query.data.origin,
        limit: query.data.limit,
      }),
    };
    return c.json(list);
  });

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
      const change =
        conversation === undefined
          ? await findChangeBySession(deps.conversations.db, event.resourceId)
          : undefined;
      if (change !== undefined) {
        // A coding worker's session (decision 184).
        await syncChange(deps.conversations, change, log);
        log.info("webhook.synced", { changeId: change.id });
      } else if (conversation === undefined) {
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
    // Last, capture from listened channels (slice 2.5): after every conversation has been
    // let go, and never failing reconcile.
    let captured = 0;
    if (deps.capture !== undefined) {
      try {
        const capture = await runCapture(deps.capture, c.var.log.child({ area: "capture" }));
        captured = capture.read;
        if (capture.read > 0 || capture.failed > 0 || capture.expiredMessages > 0) {
          c.var.log.info("capture.done", { ...capture });
        }
      } catch (error) {
        c.var.log.error("capture.failed", { error });
      }
    }
    return c.json({ ...result, backfilled, captured });
  });

  return api;
}
