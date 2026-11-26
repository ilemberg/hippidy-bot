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
  listConflictsQuerySchema,
  setBriefsRequestSchema,
  setMyBriefsRequestSchema,
  type SetBriefsResult,
  createTaskRequestSchema,
  createWaitRequestSchema,
  editTaskRequestSchema,
  listTasksQuerySchema,
  listWaitsQuerySchema,
  taskKeySchema,
  editJobRequestSchema,
  type JobActionResult,
  type JobDetail,
  type JobList,
  type TaskActionResult,
  type TaskDetail,
  type WaitActionResult,
  type WaitList,
  settleConflictRequestSchema,
  type ConflictList,
  listDecisionsQuerySchema,
  editDecisionRequestSchema,
  createAreaRequestSchema,
  editAreaRequestSchema,
  type AreaActionResult,
  type AreaDetail,
  type AreaList,
  type PeopleList,
  personDecisionActionSchema,
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
import {
  deleteExpiredObservations,
  listListening,
  recordObservation,
  setListening,
} from "../store/listening.ts";
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
import type { CaptureDeps } from "./capture.ts";
import type { CheckerServices } from "./checker.ts";
import { namePullRequestAreas } from "./areas.ts";
import { settleConflictByPerson } from "./conflicts.ts";
import { myBrief } from "./briefs.ts";
import { runJobs } from "./jobs.ts";
import { editJob, findJob, jobHistory, jobWakes, listJobs } from "../store/jobs.ts";
import { setBriefs } from "../store/briefs.ts";
import { createTaskSource, type TaskSource } from "../tasks/provider.ts";
import {
  createTask,
  editTask,
  findBuiltinTask,
  taskHistory,
  threadsForTask,
  toTask,
} from "../store/tasks.ts";
import { endWait, listWaits, recordWait } from "../store/waits.ts";
import { knownName } from "../store/areas.ts";
import { conflictDetail, listConflicts } from "../store/conflicts.ts";
import {
  areaHistory,
  createArea,
  editArea,
  findAreaByName,
  listAreas,
  listPeople,
  type AreaActor,
} from "../store/areas.ts";
import {
  confirmDecisionByPerson,
  decisionDetail,
  editDecisionByPerson,
  rejectDecisionByPerson,
} from "./decisions.ts";
import type { DecisionActor } from "../store/decisions.ts";
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
  /** The checker's GitHub client, review token and reviewer (slice 4.3). */
  checker?: CheckerServices | undefined;
  /** Where tasks come from (slice 3.3). Built with storage, whether or not the agent is. */
  tasks?: TaskSource | undefined;
  /** The web app's origin, for the links in briefs (slice 3.4). */
  webBaseUrl?: string | undefined;
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

  // Who may call with a person token as well as the service token (decisions 193 and 194).
  const people = requireServiceOrPerson(deps.config.serviceToken, deps.config.personAuth);

  /**
   * Who acts on a decision: a signed-in person is who their token says, and their body must be
   * empty of anyone else; the service token (Slack) names the person who pressed (202).
   */
  const actorOf = (
    caller: ApiEnv["Variables"]["caller"],
    body: unknown,
  ): DecisionActor | undefined => {
    if (caller.kind === "person") {
      return {
        source: "slack",
        workspaceId: caller.workspaceId,
        actorId: caller.actorId,
        name: caller.name,
      };
    }
    const parsed = confirmDecisionRequestSchema.safeParse(body);
    return parsed.success
      ? {
          source: parsed.data.source,
          workspaceId: parsed.data.workspaceId,
          actorId: parsed.data.actor.id,
          name: parsed.data.actor.displayName ?? null,
        }
      : undefined;
  };

  async function jsonBody(c: Context<ApiEnv>): Promise<{ body: unknown } | undefined> {
    try {
      return { body: await c.req.json() };
    } catch {
      return undefined;
    }
  }

  // A person confirms or rejects a proposed decision (slices 2.2 and 2.6, decisions 192 and
  // 201): from Slack, through the service token, or from the web app, signed in.
  for (const action of ["confirm", "reject"] as const) {
    api.post(`/v1/decisions/:decisionId/${action}`, people, limitBody, async (c) => {
      const decisionId = conversationIdSchema.safeParse(c.req.param("decisionId"));
      if (!decisionId.success) return errorResponse(c, 404, "not_found", "No such decision");
      const read = await jsonBody(c);
      if (read === undefined) {
        return errorResponse(c, 400, "invalid_request", "Request body must be JSON");
      }
      const caller = c.var.caller;
      // A person sends only the wording they saw; the service names who pressed, and a Slack
      // button means the wording first posted, 1 (decision 203).
      let wordingVersion: number | undefined;
      if (caller.kind === "person") {
        const own = personDecisionActionSchema.safeParse(read.body);
        if (!own.success) {
          return errorResponse(c, 400, "invalid_request", "Request body must be the wording seen");
        }
        wordingVersion = own.data.wordingVersion;
      } else {
        wordingVersion =
          confirmDecisionRequestSchema.safeParse(read.body).data?.wordingVersion ?? 1;
      }
      const person = actorOf(caller, read.body);
      if (person === undefined) {
        return errorResponse(c, 400, "invalid_request", "Request body is invalid");
      }
      if (deps.conversations === undefined) {
        return errorResponse(c, 503, "not_configured", "Conversations are not configured");
      }
      if (action === "confirm") {
        const result = await confirmDecisionByPerson(
          deps.conversations,
          decisionId.data,
          {
            source: person.source,
            workspaceId: person.workspaceId,
            actor:
              person.name === null
                ? { id: person.actorId }
                : { id: person.actorId, displayName: person.name },
            wordingVersion,
          },
          c.var.log,
        );
        return c.json(result, 202);
      }
      return c.json(
        await rejectDecisionByPerson(
          deps.conversations,
          decisionId.data,
          person,
          wordingVersion,
          c.var.log,
        ),
      );
    });
  }

  // A signed-in person rewords a proposal before it is confirmed (slice 2.6, decision 201).
  api.patch("/v1/decisions/:decisionId", people, limitBody, async (c) => {
    const decisionId = conversationIdSchema.safeParse(c.req.param("decisionId"));
    if (!decisionId.success) return errorResponse(c, 404, "not_found", "No such decision");
    const caller = c.var.caller;
    if (caller.kind !== "person") {
      return errorResponse(c, 400, "invalid_request", "Only a signed-in person edits a decision");
    }
    const read = await jsonBody(c);
    const edit = editDecisionRequestSchema.safeParse(read?.body);
    if (!edit.success) return errorResponse(c, 400, "invalid_request", "Request body is invalid");
    const db = deps.conversations?.db ?? deps.status.db;
    if (db === undefined) {
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    }
    const person = actorOf(caller, undefined);
    if (person === undefined) return errorResponse(c, 400, "invalid_request", "No person");
    return c.json(await editDecisionByPerson(db, decisionId.data, person, edit.data, c.var.log));
  });

  // Who the API takes the caller to be: a service, or a person signed in to the web app
  // (decisions 193 and 194). The web app reads it to show who is signed in.
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
  // Areas and their owners (slice 3.1, decisions 205 and 206). Anyone signed in may create or
  // change one, as themselves, on the version they saw; the service token only reads.
  const placeOf = (caller: ApiEnv["Variables"]["caller"]) =>
    caller.kind === "person"
      ? { source: "slack" as const, workspaceId: caller.workspaceId }
      : deps.config.personAuth === undefined
        ? undefined
        : { source: "slack" as const, workspaceId: deps.config.personAuth.workspaceId };

  api.get("/v1/areas", readers, async (c) => {
    const db = deps.conversations?.db ?? deps.status.db;
    const place = placeOf(c.var.caller);
    if (db === undefined || place === undefined) {
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    }
    const fallback = deps.conversations?.fallback;
    const people = fallback === undefined ? [] : await listPeople(db, place);
    const body: AreaList = {
      areas: await listAreas(db, place),
      fallbackOwner:
        fallback === undefined
          ? null
          : {
              actorId: fallback.actorId,
              name: people.find((p) => p.actorId === fallback.actorId)?.name ?? null,
            },
    };
    return c.json(body);
  });

  api.get("/v1/areas/:name", readers, async (c) => {
    const db = deps.conversations?.db ?? deps.status.db;
    const place = placeOf(c.var.caller);
    if (db === undefined || place === undefined) {
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    }
    // Hono has decoded the segment already.
    const area = await findAreaByName(db, place, c.req.param("name"));
    if (area === undefined) return errorResponse(c, 404, "not_found", "No such area");
    const body: AreaDetail = { area, history: await areaHistory(db, area.id) };
    return c.json(body);
  });

  api.get("/v1/people", readers, async (c) => {
    const db = deps.conversations?.db ?? deps.status.db;
    const place = placeOf(c.var.caller);
    if (db === undefined || place === undefined) {
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    }
    const body: PeopleList = { people: await listPeople(db, place) };
    return c.json(body);
  });

  const areaWriter = (c: Context<ApiEnv>): AreaActor | undefined => {
    const caller = c.var.caller;
    return caller.kind === "person"
      ? {
          source: "slack",
          workspaceId: caller.workspaceId,
          actorId: caller.actorId,
          name: caller.name,
        }
      : undefined;
  };

  api.post("/v1/areas", people, limitBody, async (c) => {
    const actor = areaWriter(c);
    if (actor === undefined) {
      return errorResponse(c, 400, "invalid_request", "Only a signed-in person changes areas");
    }
    const parsed = createAreaRequestSchema.safeParse((await jsonBody(c))?.body);
    if (!parsed.success) return errorResponse(c, 400, "invalid_request", "Request body is invalid");
    const db = deps.conversations?.db ?? deps.status.db;
    if (db === undefined) {
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    }
    const result = await createArea(db, actor, parsed.data);
    c.var.log.info("area.create", { name: parsed.data.name, status: result.status });
    const body: AreaActionResult = result.area === undefined ? { status: result.status } : result;
    return c.json(body, result.status === "created" ? 201 : 200);
  });

  api.patch("/v1/areas/:areaId", people, limitBody, async (c) => {
    const actor = areaWriter(c);
    if (actor === undefined) {
      return errorResponse(c, 400, "invalid_request", "Only a signed-in person changes areas");
    }
    const areaId = conversationIdSchema.safeParse(c.req.param("areaId"));
    if (!areaId.success) return errorResponse(c, 404, "not_found", "No such area");
    const parsed = editAreaRequestSchema.safeParse((await jsonBody(c))?.body);
    if (!parsed.success) return errorResponse(c, 400, "invalid_request", "Request body is invalid");
    const db = deps.conversations?.db ?? deps.status.db;
    if (db === undefined) {
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    }
    const result = await editArea(db, actor, areaId.data, parsed.data);
    c.var.log.info("area.edit", { areaId: areaId.data, status: result.status });
    const body: AreaActionResult = result.area === undefined ? { status: result.status } : result;
    return c.json(body);
  });

  // Conflicts and who decides them (slice 3.2, decision 208): read by anyone signed in or the
  // service; settled by a signed-in decider, as themselves.
  api.get("/v1/conflicts", readers, async (c) => {
    const query = listConflictsQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidQuery(c, query.error);
    const db = deps.conversations?.db ?? deps.status.db;
    const place = placeOf(c.var.caller);
    if (db === undefined || place === undefined) {
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    }
    const body: ConflictList = { conflicts: await listConflicts(db, place, query.data) };
    return c.json(body);
  });

  api.get("/v1/conflicts/:number", readers, async (c) => {
    const number = z.coerce
      .number()
      .int()
      .positive()
      .max(1_000_000_000)
      .safeParse(c.req.param("number"));
    if (!number.success) return errorResponse(c, 404, "not_found", "No such conflict");
    const db = deps.conversations?.db ?? deps.status.db;
    const place = placeOf(c.var.caller);
    if (db === undefined || place === undefined) {
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    }
    const caller = c.var.caller;
    const detail = await conflictDetail(
      db,
      place,
      number.data,
      caller.kind === "person" ? caller.actorId : undefined,
      deps.conversations?.fallback,
    );
    if (detail === undefined) return errorResponse(c, 404, "not_found", "No such conflict");
    return c.json(detail);
  });

  api.post("/v1/conflicts/:conflictId/settle", people, limitBody, async (c) => {
    const caller = c.var.caller;
    if (caller.kind !== "person") {
      return errorResponse(c, 400, "invalid_request", "Only a signed-in person settles a conflict");
    }
    const conflictId = conversationIdSchema.safeParse(c.req.param("conflictId"));
    if (!conflictId.success) return errorResponse(c, 404, "not_found", "No such conflict");
    const parsed = settleConflictRequestSchema.safeParse((await jsonBody(c))?.body);
    if (!parsed.success) return errorResponse(c, 400, "invalid_request", "Request body is invalid");
    if (deps.conversations === undefined) {
      return errorResponse(c, 503, "not_configured", "Conversations are not configured");
    }
    const person = actorOf(caller, undefined);
    if (person === undefined) return errorResponse(c, 400, "invalid_request", "No person");
    return c.json(
      await settleConflictByPerson(
        deps.conversations,
        conflictId.data,
        person,
        parsed.data,
        c.var.log,
      ),
    );
  });

  // Tasks behind one provider, and the waiting-on list (slice 3.3, decision 210). Read by
  // anyone signed in or the service; a person writes as themselves.
  const taskSource = (db: NonNullable<typeof deps.status.db>) =>
    deps.tasks ?? deps.conversations?.tasks ?? createTaskSource({ kind: "builtin" }, db, deps.log);
  const storage = (c: Context<ApiEnv>) => {
    const db = deps.conversations?.db ?? deps.status.db;
    const place = placeOf(c.var.caller);
    return db === undefined || place === undefined ? undefined : { db, place };
  };
  const writer = (c: Context<ApiEnv>): AreaActor | undefined => areaWriter(c);

  api.get("/v1/tasks", readers, async (c) => {
    const query = listTasksQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidQuery(c, query.error);
    const at = storage(c);
    if (at === undefined)
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    return c.json(await taskSource(at.db).list(at.place, query.data));
  });

  api.get("/v1/tasks/:key", readers, async (c) => {
    const key = taskKeySchema.safeParse(c.req.param("key"));
    if (!key.success) return errorResponse(c, 404, "not_found", "No such task");
    const at = storage(c);
    if (at === undefined)
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    const source = taskSource(at.db);
    const found = await source.get(at.place, key.data);
    if (found.kind === "missing") return errorResponse(c, 404, "not_found", "No such task");
    if (found.kind === "unavailable") {
      return errorResponse(c, 503, "not_configured", "The task provider is not available");
    }
    const row =
      source.provider === "builtin" ? await findBuiltinTask(at.db, at.place, key.data) : undefined;
    const body: TaskDetail = {
      provider: source.provider,
      task: found.task,
      builtin:
        row === undefined
          ? null
          : {
              id: row.id,
              description: row.description,
              version: row.version,
              createdBy: { actorId: row.created_by_actor_id, name: row.created_by_name },
              createdAt: row.created_at.toISOString(),
              history: await taskHistory(at.db, row.id),
            },
      threads: await threadsForTask(at.db, at.place, key.data),
      waits: await listWaits(at.db, at.place, { status: "all", task: key.data, limit: 50 }),
    };
    return c.json(body);
  });

  api.post("/v1/tasks", people, limitBody, async (c) => {
    const actor = writer(c);
    if (actor === undefined) {
      return errorResponse(c, 400, "invalid_request", "Only a signed-in person changes tasks");
    }
    const parsed = createTaskRequestSchema.safeParse((await jsonBody(c))?.body);
    if (!parsed.success) return errorResponse(c, 400, "invalid_request", "Request body is invalid");
    const at = storage(c);
    if (at === undefined)
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    if (taskSource(at.db).provider !== "builtin") {
      const body: TaskActionResult = { status: "not_builtin" };
      return c.json(body);
    }
    if (!(await knownAssignee(at.db, at.place, actor, parsed.data.assigneeActorId))) {
      const body: TaskActionResult = { status: "unknown_person" };
      return c.json(body);
    }
    const result = await createTask(at.db, actor, parsed.data);
    c.var.log.info("task.create", { status: result.status });
    const body: TaskActionResult =
      result.row === undefined
        ? { status: result.status }
        : { status: result.status, task: toTask(result.row) };
    return c.json(body, 201);
  });

  api.patch("/v1/tasks/:taskId", people, limitBody, async (c) => {
    const actor = writer(c);
    if (actor === undefined) {
      return errorResponse(c, 400, "invalid_request", "Only a signed-in person changes tasks");
    }
    const taskId = conversationIdSchema.safeParse(c.req.param("taskId"));
    if (!taskId.success) return errorResponse(c, 404, "not_found", "No such task");
    const parsed = editTaskRequestSchema.safeParse((await jsonBody(c))?.body);
    if (!parsed.success) return errorResponse(c, 400, "invalid_request", "Request body is invalid");
    const at = storage(c);
    if (at === undefined)
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    if (taskSource(at.db).provider !== "builtin") {
      const body: TaskActionResult = { status: "not_builtin" };
      return c.json(body);
    }
    if (!(await knownAssignee(at.db, at.place, actor, parsed.data.assigneeActorId))) {
      const body: TaskActionResult = { status: "unknown_person" };
      return c.json(body);
    }
    const result = await editTask(at.db, actor, taskId.data, parsed.data);
    c.var.log.info("task.edit", { taskId: taskId.data, status: result.status });
    const body: TaskActionResult =
      result.row === undefined
        ? { status: result.status }
        : { status: result.status, task: toTask(result.row) };
    return c.json(body);
  });

  api.get("/v1/waits", readers, async (c) => {
    const query = listWaitsQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidQuery(c, query.error);
    const at = storage(c);
    if (at === undefined)
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    const body: WaitList = { waits: await listWaits(at.db, at.place, query.data) };
    return c.json(body);
  });

  api.post("/v1/waits", people, limitBody, async (c) => {
    const actor = writer(c);
    if (actor === undefined) {
      return errorResponse(c, 400, "invalid_request", "Only a signed-in person records a wait");
    }
    const parsed = createWaitRequestSchema.safeParse((await jsonBody(c))?.body);
    if (!parsed.success) return errorResponse(c, 400, "invalid_request", "Request body is invalid");
    const at = storage(c);
    if (at === undefined)
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    const on = parsed.data.waitingOnActorId;
    const onName = await knownName(at.db, at.place, on);
    // Only someone the record knows, and never oneself.
    if (on === actor.actorId || (onName === null && !(await isKnown(at.db, at.place, on)))) {
      const body: WaitActionResult = { status: "unknown_person" };
      return c.json(body);
    }
    const me = { actorId: actor.actorId, name: actor.name };
    const { wait } = await recordWait(at.db, {
      place: at.place,
      waiter: me,
      waitingOn: { actorId: on, name: onName },
      what: parsed.data.what,
      taskKey: parsed.data.taskKey ?? null,
      conversationId: null,
      recordedBy: me,
    });
    c.var.log.info("wait.record", { number: wait.number });
    const body: WaitActionResult = { status: "recorded", wait };
    return c.json(body, 201);
  });

  api.post("/v1/waits/:waitId/end", people, limitBody, async (c) => {
    const actor = writer(c);
    if (actor === undefined) {
      return errorResponse(c, 400, "invalid_request", "Only a signed-in person ends a wait");
    }
    const waitId = conversationIdSchema.safeParse(c.req.param("waitId"));
    if (!waitId.success) return errorResponse(c, 404, "not_found", "No such wait");
    const at = storage(c);
    if (at === undefined)
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    const result = await endWait(at.db, actor, { id: waitId.data });
    c.var.log.info("wait.end", { waitId: waitId.data, status: result.status });
    const body: WaitActionResult =
      result.wait === undefined
        ? { status: result.status }
        : { status: result.status, wait: result.wait };
    return c.json(body);
  });

  // Daily briefs (slice 3.4, decision 212): a person's preview and switch in the web app, and
  // "stop briefs" or "start briefs" written to the bot, which Slack passes on.
  api.get("/v1/briefs/me", people, async (c) => {
    const caller = c.var.caller;
    if (caller.kind !== "person") {
      return errorResponse(c, 400, "invalid_request", "Only a signed-in person has a brief");
    }
    const at = storage(c);
    if (at === undefined)
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    return c.json(
      await myBrief(
        at.db,
        at.place,
        caller.actorId,
        deps.webBaseUrl,
        new Date(),
        deps.conversations?.fallback,
      ),
    );
  });

  api.post("/v1/briefs/me", people, limitBody, async (c) => {
    const caller = c.var.caller;
    if (caller.kind !== "person") {
      return errorResponse(c, 400, "invalid_request", "Only a signed-in person switches briefs");
    }
    const parsed = setMyBriefsRequestSchema.safeParse((await jsonBody(c))?.body);
    if (!parsed.success) return errorResponse(c, 400, "invalid_request", "Request body is invalid");
    const at = storage(c);
    if (at === undefined)
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    await setBriefs(at.db, at.place, caller.actorId, parsed.data.on);
    c.var.log.info("brief.switch", { on: parsed.data.on, via: "web" });
    const body: SetBriefsResult = { on: parsed.data.on };
    return c.json(body);
  });

  api.post("/v1/briefs/people", serviceOnly, limitBody, async (c) => {
    const parsed = setBriefsRequestSchema.safeParse((await jsonBody(c))?.body);
    if (!parsed.success) return errorResponse(c, 400, "invalid_request", "Request body is invalid");
    const db = deps.conversations?.db ?? deps.status.db;
    if (db === undefined) {
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    }
    const { source, workspaceId, actor, on } = parsed.data;
    await setBriefs(db, { source, workspaceId }, actor.id, on);
    c.var.log.info("brief.switch", { on, via: source });
    const body: SetBriefsResult = { on };
    return c.json(body);
  });

  // Standing jobs (slice 4.1, decision 215): read by the service and anyone signed in; changed
  // by a person in 4.2.
  api.get("/v1/jobs", readers, async (c) => {
    const at = storage(c);
    if (at === undefined)
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    const body: JobList = { jobs: await listJobs(at.db, at.place) };
    return c.json(body);
  });

  api.get("/v1/jobs/:name", readers, async (c) => {
    const at = storage(c);
    if (at === undefined)
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    const job = await findJob(at.db, at.place, c.req.param("name"));
    if (job === undefined) return errorResponse(c, 404, "not_found", "No such job");
    const body: JobDetail = {
      job,
      wakes: await jobWakes(at.db, job.id),
      history: await jobHistory(at.db, job.id),
    };
    return c.json(body);
  });

  // A person changes a job, as themselves, on the version they saw (slice 4.2, decision 217).
  api.patch("/v1/jobs/:jobId", people, limitBody, async (c) => {
    const actor = writer(c);
    if (actor === undefined) {
      return errorResponse(c, 400, "invalid_request", "Only a signed-in person changes jobs");
    }
    const jobId = conversationIdSchema.safeParse(c.req.param("jobId"));
    if (!jobId.success) return errorResponse(c, 404, "not_found", "No such job");
    const parsed = editJobRequestSchema.safeParse((await jsonBody(c))?.body);
    if (!parsed.success) return errorResponse(c, 400, "invalid_request", "Request body is invalid");
    const at = storage(c);
    if (at === undefined)
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    const result = await editJob(at.db, actor, jobId.data, parsed.data);
    c.var.log.info("job.edit", { jobId: jobId.data, status: result.status });
    const body: JobActionResult =
      result.job === undefined
        ? { status: result.status }
        : { status: result.status, job: result.job };
    return c.json(body);
  });

  // One decision by its number, its history, and what the signed-in person may do (2.6).
  api.get("/v1/decisions/:number", readers, async (c) => {
    const number = z.coerce
      .number()
      .int()
      .positive()
      .max(1_000_000_000)
      .safeParse(c.req.param("number"));
    if (!number.success) return errorResponse(c, 404, "not_found", "No such decision");
    const db = deps.conversations?.db ?? deps.status.db;
    if (db === undefined) {
      return errorResponse(c, 503, "not_configured", "Storage is not configured");
    }
    const caller = c.var.caller;
    const detail = await decisionDetail(
      db,
      number.data,
      caller.kind === "person" ? actorOf(caller, undefined) : undefined,
    );
    if (detail === undefined) return errorResponse(c, 404, "not_found", "No such decision");
    return c.json(detail);
  });

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
        statuses:
          query.data.status === undefined
            ? undefined
            : query.data.status === "all"
              ? ["active", "proposed", "superseded", "rejected"]
              : [query.data.status],
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
        // After the lease: the areas its pull request's files touch (slice 3.1).
        await namePullRequestAreas(deps.conversations, change.id, log);
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
    // First, what listening keeps past 30 days (G8). It needs only storage, so it runs even
    // when the agent is not configured, and a failure in the steps after it cannot stop it.
    const db = deps.conversations?.db ?? deps.status.db;
    let expired = 0;
    if (db !== undefined) {
      try {
        const deleted = await deleteExpiredObservations(db, new Date());
        expired = deleted.messages;
        if (deleted.messages > 0 || deleted.threads > 0) {
          c.var.log.info("listening.expired", { ...deleted });
        }
      } catch (error) {
        c.var.log.error("listening.expiry_failed", { error });
      }
    }
    if (deps.conversations === undefined) {
      return errorResponse(c, 503, "not_configured", "Conversations are not configured");
    }
    const result = await reconcile(deps.conversations, c.var.log);
    // Then catch up a few conversations from before the record existed (decision 80).
    const backfilled = await backfillRecord(deps.conversations, c.var.log);
    if (result.checked > 0 || backfilled > 0) {
      c.var.log.info("reconcile.done", { ...result, backfilled });
    }
    // Last, the standing jobs (slice 4.1): capture (2.5), briefs (3.4) and the checker (4.3), after
    // every conversation has been let go, each wake logged, and never failing reconcile.
    const jobs = await runJobs(
      {
        db: deps.conversations.db,
        place:
          deps.config.workspaceId === undefined
            ? undefined
            : { source: "slack", workspaceId: deps.config.workspaceId },
        fallback: deps.conversations.fallback,
        capture: deps.capture,
        briefs: {
          deliverer: deps.conversations.deliverers.slack,
          webBaseUrl: deps.webBaseUrl,
          fallback: deps.conversations.fallback,
        },
        // The checker (slice 4.3) posts its line in a change's thread through the loop.
        checker:
          deps.checker === undefined
            ? undefined
            : { ...deps.checker, conversations: deps.conversations },
      },
      c.var.log.child({ area: "jobs" }),
    );
    if (jobs.woke > 0 && (jobs.said > 0 || jobs.failed > 0 || jobs.skipped > 0)) {
      c.var.log.info("jobs.done", { ...jobs });
    }
    return c.json({ ...result, backfilled, expired, jobs });
  });

  return api;
}

/** Whether the record knows a person by id, though it has no name for them. */
async function isKnown(
  db: NonNullable<StatusDeps["db"]>,
  place: { source: string; workspaceId: string },
  actorId: string,
): Promise<boolean> {
  const rows = await db.query(
    `select 1 from inbound_messages where source = $1 and workspace_id = $2 and actor_id = $3
     union all
     select 1 from areas where source = $1 and workspace_id = $2
       and (owner_actor_id = $3 or created_by_actor_id = $3)
     limit 1`,
    [place.source, place.workspaceId, actorId],
  );
  return rows.length > 0;
}

/** An assignee is someone the record knows, or the person assigning (from the review of 3.3). */
async function knownAssignee(
  db: NonNullable<StatusDeps["db"]>,
  place: { source: "slack" | "ui"; workspaceId: string },
  actor: { actorId: string },
  assignee: string | null | undefined,
): Promise<boolean> {
  if (assignee == null || assignee === actor.actorId) return true;
  return (await knownName(db, place, assignee)) !== null || (await isKnown(db, place, assignee));
}
