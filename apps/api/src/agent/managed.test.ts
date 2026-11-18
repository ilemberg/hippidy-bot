import type { Anthropic } from "@anthropic-ai/sdk";
import type { BetaManagedAgentsSessionEvent } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "./config.ts";
import {
  createManagedAgentRuntime,
  toAgentEvent,
  toAgentEventRecord,
  toSessionUsage,
} from "./managed.ts";
import { actedOn, SessionNotFoundError } from "./runtime.ts";

const config: AgentConfig = {
  apiKey: "test-key",
  webhookSigningKey: undefined,
  agentName: "hippidy-bot",
  environmentName: "hippidy",
  sessionBudgetCents: 200,
  repository: { url: "https://github.com/ilemberg/hippidy-bot", token: "github_pat_test" },
  vaultName: "hippidy-bot",
};

const agentMessage: BetaManagedAgentsSessionEvent = {
  id: "sevt_2",
  type: "agent.message",
  content: [
    { type: "text", text: "First." },
    { type: "text", text: "Second." },
  ],
  processed_at: "2026-11-18T00:00:03.000Z",
};

const queuedMessage: BetaManagedAgentsSessionEvent = {
  id: "sevt_3",
  type: "user.message",
  content: [{ type: "text", text: "and then?" }],
  processed_at: null,
};

const modelRequest: BetaManagedAgentsSessionEvent = {
  id: "sevt_1",
  type: "span.model_request_end",
  is_error: false,
  model_request_start_id: "sevt_0",
  model_usage: {
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    input_tokens: 12,
    output_tokens: 34,
  },
  processed_at: "2026-11-18T00:00:02.000Z",
};

describe("toAgentEventRecord", () => {
  it("keeps an event the API acts on untouched, beside what the API makes of it", () => {
    expect(toAgentEventRecord(agentMessage)).toEqual({
      id: "sevt_2",
      type: "agent.message",
      processedAt: "2026-11-18T00:00:03.000Z",
      payload: agentMessage,
      event: { kind: "agent_message", id: "sevt_2", text: "First.\n\nSecond." },
    });
  });

  it("keeps an event the API does not act on, with no reading of it", () => {
    expect(toAgentEventRecord(modelRequest)).toEqual({
      id: "sevt_1",
      type: "span.model_request_end",
      processedAt: "2026-11-18T00:00:02.000Z",
      payload: modelRequest,
      event: undefined,
    });
  });

  it("keeps the processed time exactly as given, finer than a millisecond", () => {
    const precise = { ...agentMessage, processed_at: "2026-11-18T00:00:03.123456Z" };
    expect(toAgentEventRecord(precise).processedAt).toBe("2026-11-18T00:00:03.123456Z");
  });

  it("has no processed time when the runtime gives something that is not a time", () => {
    const odd = { ...agentMessage, processed_at: "soon" };
    expect(toAgentEventRecord(odd).processedAt).toBeNull();
  });

  it("has no processed time for a user message still in the queue", () => {
    expect(toAgentEventRecord(queuedMessage)).toMatchObject({
      processedAt: null,
      event: { kind: "user_message", id: "sevt_3", processed: false },
    });
  });

  it("gives the loop only the events it acts on, in order", () => {
    const records = [modelRequest, agentMessage, queuedMessage].map(toAgentEventRecord);
    expect(actedOn(records).map((event) => event.id)).toEqual(["sevt_2", "sevt_3"]);
  });
});

describe("toAgentEvent", () => {
  it("reads which tool calls a session is blocked on", () => {
    const idle: BetaManagedAgentsSessionEvent = {
      id: "sevt_9",
      type: "session.status_idle",
      processed_at: "2026-11-18T00:00:09.000Z",
      stop_details: null,
      stop_reason: { type: "requires_action", event_ids: ["sevt_7", "sevt_8"] },
    };
    expect(toAgentEvent(idle)).toEqual({
      kind: "idle",
      id: "sevt_9",
      reason: "requires_action",
      blockedOn: ["sevt_7", "sevt_8"],
    });
  });

  it("reads the answer to a tool call", () => {
    const confirmation: BetaManagedAgentsSessionEvent = {
      id: "sevt_10",
      type: "user.tool_confirmation",
      result: "deny",
      tool_use_id: "sevt_7",
      processed_at: "2026-11-18T00:00:10.000Z",
    };
    expect(toAgentEvent(confirmation)).toEqual({
      kind: "tool_confirmation",
      id: "sevt_10",
      toolUseId: "sevt_7",
    });
  });
});

