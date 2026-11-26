import {
  decisionListSchema,
  errorResponseSchema,
  listeningListSchema,
  observationResultSchema,
  setListeningResponseSchema,
} from "@hippidy/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../agent/fake.ts";
import { FakeExtractor } from "../agent/extractor.ts";
import { configureApp } from "../compose.ts";
import type { Env } from "../config.ts";
import { createTestDb } from "../store/testing.ts";
import { memoryLogger } from "../testing.ts";
import type { CaptureDeps } from "./capture.ts";
import type { ConversationDeps } from "./conversations.ts";
import { PERSON_SECRET, PERSON_WORKSPACE, RecordingDeliverer, signPersonToken } from "./testing.ts";
import type { ApiEnv } from "./types.ts";

// Slice 2.5's routes: listening switched by the Slack adapter, messages it forwards, the web
// app's page, and capture on reconcile (decision 199).

const serviceToken = "t".repeat(48);
const reconcileToken = "r".repeat(48);
const env: Env = {
  API_SERVICE_TOKEN: serviceToken,
  RECONCILE_TOKEN: reconcileToken,
  WEB_API_SECRET: PERSON_SECRET,
  SLACK_WORKSPACE_ID: PERSON_WORKSPACE,
};

let db: Awaited<ReturnType<typeof createTestDb>>;
let extractor: FakeExtractor;
let now: Date;

beforeEach(async () => {
  db = await createTestDb();
  extractor = new FakeExtractor();
  now = new Date();
});

afterEach(async () => {
  await db.close();
});

function setup() {
  const { log, lines } = memoryLogger();
  const conversations: ConversationDeps = {
    db,
    runtime: new FakeAgentRuntime(),
    deliverers: { slack: new RecordingDeliverer() },
    sleep: () => Promise.resolve(),
  };
  const capture: CaptureDeps = { db, extractor, dailyBudgetCents: 100, now: () => now };
  const app = configureApp(new Hono<ApiEnv>(), {
    env,
    log,
    services: {
      conversations,
      capture,
      status: { db, configured: { agent: true, slack: true, github: true } },
    },
  });
  return { app, lines };
}

const service = {
  authorization: `Bearer ${serviceToken}`,
  "content-type": "application/json",
};
const channel = { source: "slack", workspaceId: "T1", channelId: "C1" };

function send(app: ReturnType<typeof setup>["app"], method: string, path: string, body: unknown) {
  return app.request(path, { method, headers: service, body: JSON.stringify(body) });
}

function posted(messageId: string, minutesAgo: number) {
  return {
    kind: "posted",
    ...channel,
    messageId,
    threadId: "100.1",
    actor: { id: "U2", displayName: "Grace" },
    text: "Agreed: no vector store.",
    sentAt: new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
  };
}

describe("listening routes", () => {
  it("switches listening, keeps messages only while it is on, and shows it to a person", async () => {
    const { app } = setup();
    const observe = async (body: unknown) =>
      observationResultSchema.parse(
        await (await send(app, "POST", "/v1/observations", body)).json(),
      ).result;

    expect(await observe(posted("100.1", 40))).toBe("not_listening");
    const on = await send(app, "PUT", "/v1/listening", {
      ...channel,
      listening: true,
      actor: { id: "U1", displayName: "Ada" },
    });
    expect(setListeningResponseSchema.parse(await on.json())).toMatchObject({ changed: true });
    expect(await observe(posted("100.2", 40))).toBe("kept");
    expect(await observe({ kind: "deleted", ...channel, messageId: "100.2" })).toBe("deleted");

    const person = { authorization: `Bearer ${await signPersonToken()}` };
    const list = listeningListSchema.parse(
      await (await app.request("/v1/listening", { headers: person })).json(),
    );
    expect(list).toMatchObject({
      retentionDays: 30,
      channels: [{ channelId: "C1", listening: true, changedBy: { actorId: "U1", name: "Ada" } }],
    });
  });

  it("refuses a person, and a bad body", async () => {
    const { app } = setup();
    const person = {
      authorization: `Bearer ${await signPersonToken()}`,
      "content-type": "application/json",
    };
    for (const [method, path] of [
      ["PUT", "/v1/listening"],
      ["POST", "/v1/observations"],
    ] as const) {
      const res = await app.request(path, { method, headers: person, body: "{}" });
      expect(res.status).toBe(401);
      const bad = await send(app, method, path, { kind: "posted" });
      expect(bad.status).toBe(400);
      expect(errorResponseSchema.parse(await bad.json()).error.code).toBe("invalid_request");
    }
  });
});

describe("capture on reconcile", () => {
  it("reads a quiet thread after the conversations, and lists its proposal for a person", async () => {
    const { app } = setup();
    await send(app, "PUT", "/v1/listening", { ...channel, listening: true, actor: { id: "U1" } });
    await send(app, "POST", "/v1/observations", posted("100.1", 41));
    await send(app, "POST", "/v1/observations", posted("100.2", 40));
    extractor.answer({
      kind: "ok",
      usage: { inputTokens: 100, outputTokens: 10 },
      decisions: [
        {
          statement: "No vector store.",
          reason: null,
          area: null,
          decidedBy: "U2",
          messageId: "100.1",
        },
      ],
    });

    const res = await app.request("/v1/reconcile", {
      method: "POST",
      headers: { authorization: `Bearer ${reconcileToken}` },
    });
    // Capture runs as a standing job (slice 4.1): its wake says what it proposed.
    expect(await res.json()).toMatchObject({ jobs: { said: 1 } });
    expect(
      await db.query(
        `select w.outcome, w.summary from job_wakes w join jobs j on j.id = w.job_id
         where j.name = 'capture'`,
      ),
    ).toEqual([{ outcome: "said", summary: "1 proposal from 1 thread" }]);

    const person = { authorization: `Bearer ${await signPersonToken()}` };
    const decisions = decisionListSchema.parse(
      await (
        await app.request("/v1/decisions?status=proposed&origin=capture", { headers: person })
      ).json(),
    ).decisions;
    expect(decisions).toMatchObject([
      {
        statement: "No vector store.",
        origin: "capture",
        decidedBy: { actorId: "U2", name: "Grace" },
        channelId: "C1",
        threadId: "100.1",
        messageId: "100.1",
        conversationId: null,
      },
    ]);
  });

  it("deletes what listening kept after 30 days even when the agent is not configured", async () => {
    const { log, lines } = memoryLogger();
    const app = configureApp(new Hono<ApiEnv>(), {
      env,
      log,
      services: { status: { db, configured: { agent: false, slack: true, github: true } } },
    });
    await send(app, "PUT", "/v1/listening", { ...channel, listening: true, actor: { id: "U1" } });
    await send(app, "POST", "/v1/observations", posted("100.1", 31 * 24 * 60));
    const res = await app.request("/v1/reconcile", {
      method: "POST",
      headers: { authorization: `Bearer ${reconcileToken}` },
    });
    expect(res.status).toBe(503);
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: "listening.expired", messages: 1 }),
    );
    expect(await db.query(`select id from observed_messages`)).toEqual([]);
  });

  it("does not fail reconcile when capture throws", async () => {
    const { app, lines } = setup();
    await db.query(`drop table capture_runs cascade`);
    const res = await app.request("/v1/reconcile", {
      method: "POST",
      headers: { authorization: `Bearer ${reconcileToken}` },
    });
    expect(res.status).toBe(200);
    expect(lines).toContainEqual(expect.objectContaining({ msg: "job.wake_failed" }));
  });
});
