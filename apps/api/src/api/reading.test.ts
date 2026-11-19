import {
  agentEventListSchema,
  conversationDetailSchema,
  conversationListSchema,
  errorResponseSchema,
  type InboundMessage,
} from "@hippidy/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../agent/fake.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import { configureApp } from "../compose.ts";
import { createTestDb } from "../store/testing.ts";
import { memoryLogger } from "../testing.ts";
import { receiveMessage, syncConversation, type ConversationDeps } from "./conversations.ts";
import { findConversationBySession } from "../store/conversations.ts";
import { RecordingDeliverer } from "./testing.ts";
import type { ApiEnv } from "./types.ts";

const token = "t".repeat(48);
const reconcileToken = "r".repeat(48);
const auth = { authorization: `Bearer ${token}` };
const { log } = memoryLogger();

let db: Awaited<ReturnType<typeof createTestDb>>;
let runtime: FakeAgentRuntime;
let slack: RecordingDeliverer;
let deps: ConversationDeps;

beforeEach(async () => {
  db = await createTestDb();
  runtime = new FakeAgentRuntime();
  slack = new RecordingDeliverer();
  deps = { db, runtime, deliverers: { slack }, sleep: () => Promise.resolve() };
});

afterEach(async () => {
  await db.close();
});

/** A runtime that is gone: every call fails, as if Anthropic could not be reached. */
const unreachable: AgentRuntime = {
  startSession: () => Promise.reject(new Error("agent runtime unreachable")),
  sendMessage: () => Promise.reject(new Error("agent runtime unreachable")),
  interrupt: () => Promise.reject(new Error("agent runtime unreachable")),
  denyToolCalls: () => Promise.reject(new Error("agent runtime unreachable")),
  listEvents: () => Promise.reject(new Error("agent runtime unreachable")),
  readUsage: () => Promise.reject(new Error("agent runtime unreachable")),
  readStoredEvent: () => undefined,
};

/**
 * The API as deployed, over this test's database, with an agent runtime that cannot be
 * reached: whatever these routes answer, they answer from the database.
 */
function api(options: { storage: "configured" | "missing" } = { storage: "configured" }) {
  return configureApp(new Hono<ApiEnv>(), {
    env: { API_SERVICE_TOKEN: token, RECONCILE_TOKEN: reconcileToken },
    log,
    services:
      options.storage === "missing" ? {} : { conversations: { ...deps, runtime: unreachable } },
  });
}

function message(n: number, threadId = "100.000001"): InboundMessage {
  return {
    source: "slack",
    sourceEventId: `Ev${threadId}-${n}`,
    conversation: {
      workspaceId: "T1",
      channelId: "C1",
      threadId,
      messageId: n === 1 ? threadId : `${threadId}${n}`,
    },
    actor: n === 1 ? { id: "U1", displayName: "Ilya" } : { id: "U2" },
    text: `question ${n}`,
    // The fake agent's clock starts at this midnight and moves a second per event, so the
    // first message comes before its answer and the second well after.
    sentAt: `2026-11-18T00:0${n - 1}:00.000Z`,
  };
}

/** One thread: a question, an answer, and the sync that delivers and records them. */
async function thread(threadId: string, answer = "An answer.") {
  await receiveMessage(deps, message(1, threadId), log);
  const sessionId = [...runtime.sessions.keys()].at(-1) ?? "";
  runtime.reply(sessionId, answer);
  const conversation = await findConversationBySession(db, sessionId);
  if (conversation === undefined) throw new Error("expected a conversation");
  await syncConversation(deps, conversation, log);
  return { id: conversation.id, sessionId };
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(errorResponseSchema.parse(await res.json()).error.code).toBe(code);
}

