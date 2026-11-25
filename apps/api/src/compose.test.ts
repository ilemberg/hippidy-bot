import {
  decisionListSchema,
  acceptedMessageSchema,
  CORRELATION_ID_HEADER,
  errorResponseSchema,
  statusResponseSchema,
  type InboundMessage,
} from "@hippidy/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "./agent/fake.ts";
import type { VerifyAgentWebhook } from "./agent/webhooks.ts";
import type { ConversationDeps } from "./api/conversations.ts";
import { RecordingDeliverer } from "./api/testing.ts";
import type { ApiEnv } from "./api/types.ts";
import { configureApp } from "./compose.ts";
import type { Env } from "./config.ts";
import { createTestDb } from "./store/testing.ts";
import { memoryLogger } from "./testing.ts";

const token = "t".repeat(48);
const reconcileToken = "r".repeat(48);

const message: InboundMessage = {
  source: "slack",
  sourceEventId: "Ev0123456789",
  conversation: {
    workspaceId: "T0123456789",
    channelId: "C0123456789",
    threadId: "1763400000.000100",
    messageId: "1763400000.000100",
  },
  actor: { id: "U0123456789" },
  text: "hello",
  sentAt: "2025-11-17T17:20:00.000Z",
};

let db: Awaited<ReturnType<typeof createTestDb>>;
let runtime: FakeAgentRuntime;
let slack: RecordingDeliverer;

beforeEach(async () => {
  db = await createTestDb();
  runtime = new FakeAgentRuntime();
  slack = new RecordingDeliverer();
});

afterEach(async () => {
  await db.close();
});

/** A webhook check for tests: accepts a body that carries `"signed": true`. */
const verifyAgentWebhook: VerifyAgentWebhook = (body) => {
  const event = JSON.parse(body) as {
    signed?: boolean;
    id: string;
    type: string;
    sessionId: string;
  };
  if (event.signed !== true) throw new Error("bad signature");
  return { id: event.id, type: event.type, resourceId: event.sessionId };
};

function setup(
  env: Env = { API_SERVICE_TOKEN: token, RECONCILE_TOKEN: reconcileToken },
  options: { configured?: boolean } = {},
) {
  const { log, lines } = memoryLogger();
  const conversations: ConversationDeps = {
    db,
    runtime,
    deliverers: { slack },
    sleep: () => Promise.resolve(),
  };
  const services = options.configured === false ? {} : { conversations, verifyAgentWebhook };
  const app = configureApp(new Hono<ApiEnv>(), { env, log, services });
  return { app, lines };
}

