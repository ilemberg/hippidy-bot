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
  productAgentName: "hippidy-bot-product",
  environmentName: "hippidy",
  sessionBudgetCents: 200,
  repository: { url: "https://github.com/ilemberg/hippidy-bot", token: "github_pat_test" },
  repositoryUrl: "https://github.com/ilemberg/hippidy-bot",
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
  it("reads a pull request's link from a GitHub tool's result, as the experiment saw it", () => {
    const result: BetaManagedAgentsSessionEvent = {
      id: "sevt_r",
      type: "agent.mcp_tool_result",
      mcp_tool_use_id: "sevt_u",
      processed_at: "2026-11-18T23:40:42.667056Z",
      is_error: false,
      content: [
        {
          type: "text",
          text: '{"html_url":"https://github.com/ilemberg/hippidy-bot/pull/22","id":"5386006589"}',
        },
      ],
    };
    expect(toAgentEvent(result)).toEqual({
      kind: "pull_request",
      id: "sevt_r",
      url: "https://github.com/ilemberg/hippidy-bot/pull/22",
    });
    expect(toAgentEvent({ ...result, is_error: true })).toBeUndefined();
    expect(
      toAgentEvent({ ...result, content: [{ type: "text", text: '{"check_runs":[]}' }] }),
    ).toBeUndefined();
  });

  it("reads which MCP server and tool the agent called (slice 2.1's start rule)", () => {
    const use: BetaManagedAgentsSessionEvent = {
      id: "sevt_m",
      type: "agent.mcp_tool_use",
      mcp_server_name: "atlassian",
      name: "getJiraIssue",
      input: { issueIdOrKey: "SCRUM-7" },
      processed_at: "2026-11-25T10:00:00Z",
    };
    expect(toAgentEvent(use)).toEqual({
      kind: "mcp_tool_use",
      id: "sevt_m",
      server: "atlassian",
      name: "getJiraIssue",
    });
  });

  it("reads a git push from a shell command, and nothing else", () => {
    const bash = (command: string): BetaManagedAgentsSessionEvent => ({
      id: "sevt_b",
      type: "agent.tool_use",
      name: "bash",
      input: { command },
      processed_at: "2026-11-18T23:40:32Z",
    });
    expect(toAgentEvent(bash("cd /workspace/hippidy-bot && git push -u origin x"))).toEqual({
      kind: "pushed",
      id: "sevt_b",
    });
    expect(toAgentEvent(bash("git -C /workspace/hippidy-bot push"))).toMatchObject({
      kind: "pushed",
    });
    expect(toAgentEvent(bash("git status && echo push"))).toBeUndefined();
    expect(toAgentEvent(bash("git commit -m 'push the button'"))).toBeUndefined();
  });

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

  it("reads a custom tool call and its answer (decision 167)", () => {
    const use: BetaManagedAgentsSessionEvent = {
      id: "sevt_11",
      type: "agent.custom_tool_use",
      name: "link_project",
      input: { name: "Search" },
      processed_at: "2026-11-18T00:00:11.000Z",
    };
    expect(toAgentEvent(use)).toEqual({
      kind: "custom_tool_use",
      id: "sevt_11",
      name: "link_project",
      input: { name: "Search" },
      processedAt: "2026-11-18T00:00:11.000Z",
    });
    const result: BetaManagedAgentsSessionEvent = {
      id: "sevt_12",
      type: "user.custom_tool_result",
      custom_tool_use_id: "sevt_11",
      content: [{ type: "text", text: "{}" }],
      is_error: false,
      processed_at: null,
    };
    expect(toAgentEvent(result)).toEqual({
      kind: "custom_tool_result",
      id: "sevt_12",
      customToolUseId: "sevt_11",
    });
  });
});