describe("GET /v1/conversations/:id", () => {
  it("rebuilds a conversation from the database alone, with the agent runtime unreachable", async () => {
    const { id, sessionId } = await thread("100.000001", "An answer.");
    runtime.setUsage(sessionId, {
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 900,
      cacheCreationTokens: 50,
      activeSeconds: 12.5,
      listCostMinor: 7,
      budgetMinor: 200,
      currency: "USD",
    });
    await receiveMessage(deps, message(2), log);
    runtime.idle(sessionId, "budget_reached");
    const conversation = await findConversationBySession(db, sessionId);
    if (conversation === undefined) throw new Error("expected a conversation");
    await syncConversation(deps, conversation, log);

    // From here on nothing can reach the agent runtime.
    const res = await api().request(`/v1/conversations/${id}`, { headers: auth });

    expect(res.status).toBe(200);
    const body = conversationDetailSchema.parse(await res.json());
    expect(body.conversation).toMatchObject({
      id,
      source: "slack",
      workspaceId: "T1",
      channelId: "C1",
      threadId: "100.000001",
      status: "failed",
      sessionState: "budget_reached",
      agent: { sessionId, agentId: "agent_fake", version: 1 },
      usage: {
        inputTokens: 1200,
        outputTokens: 340,
        cacheReadTokens: 900,
        cacheCreationTokens: 50,
        activeSeconds: 12.5,
        listCostMinor: 7,
        budgetMinor: 200,
        currency: "USD",
      },
    });
    expect(body.conversation.usage.updatedAt).not.toBeNull();
    expect(body.transcript.map(({ at: _at, ...line }) => line)).toEqual([
      {
        role: "user",
        text: "question 1",
        actor: { id: "U1", displayName: "Ilya" },
        messageId: "100.000001",
        status: "answered",
      },
      {
        role: "agent",
        text: "An answer.",
        eventId: expect.stringMatching(/^sevt_/) as unknown,
        delivery: "sent",
      },
      {
        role: "user",
        text: "question 2",
        actor: { id: "U2" },
        messageId: "100.0000012",
        status: "failed",
      },
      {
        role: "note",
        text: expect.stringContaining("spending limit") as unknown,
        delivery: "sent",
      },
    ]);
  });

  it("shows a conversation that has only just begun", async () => {
    await receiveMessage(deps, message(1), log);
    const conversation = await findConversationBySession(db, runtime.onlySessionId());
    const res = await api().request(`/v1/conversations/${conversation?.id ?? ""}`, {
      headers: auth,
    });
    const body = conversationDetailSchema.parse(await res.json());
    expect(body.conversation.status).toBe("waiting");
    expect(body.conversation.usage).toMatchObject({ inputTokens: null, listCostMinor: null });
    expect(body.transcript).toMatchObject([{ role: "user", status: "received" }]);
  });

  it("answers 404 for a conversation that does not exist, or an id that is not one", async () => {
    const app = api();
    await expectError(
      await app.request("/v1/conversations/00000000-0000-4000-8000-000000000000", {
        headers: auth,
      }),
      404,
      "not_found",
    );
    await expectError(
      await app.request("/v1/conversations/not-an-id", { headers: auth }),
      404,
      "not_found",
    );
  });
});

describe("GET /v1/conversations", () => {
  it("lists conversations newest first, a page at a time", async () => {
    const ids: string[] = [];
    for (const threadId of ["100.000001", "200.000001", "300.000001"]) {
      ids.push((await thread(threadId)).id);
    }
    // Created in one go, they could share a time: spread them out.
    for (const [index, id] of ids.entries()) {
      await db.query(
        `update conversations set created_at = now() - make_interval(mins => $2) where id = $1`,
        [id, 10 - index],
      );
    }
    const app = api();

    const first = conversationListSchema.parse(
      await (await app.request("/v1/conversations?limit=2", { headers: auth })).json(),
    );
    expect(first.conversations.map((c) => c.id)).toEqual([ids[2], ids[1]]);
    expect(first.next).toBe(ids[1]);

    const second = conversationListSchema.parse(
      await (
        await app.request(`/v1/conversations?limit=2&before=${first.next ?? ""}`, {
          headers: auth,
        })
      ).json(),
    );
    expect(second.conversations.map((c) => c.id)).toEqual([ids[0]]);
    expect(second.next).toBeNull();
  });

  it("orders conversations created at the same instant, and loses none between pages", async () => {
    const ids: string[] = [];
    for (const threadId of ["100.000001", "200.000001", "300.000001"]) {
      ids.push((await thread(threadId)).id);
    }
    await db.query(`update conversations set created_at = '2026-11-18T00:00:00Z'`);
    const app = api();

    const seen: string[] = [];
    let before: string | null = null;
    do {
      const url = `/v1/conversations?limit=1${before === null ? "" : `&before=${before}`}`;
      const page = conversationListSchema.parse(
        await (await app.request(url, { headers: auth })).json(),
      );
      seen.push(...page.conversations.map((c) => c.id));
      before = page.next;
    } while (before !== null);
    // Ties on the time are broken by id, newest-first meaning the larger id first.
    expect(seen).toEqual([...ids].sort().reverse());
  });

  it("says there is no next page when the page holds exactly what is left", async () => {
    for (const threadId of ["100.000001", "200.000001"]) await thread(threadId);
    const page = conversationListSchema.parse(
      await (await api().request("/v1/conversations?limit=2", { headers: auth })).json(),
    );
    expect(page.conversations).toHaveLength(2);
    expect(page.next).toBeNull();
  });

  it("shows no agent session while one is still being started", async () => {
    const { id } = await thread("100.000001");
    await db.query(`update conversations set agent_session_id = 'starting:abc' where id = $1`, [
      id,
    ]);
    const page = conversationListSchema.parse(
      await (await api().request("/v1/conversations", { headers: auth })).json(),
    );
    expect(page.conversations[0]?.agent).toBeNull();
  });

  it("reads a conversation whose id was not made by the database", async () => {
    const byHand = "00000000-0000-0000-0000-000000000001";
    await db.query(
      `insert into conversations (id, source, workspace_id, channel_id, thread_id)
       values ($1, 'slack', 'T1', 'C1', '900.000001')`,
      [byHand],
    );
    const app = api();
    const detail = await app.request(`/v1/conversations/${byHand}`, { headers: auth });
    expect(conversationDetailSchema.parse(await detail.json()).conversation.id).toBe(byHand);
    const list = await app.request(`/v1/conversations?before=${byHand}`, { headers: auth });
    expect(list.status).toBe(200);
  });

  it("is empty when there are none", async () => {
    expect(await (await api().request("/v1/conversations", { headers: auth })).json()).toEqual({
      conversations: [],
      next: null,
    });
  });

  it("rejects a cursor that names no conversation, rather than looking like the last page", async () => {
    await thread("100.000001");
    await expectError(
      await api().request("/v1/conversations?before=00000000-0000-4000-8000-000000000000", {
        headers: auth,
      }),
      400,
      "invalid_request",
    );
  });

  it("rejects a query it does not understand", async () => {
    const app = api();
    for (const query of ["limit=0", "limit=101", "limit=many", "before=yesterday", "page=2"]) {
      await expectError(
        await app.request(`/v1/conversations?${query}`, { headers: auth }),
        400,
        "invalid_request",
      );
    }
  });
});

