import {
  acceptedMessageSchema,
  CORRELATION_ID_HEADER,
  errorResponseSchema,
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
    expect(await res.json()).toEqual({ checked: 1, failed: 0 });
    expect(slack.replies()).toEqual(["Recovered."]);
  });
});

describe("other routes", () => {
  it("returns 404 in the standard error shape", async () => {
    const { app } = setup();
    await expectError(await app.request("/nope"), 404, "not_found");
  });
});
