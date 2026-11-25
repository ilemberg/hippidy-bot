import {
  conversationDetailSchema,
  conversationListSchema,
  errorResponseSchema,
  meResponseSchema,
  type InboundMessage,
} from "@hippidy/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../agent/fake.ts";
import { configureApp } from "../compose.ts";
import type { Env } from "../config.ts";
import { createTestDb } from "../store/testing.ts";
import { memoryLogger } from "../testing.ts";
import type { ConversationDeps } from "./conversations.ts";
import { PERSON_SECRET, PERSON_WORKSPACE, RecordingDeliverer, signPersonToken } from "./testing.ts";
import type { ApiEnv } from "./types.ts";

// A person signed in to the web app reaches the API with a person token (decision 194).

const serviceToken = "t".repeat(48);
const configured: Env = {
  API_SERVICE_TOKEN: serviceToken,
  WEB_API_SECRET: PERSON_SECRET,
  SLACK_WORKSPACE_ID: PERSON_WORKSPACE,
};

let db: Awaited<ReturnType<typeof createTestDb>>;
let deps: ConversationDeps;

beforeEach(async () => {
  db = await createTestDb();
  deps = {
    db,
    runtime: new FakeAgentRuntime(),
    deliverers: { slack: new RecordingDeliverer() },
    sleep: () => Promise.resolve(),
  };
});

afterEach(async () => {
  await db.close();
});

function setup(env: Env = configured) {
  const { log, lines } = memoryLogger();
  const app = configureApp(new Hono<ApiEnv>(), {
    env,
    log,
    services: {
      conversations: deps,
      status: { db, configured: { agent: true, slack: true, github: true } },
    },
  });
  return { app, lines };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function expectUnauthorized(res: Response) {
  expect(res.status).toBe(401);
  expect(errorResponseSchema.parse(await res.json()).error.code).toBe("unauthorized");
}

const message: InboundMessage = {
  source: "slack",
  sourceEventId: "Ev1",
  conversation: {
    workspaceId: PERSON_WORKSPACE,
    channelId: "C1",
    threadId: "1.1",
    messageId: "1.1",
  },
  actor: { id: "U1" },
  text: "hello",
  sentAt: "2026-11-25T00:00:00.000Z",
};

describe("GET /v1/me", () => {
  it("names the person of a person token", async () => {
    const { app, lines } = setup();
    const res = await app.request("/v1/me", { headers: bearer(await signPersonToken()) });
    expect(res.status).toBe(200);
    expect(meResponseSchema.parse(await res.json())).toEqual({
      kind: "person",
      workspaceId: PERSON_WORKSPACE,
      actorId: "U0123456789",
      name: "Ilya",
    });
    expect(lines.filter((line) => line.msg === "auth.rejected")).toEqual([]);
  });

  it("says service for the service token", async () => {
    const { app } = setup();
    const res = await app.request("/v1/me", { headers: bearer(serviceToken) });
    expect(meResponseSchema.parse(await res.json())).toEqual({ kind: "service" });
  });

  it("refuses no token, another workspace and a forged token, without logging the token", async () => {
    const { app, lines } = setup();
    await expectUnauthorized(await app.request("/v1/me"));
    const otherTeam = await signPersonToken({ team: "T9999999999" });
    await expectUnauthorized(await app.request("/v1/me", { headers: bearer(otherTeam) }));
    const forged = await signPersonToken({ secret: "f".repeat(48) });
    await expectUnauthorized(await app.request("/v1/me", { headers: bearer(forged) }));
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: "auth.rejected", detail: "wrong_workspace" }),
    );
    expect(JSON.stringify(lines)).not.toContain(forged);
    expect(JSON.stringify(lines)).not.toContain(PERSON_SECRET);
  });

  it.each([
    [
      "the shared secret is missing",
      { API_SERVICE_TOKEN: serviceToken, SLACK_WORKSPACE_ID: PERSON_WORKSPACE },
    ],
    ["the shared secret is too short", { ...configured, WEB_API_SECRET: "short" }],
    [
      "the workspace is missing",
      { API_SERVICE_TOKEN: serviceToken, WEB_API_SECRET: PERSON_SECRET },
    ],
    ["the workspace is not a team id", { ...configured, SLACK_WORKSPACE_ID: "my-team" }],
  ])("fails closed for people when %s, and keeps the service token working", async (_case, env) => {
    const { app } = setup(env);
    await expectUnauthorized(
      await app.request("/v1/me", { headers: bearer(await signPersonToken()) }),
    );
    const service = await app.request("/v1/me", { headers: bearer(serviceToken) });
    expect(await service.json()).toEqual({ kind: "service" });
  });

  it("works for a person with no service token configured", async () => {
    const { app } = setup({ WEB_API_SECRET: PERSON_SECRET, SLACK_WORKSPACE_ID: PERSON_WORKSPACE });
    const res = await app.request("/v1/me", { headers: bearer(await signPersonToken()) });
    expect(res.status).toBe(200);
  });

  it("keeps /health working with no configuration at all", async () => {
    const { app } = setup({});
    expect((await app.request("/health")).status).toBe(200);
    await expectUnauthorized(await app.request("/v1/me", { headers: bearer(serviceToken) }));
  });
});

describe("a person reading the record", () => {
  it("lists and reads conversations, and every line names who read", async () => {
    const { app, lines } = setup();
    const posted = await app.request("/v1/messages", {
      method: "POST",
      headers: { ...bearer(serviceToken), "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    expect(posted.status).toBe(202);

    const headers = bearer(await signPersonToken());
    const list = conversationListSchema.parse(
      await (await app.request("/v1/conversations", { headers })).json(),
    );
    expect(list.conversations).toHaveLength(1);
    const id = list.conversations[0]?.id ?? "";

    const detail = await app.request(`/v1/conversations/${id}`, { headers });
    expect(conversationDetailSchema.parse(await detail.json()).conversation.id).toBe(id);
    const events = await app.request(`/v1/conversations/${id}/events`, { headers });
    expect(events.status).toBe(200);

    expect(lines).toContainEqual(
      expect.objectContaining({ msg: "conversations.listed", actorId: "U0123456789" }),
    );
  });
});

describe("a person writing", () => {
  const id = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
  const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });

  it.each([
    ["POST /v1/messages", "/v1/messages", json("POST", message)],
    ["POST /v1/stop", "/v1/stop", json("POST", { source: "slack", threadId: "1.1" })],
    ["POST /v1/briefs/:id/start", `/v1/briefs/${id}/start`, json("POST", {})],
    ["POST /v1/projects", "/v1/projects", json("POST", { name: "x" })],
    ["GET /v1/projects", "/v1/projects", { method: "GET" }],
    ["PUT /v1/roles", "/v1/roles", json("PUT", {})],
    ["GET /v1/roles", "/v1/roles", { method: "GET" }],
    ["PUT /v1/conversations/:id/project", `/v1/conversations/${id}/project`, json("PUT", {})],
    ["POST /v1/reconcile", "/v1/reconcile", { method: "POST" }],
  ])("is refused at %s", async (_route, path, init) => {
    const { app } = setup();
    const headers = { ...bearer(await signPersonToken()), "content-type": "application/json" };
    await expectUnauthorized(await app.request(path, { ...init, headers }));
  });
});