function postMessage(
  app: ReturnType<typeof setup>["app"],
  body: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${token}` },
) {
  return app.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = errorResponseSchema.parse(await res.json());
  expect(body.error.code).toBe(code);
  return body;
}

describe("GET /health", () => {
  it("returns 200", async () => {
    const { app } = setup();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("works with no configuration at all", async () => {
    const { app } = setup({});
    expect((await app.request("/health")).status).toBe(200);
  });
});

describe("GET /status", () => {
  it("answers 200 without a token when every part works", async () => {
    const { log } = memoryLogger();
    const app = configureApp(new Hono<ApiEnv>(), {
      env: {},
      log,
      services: { status: { db, configured: { agent: true, slack: true, github: true } } },
    });
    const res = await app.request("/status");
    expect(res.status).toBe(200);
    expect(statusResponseSchema.parse(await res.json()).status).toBe("ok");
  });

  it("answers 503 with no configuration at all, naming what is missing", async () => {
    const { app } = setup({});
    const res = await app.request("/status");
    expect(res.status).toBe(503);
    expect(statusResponseSchema.parse(await res.json())).toEqual({
      status: "degraded",
      checks: {
        database: "not_configured",
        agent: "not_configured",
        slack: "not_configured",
        github: "not_configured",
      },
    });
  });
});

describe("POST /v1/messages", () => {
  it("accepts a valid message with 202 and an id, and logs it", async () => {
    const { app, lines } = setup();
    const res = await postMessage(app, message, {
      authorization: `Bearer ${token}`,
      [CORRELATION_ID_HEADER]: "Ev0123456789",
    });

    expect(res.status).toBe(202);
    const body = acceptedMessageSchema.parse(await res.json());
    expect(res.headers.get(CORRELATION_ID_HEADER)).toBe("Ev0123456789");
    expect(body.duplicate).toBeUndefined();
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: "message.received", correlationId: "Ev0123456789", message }),
    );
    expect(runtime.sessions.get(runtime.onlySessionId())?.sent).toHaveLength(1);
  });

  it("says when a message was already received", async () => {
    const { app } = setup();
    await postMessage(app, message);
    const again = acceptedMessageSchema.parse(await (await postMessage(app, message)).json());
    expect(again.duplicate).toBe(true);
  });

  it("answers 503 when storage or the agent is not configured", async () => {
    const { app } = setup(undefined, { configured: false });
    await expectError(await postMessage(app, message), 503, "not_configured");
  });

  it("generates a correlation id when none is sent", async () => {
    const { app } = setup();
    const res = await postMessage(app, message);
    expect(res.headers.get(CORRELATION_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("replaces a malformed correlation id", async () => {
    const { app } = setup();
    const res = await postMessage(app, message, {
      authorization: `Bearer ${token}`,
      [CORRELATION_ID_HEADER]: "bad id\twith spaces",
    });
    expect(res.headers.get(CORRELATION_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects an invalid body with 400 and lists the problems", async () => {
    const { app } = setup();
    const res = await postMessage(app, { ...message, source: "email" });
    const body = await expectError(res, 400, "invalid_request");
    expect(body.error.issues?.map((issue) => issue.path)).toContain("source");
  });

  it("rejects a body that is not JSON with 400", async () => {
    const { app } = setup();
    await expectError(await postMessage(app, "{not json"), 400, "invalid_request");
  });

  it("rejects a body over 64 KB with 413", async () => {
    const { app } = setup();
    const res = await postMessage(app, { ...message, text: "x".repeat(70_000) });
    await expectError(res, 413, "invalid_request");
  });

  it("rejects a request without a token with 401", async () => {
    const { app } = setup();
    await expectError(await postMessage(app, message, {}), 401, "unauthorized");
  });

  it("rejects a wrong token with 401", async () => {
    const { app } = setup();
    const res = await postMessage(app, message, { authorization: `Bearer ${"w".repeat(48)}` });
    await expectError(res, 401, "unauthorized");
  });

  it("rejects a token sent without the Bearer scheme", async () => {
    const { app } = setup();
    await expectError(
      await postMessage(app, message, { authorization: token }),
      401,
      "unauthorized",
    );
  });

  it("rejects every request when no token is configured", async () => {
    const { app } = setup({});
    for (const guess of ["Bearer undefined", "Bearer ", "Bearer null", ""]) {
      await expectError(
        await postMessage(app, message, { authorization: guess }),
        401,
        "unauthorized",
      );
    }
  });

  it("rejects every request when the configured token is too short", async () => {
    const { app } = setup({ API_SERVICE_TOKEN: "short" });
    const res = await postMessage(app, message, { authorization: "Bearer short" });
    await expectError(res, 401, "unauthorized");
  });

  it("checks the token before reading the body", async () => {
    const { app } = setup();
    await expectError(await postMessage(app, "{not json", {}), 401, "unauthorized");
  });
});

describe("correlation and logging", () => {
  it("logs rejected requests with the correlation id", async () => {
    const { app, lines } = setup();
    await postMessage(app, message, { [CORRELATION_ID_HEADER]: "Ev-abc" });
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: "auth.rejected", correlationId: "Ev-abc" }),
    );
  });

  it("warns when the correlation id differs from the source event id", async () => {
    const { app, lines } = setup();
    await postMessage(app, message, {
      authorization: `Bearer ${token}`,
      [CORRELATION_ID_HEADER]: "something-else",
    });
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: "message.correlation_mismatch",
        correlationId: "something-else",
      }),
    );
  });

  it("accepts a lower-case bearer scheme", async () => {
    const { app } = setup();
    const res = await postMessage(app, message, { authorization: `bearer ${token}` });
    expect(res.status).toBe(202);
  });

  it("answers an unexpected error with 500 and logs it with the correlation id", async () => {
    const { app, lines } = setup();
    runtime.failNext.sendMessage = new Error("agent runtime broke");
    const res = await postMessage(app, message, {
      authorization: `Bearer ${token}`,
      [CORRELATION_ID_HEADER]: "Ev0123456789",
    });
    await expectError(res, 500, "internal");
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: "request.failed",
        correlationId: "Ev0123456789",
        error: expect.objectContaining({ message: "agent runtime broke" }) as unknown,
      }),
    );
  });
});

describe("POST /v1/stop", () => {
  function stop(app: ReturnType<typeof setup>["app"], body: unknown, auth = `Bearer ${token}`) {
    return app.request("/v1/stop", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify(body),
    });
  }
  const request = {
    source: "slack",
    sourceEventId: "EvStop",
    workspaceId: message.conversation.workspaceId,
    channelId: message.conversation.channelId,
    threadId: message.conversation.threadId,
    actor: { id: "U1" },
  };

  it("stops the agent in the thread", async () => {
    const { app } = setup();
    await postMessage(app, message);
    const res = await stop(app, request);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "stopped" });
    expect(runtime.sessions.get(runtime.onlySessionId())?.interrupted).toBe(1);
  });

  it("needs a thread or a message, and the service token", async () => {
    const { app } = setup();
    const { threadId: _thread, ...noTarget } = request;
    await expectError(await stop(app, noTarget), 400, "invalid_request");
    await expectError(await stop(app, request, "Bearer nope"), 401, "unauthorized");
  });
});

describe("POST /v1/webhooks/agent", () => {
  function webhook(app: ReturnType<typeof setup>["app"], body: Record<string, unknown>) {
    return app.request("/v1/webhooks/agent", { method: "POST", body: JSON.stringify(body) });
  }

  it("posts the agent's reply when the session goes idle", async () => {
    const { app } = setup();
    await postMessage(app, message);
    const sessionId = runtime.onlySessionId();
    runtime.reply(sessionId, "Hi there.");

    const res = await webhook(app, {
      signed: true,
      id: "whe_1",
      type: "session.status_idled",
      sessionId,
    });
    expect(res.status).toBe(204);
    expect(slack.replies()).toEqual(["Hi there."]);
  });

  it("rejects a webhook with a bad signature, and does nothing", async () => {
    const { app } = setup();
    await postMessage(app, message);
    runtime.reply(runtime.onlySessionId(), "Hi there.");
    const res = await webhook(app, {
      id: "whe_1",
      type: "session.status_idled",
      sessionId: runtime.onlySessionId(),
    });
    await expectError(res, 400, "invalid_request");
    expect(slack.delivered).toEqual([]);
  });

  it("acknowledges webhooks it has nothing to do for", async () => {
    const { app } = setup();
    for (const body of [
      { signed: true, id: "whe_2", type: "session.status_run_started", sessionId: "sesn_x" },
      { signed: true, id: "whe_3", type: "session.status_idled", sessionId: "sesn_unknown" },
    ]) {
      expect((await webhook(app, body)).status).toBe(204);
    }
  });

  it("answers 503 until the signing key is configured", async () => {
    const { app } = setup(undefined, { configured: false });
    await expectError(await webhook(app, { signed: true }), 503, "not_configured");
  });
});

describe("a brief and its coding worker (slice 2.1)", () => {
  const brief = { title: "Rename", what: "Rename x.", why: "Asked.", doneWhen: "CI passes." };

  /** A person asks; the teammate reads a ticket, then writes a brief that needs a start. */
  async function briefNeedingStart(app: ReturnType<typeof setup>["app"]) {
    await postMessage(app, message);
    const teammate = runtime.onlySessionId();
    runtime.work(teammate);
    runtime.mcpToolUse(teammate, "atlassian", "getJiraIssue");
    runtime.callCustomTools(teammate, [{ name: "start_change", input: brief }]);
    await app.request("/v1/webhooks/agent", {
      method: "POST",
      body: JSON.stringify({
        signed: true,
        id: "whe_b",
        type: "session.status_idled",
        sessionId: teammate,
      }),
    });
    const posted = slack.delivered.find((d) => d.kind === "brief");
    if (posted?.kind !== "brief") throw new Error("no brief posted");
    return posted.briefId;
  }

  function start(
    app: ReturnType<typeof setup>["app"],
    briefId: string,
    body: unknown,
    auth = `Bearer ${token}`,
  ) {
    return app.request(`/v1/briefs/${briefId}/start`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify(body),
    });
  }
  const person = {
    source: "slack",
    workspaceId: message.conversation.workspaceId,
    actor: { id: "U2", displayName: "Grace" },
  };

  it("starts a brief for the person who pressed Start, once", async () => {
    const { app } = setup();
    const briefId = await briefNeedingStart(app);
    expect(runtime.sessions.size).toBe(1);
    const res = await start(app, briefId, person);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "started" });
    expect(runtime.sessions.size).toBe(2);
    expect(await (await start(app, briefId, person)).json()).toEqual({ status: "already_started" });
  });

  it("checks the token, the body and the brief's id", async () => {
    const { app } = setup();
    const briefId = await briefNeedingStart(app);
    await expectError(await start(app, briefId, person, "Bearer nope"), 401, "unauthorized");
    await expectError(await start(app, briefId, { ...person, actor: {} }), 400, "invalid_request");
    await expectError(await start(app, "not-a-brief", person), 404, "not_found");
    expect(await (await start(app, "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", person)).json()).toEqual(
      { status: "not_found" },
    );
  });

  it("syncs a coding worker when a webhook names its session", async () => {
    const { app } = setup();
    const briefId = await briefNeedingStart(app);
    await start(app, briefId, person);
    const worker = [...runtime.sessions.keys()][1] ?? "";
    runtime.reply(worker, "Opened the pull request.");
    const res = await app.request("/v1/webhooks/agent", {
      method: "POST",
      body: JSON.stringify({
        signed: true,
        id: "whe_w",
        type: "session.status_idled",
        sessionId: worker,
      }),
    });
    expect(res.status).toBe(204);
    expect(slack.replies()).toContain("Opened the pull request.");
  });
});

describe("decisions on record (slice 2.2)", () => {
  function get(app: ReturnType<typeof setup>["app"], path: string, auth = `Bearer ${token}`) {
    return app.request(path, { headers: { authorization: auth } });
  }

  it("lists the decisions, best matching first, behind the service token", async () => {
    const { app } = setup();
    const res = await get(app, "/v1/decisions?q=only%20a%20person%20merges&limit=3");
    expect(res.status).toBe(200);
    const body = decisionListSchema.parse(await res.json());
    expect(body.decisions.length).toBeGreaterThan(0);
    expect(body.decisions.length).toBeLessThanOrEqual(3);
    expect(body.decisions.every((d) => d.status === "active")).toBe(true);
    await expectError(await get(app, "/v1/decisions", "Bearer nope"), 401, "unauthorized");
    await expectError(await get(app, "/v1/decisions?limit=0"), 400, "invalid_request");
  });

  it("confirms only a decision it knows, with a valid body", async () => {
    const { app } = setup();
    const confirm = (id: string, body: unknown) =>
      app.request(`/v1/decisions/${id}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    const person = { source: "slack", workspaceId: "T1", actor: { id: "U2" } };
    await expectError(await confirm("nope", person), 404, "not_found");
    await expectError(
      await confirm("6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", { actor: {} }),
      400,
      "invalid_request",
    );
    const res = await confirm("6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", person);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "not_found" });
  });
});