describe("toSessionUsage", () => {
  it("reads tokens, runtime, cost and budget; money stays in minor units", () => {
    expect(
      toSessionUsage({
        usage: {
          input_tokens: 1200,
          output_tokens: 340,
          cache_read_input_tokens: 900,
          cache_creation: { ephemeral_1h_input_tokens: 40, ephemeral_5m_input_tokens: 10 },
          active_seconds: 12.5,
          list_cost: { amount: "7", currency: "USD" },
        },
        budget: { type: "limit", max_list_cost: { amount: "200", currency: "USD" } },
      }),
    ).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 900,
      cacheCreationTokens: 50,
      activeSeconds: 12.5,
      listCostMinor: 7,
      budgetMinor: 200,
      currency: "USD",
    });
  });

  it("reports null for what the session does not say", () => {
    expect(toSessionUsage({ usage: {}, budget: null })).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      activeSeconds: null,
      listCostMinor: null,
      budgetMinor: null,
      currency: null,
    });
  });

  it("does not guess at an amount that is not a whole number of minor units", () => {
    const usage = toSessionUsage({
      usage: { list_cost: { amount: "0.07", currency: "USD" } },
      budget: null,
    });
    expect(usage).toMatchObject({ listCostMinor: null, currency: "USD" });
  });
});

describe("a session the runtime no longer has", () => {
  const notFound = Object.assign(new Error("404 session not found"), { status: 404 });
  const unavailable = Object.assign(new Error("503 overloaded"), { status: 503 });

  function runtimeFailingWith(error: Error) {
    const fail = () => {
      throw error;
    };
    const client = {
      beta: { sessions: { retrieve: fail, events: { list: fail } } },
    } as unknown as Anthropic;
    return createManagedAgentRuntime(config, client);
  }

  it("is reported as SessionNotFoundError, for events and for usage", async () => {
    const runtime = runtimeFailingWith(notFound);
    await expect(runtime.listEvents("sesn_1")).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(runtime.readUsage("sesn_1")).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("is not confused with the runtime being unavailable", async () => {
    const runtime = runtimeFailingWith(unavailable);
    await expect(runtime.listEvents("sesn_1")).rejects.toBe(unavailable);
    await expect(runtime.readUsage("sesn_1")).rejects.toBe(unavailable);
  });
});

describe("starting a session", () => {
  function fakeClient() {
    const created: unknown[] = [];
    const list = (items: object[]) =>
      async function* () {
        for (const item of items) yield await Promise.resolve(item);
      };
    const client = {
      beta: {
        agents: { list: list([{ id: "agent_1", name: "hippidy-bot", archived_at: null }]) },
        environments: { list: list([{ id: "env_1", name: "hippidy", archived_at: null }]) },
        vaults: {
          list: list([
            { id: "vlt_old", display_name: "hippidy-bot", archived_at: "2026-11-01T00:00:00Z" },
            { id: "vlt_1", display_name: "hippidy-bot", archived_at: null },
          ]),
        },
        sessions: {
          create: (body: unknown) => {
            created.push(body);
            return Promise.resolve({ id: "sesn_1", agent: { id: "agent_1", version: 3 } });
          },
        },
      },
    } as unknown as Anthropic;
    return { client, created };
  }

  it("mounts the repo with the token and attaches the vault, found by name", async () => {
    const { client, created } = fakeClient();
    const runtime = createManagedAgentRuntime(config, client);
    expect(await runtime.startSession({ title: "t", metadata: {} })).toEqual({
      sessionId: "sesn_1",
      agentId: "agent_1",
      agentVersion: 3,
    });
    expect(created).toEqual([
      expect.objectContaining({
        agent: "agent_1",
        environment_id: "env_1",
        vault_ids: ["vlt_1"],
        resources: [
          {
            type: "github_repository",
            url: "https://github.com/ilemberg/hippidy-bot",
            authorization_token: "github_pat_test",
          },
        ],
      }),
    ]);
  });

  it("starts no session without the GitHub token", async () => {
    const { client, created } = fakeClient();
    const runtime = createManagedAgentRuntime({ ...config, repository: undefined }, client);
    await expect(runtime.startSession({ title: "t", metadata: {} })).rejects.toThrow(
      /AGENT_GITHUB_TOKEN/,
    );
    expect(created).toEqual([]);
  });

  it("starts no session when the vault has not been made", async () => {
    const { client, created } = fakeClient();
    const runtime = createManagedAgentRuntime({ ...config, vaultName: "missing" }, client);
    await expect(runtime.startSession({ title: "t", metadata: {} })).rejects.toThrow(/vault/);
    expect(created).toEqual([]);
  });
});