describe("answering a custom tool call", () => {
  it("sends the result as text, with whether it is an error", async () => {
    const sent: unknown[] = [];
    const client = {
      beta: {
        sessions: {
          events: {
            send: (sessionId: string, body: unknown) => {
              sent.push([sessionId, body]);
              return Promise.resolve({ data: [] });
            },
          },
        },
      },
    } as unknown as Anthropic;
    const runtime = createManagedAgentRuntime(config, client);
    await runtime.answerCustomTool("sesn_1", "sevt_11", { text: "no such tool", isError: true });
    expect(sent).toEqual([
      [
        "sesn_1",
        {
          events: [
            {
              type: "user.custom_tool_result",
              custom_tool_use_id: "sevt_11",
              content: [{ type: "text", text: "no such tool" }],
              is_error: true,
            },
          ],
        },
      ],
    ]);
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
  function fakeClient(
    agents: object[] = [
      { id: "agent_1", name: "hippidy-bot", archived_at: null },
      { id: "agent_2", name: "hippidy-bot-product", archived_at: null },
    ],
  ) {
    const created: unknown[] = [];
    const list = (items: object[]) =>
      async function* () {
        for (const item of items) yield await Promise.resolve(item);
      };
    const client = {
      beta: {
        agents: { list: list(agents) },
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
    expect(await runtime.startSession({ title: "t", metadata: {}, agentKind: "engineer" })).toEqual(
      {
        sessionId: "sesn_1",
        agentId: "agent_1",
        agentVersion: 3,
      },
    );
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
    await expect(
      runtime.startSession({ title: "t", metadata: {}, agentKind: "engineer" }),
    ).rejects.toThrow(/AGENT_GITHUB_TOKEN/);
    expect(created).toEqual([]);
  });

  it("starts no session when the vault has not been made", async () => {
    const { client, created } = fakeClient();
    const runtime = createManagedAgentRuntime({ ...config, vaultName: "missing" }, client);
    await expect(
      runtime.startSession({ title: "t", metadata: {}, agentKind: "engineer" }),
    ).rejects.toThrow(/vault/);
    expect(created).toEqual([]);
  });
});

describe("starting a product session (decisions 147, 167)", () => {
  function fakeClient(agents: object[], vaults: object[] = []) {
    const created: unknown[] = [];
    const list = (items: object[]) =>
      async function* () {
        for (const item of items) yield await Promise.resolve(item);
      };
    const client = {
      beta: {
        agents: { list: list(agents) },
        environments: { list: list([{ id: "env_1", name: "hippidy", archived_at: null }]) },
        vaults: { list: list(vaults) },
        sessions: {
          create: (body: unknown) => {
            created.push(body);
            return Promise.resolve({ id: "sesn_2", agent: { id: "agent_2", version: 1 } });
          },
        },
      },
    } as unknown as Anthropic;
    return { client, created };
  }

  const both = [
    { id: "agent_1", name: "hippidy-bot", archived_at: null },
    { id: "agent_old", name: "hippidy-bot-product", archived_at: "2026-11-01T00:00:00Z" },
    { id: "agent_2", name: "hippidy-bot-product", archived_at: null },
  ];

  const vaults = [
    { id: "vlt_old", display_name: "hippidy-bot", archived_at: "2026-11-01T00:00:00Z" },
    { id: "vlt_1", display_name: "hippidy-bot", archived_at: null },
  ];

  it("starts the product agent with the repo mounted without a token, and the vault", async () => {
    const { client, created } = fakeClient(both, vaults);
    const runtime = createManagedAgentRuntime(config, client);
    expect(await runtime.startSession({ title: "t", metadata: {}, agentKind: "product" })).toEqual({
      sessionId: "sesn_2",
      agentId: "agent_2",
      agentVersion: 1,
    });
    expect(created).toEqual([
      {
        agent: "agent_2",
        environment_id: "env_1",
        title: "t",
        metadata: {},
        resources: [{ type: "github_repository", url: "https://github.com/ilemberg/hippidy-bot" }],
        vault_ids: ["vlt_1"],
        budget: { type: "limit", max_list_cost: { amount: "200", currency: "USD" } },
      },
    ]);
  });

  it("needs no GitHub token, and still mounts the repo without one", async () => {
    const { client, created } = fakeClient(both, vaults);
    const runtime = createManagedAgentRuntime({ ...config, repository: undefined }, client);
    await runtime.startSession({ title: "t", metadata: {}, agentKind: "product" });
    expect(created).toEqual([
      expect.objectContaining({
        resources: [{ type: "github_repository", url: "https://github.com/ilemberg/hippidy-bot" }],
        vault_ids: ["vlt_1"],
      }),
    ]);
  });

  it("starts no session when the vault has not been made, like the engineer", async () => {
    const { client, created } = fakeClient(both, [vaults[0] ?? {}]);
    const runtime = createManagedAgentRuntime(config, client);
    await expect(
      runtime.startSession({ title: "t", metadata: {}, agentKind: "product" }),
    ).rejects.toThrow(/vault "hippidy-bot"/);
    expect(created).toEqual([]);
  });

  it("starts no session when the product agent has not been synced", async () => {
    const { client, created } = fakeClient([both[0] ?? {}], vaults);
    const runtime = createManagedAgentRuntime(config, client);
    await expect(
      runtime.startSession({ title: "t", metadata: {}, agentKind: "product" }),
    ).rejects.toThrow(/hippidy-bot-product/);
    expect(created).toEqual([]);
  });
});

describe("reading events", () => {
  it("asks only for events since a time, and reads a stored payload back the same way", async () => {
    const asked: unknown[] = [];
    const client = {
      beta: {
        sessions: {
          events: {
            list: async function* (_sessionId: string, query: unknown) {
              asked.push(query);
              yield await Promise.resolve(agentMessage);
            },
          },
        },
      },
    } as unknown as Anthropic;
    const runtime = createManagedAgentRuntime(config, client);
    const [listed] = await runtime.listEvents("sesn_1", { since: "2026-11-18T00:00:02.000Z" });
    expect(asked).toEqual([{ order: "asc", "created_at[gte]": "2026-11-18T00:00:02.000Z" }]);
    await runtime.listEvents("sesn_1");
    expect(asked[1]).toEqual({ order: "asc" });

    const stored: unknown = JSON.parse(JSON.stringify(listed?.payload));
    expect(runtime.readStoredEvent(stored)).toEqual(listed);
    expect(runtime.readStoredEvent({ nothing: true })).toBeUndefined();
  });
});