describe("POST /v1/reconcile", () => {
  it("requires the reconcile token, and refuses the service token", async () => {
    const { app } = setup();
    await expectError(await app.request("/v1/reconcile", { method: "POST" }), 401, "unauthorized");
    const withServiceToken = await app.request("/v1/reconcile", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    await expectError(withServiceToken, 401, "unauthorized");
  });

  it("does not accept the reconcile token for messages", async () => {
    const { app } = setup();
    const res = await postMessage(app, message, { authorization: `Bearer ${reconcileToken}` });
    await expectError(res, 401, "unauthorized");
  });

  it("runs the safety net and reports what it checked", async () => {
    const { app } = setup();
    await postMessage(app, message);
    runtime.reply(runtime.onlySessionId(), "Recovered.");
    await db.query(`update conversations set waiting_since = now() - interval '2 minutes'`);

    const res = await app.request("/v1/reconcile", {
      method: "POST",
      headers: { authorization: `Bearer ${reconcileToken}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      checked: 1,
      failed: 0,
      backfilled: 0,
      captured: 0,
      expired: 0,
    });
    expect(slack.replies()).toEqual(["Recovered."]);
  });
});

describe("other routes", () => {
  it("returns 404 in the standard error shape", async () => {
    const { app } = setup();
    await expectError(await app.request("/nope"), 404, "not_found");
  });
});