describe("GET /v1/conversations/:id/events", () => {
  it("lists every event the session reported, in the order stored, a page at a time", async () => {
    const { id } = await thread("100.000001");
    const app = api();

    const first = agentEventListSchema.parse(
      await (await app.request(`/v1/conversations/${id}/events?limit=4`, { headers: auth })).json(),
    );
    expect(first.events.map((event) => event.type)).toEqual([
      "user.message",
      "session.status_running",
      "span.model_request_start",
      "agent.message",
    ]);
    expect(first.events[3]).toMatchObject({
      kind: "agent_message",
      payload: { type: "agent.message", text: "An answer." },
    });
    expect(first.events[2]).toMatchObject({ kind: null });
    expect(first.events[0]?.processedAt).toMatch(/^2026-11-18T/);
    expect(first.next).toBe(first.events[3]?.position);

    const second = agentEventListSchema.parse(
      await (
        await app.request(`/v1/conversations/${id}/events?limit=4&after=${first.next ?? 0}`, {
          headers: auth,
        })
      ).json(),
    );
    expect(second.events.map((event) => event.type)).toEqual([
      "span.model_request_end",
      "session.status_idle",
    ]);
    expect(second.next).toBeNull();
  });

  it("says there is no next page when the page holds exactly what is left", async () => {
    const { id } = await thread("100.000001");
    const page = agentEventListSchema.parse(
      await (
        await api().request(`/v1/conversations/${id}/events?limit=6`, { headers: auth })
      ).json(),
    );
    expect(page.events).toHaveLength(6);
    expect(page.next).toBeNull();
  });

  it("shows a message still in the agent's queue with no processed time", async () => {
    const { id, sessionId } = await thread("100.000001");
    await receiveMessage(deps, message(2), log);
    const conversation = await findConversationBySession(db, sessionId);
    if (conversation === undefined) throw new Error("expected a conversation");
    await syncConversation(deps, conversation, log);

    const page = agentEventListSchema.parse(
      await (await api().request(`/v1/conversations/${id}/events`, { headers: auth })).json(),
    );
    const queued = page.events.at(-1);
    expect(queued).toMatchObject({ type: "user.message", kind: "user_message", processedAt: null });
    expect(queued?.updatedAt).toMatch(/^\d{4}-/);
  });

  it("lists only that conversation's events", async () => {
    const one = await thread("100.000001", "One.");
    const two = await thread("200.000001", "Two.");
    const body = agentEventListSchema.parse(
      await (await api().request(`/v1/conversations/${two.id}/events`, { headers: auth })).json(),
    );
    expect(body.events).toHaveLength(6);
    expect(JSON.stringify(body.events)).toContain("Two.");
    expect(JSON.stringify(body.events)).not.toContain("One.");
    expect(one.id).not.toBe(two.id);
  });

  it("answers 404 for an unknown conversation and 400 for a bad query", async () => {
    const { id } = await thread("100.000001");
    const app = api();
    await expectError(
      await app.request("/v1/conversations/00000000-0000-4000-8000-000000000000/events", {
        headers: auth,
      }),
      404,
      "not_found",
    );
    for (const query of ["limit=0", "limit=201", "after=-1", "after=soon"]) {
      await expectError(
        await app.request(`/v1/conversations/${id}/events?${query}`, { headers: auth }),
        400,
        "invalid_request",
      );
    }
  });
});

describe("who may read the record", () => {
  const routes = [
    "/v1/conversations",
    "/v1/conversations/00000000-0000-4000-8000-000000000000",
    "/v1/conversations/00000000-0000-4000-8000-000000000000/events",
  ];

  it("needs the service token; the reconcile token does not do", async () => {
    const app = api();
    for (const route of routes) {
      await expectError(await app.request(route), 401, "unauthorized");
      await expectError(
        await app.request(route, { headers: { authorization: `Bearer ${reconcileToken}` } }),
        401,
        "unauthorized",
      );
    }
  });

  it("answers 503 while storage is not configured", async () => {
    const app = api({ storage: "missing" });
    for (const route of routes) {
      await expectError(await app.request(route, { headers: auth }), 503, "not_configured");
    }
  });
});
