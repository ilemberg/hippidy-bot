import { describe, expect, it } from "vitest";
import {
  MCP_BASE,
  WANTED_TOOLS,
  chooseMcpServers,
  describeEvent,
  dollars,
  mcpAgentConfig,
  readJsonRpcResponse,
} from "./experiment-lib.ts";

describe("chooseMcpServers", () => {
  it("prefers one address that serves all four tools", () => {
    const listed = new Map([
      [`${MCP_BASE}/`, ["create_pull_request", "update_pull_request", "pull_request_read"]],
      [`${MCP_BASE}/x/all`, [...WANTED_TOOLS, "merge_pull_request"]],
    ]);
    expect(chooseMcpServers(listed)).toEqual({
      servers: [{ name: "github", url: `${MCP_BASE}/x/all`, tools: [...WANTED_TOOLS] }],
      missing: [],
    });
  });

  it("splits pull requests and read-only actions when no address serves all four", () => {
    const listed = new Map([
      [`${MCP_BASE}/`, ["create_pull_request", "update_pull_request", "pull_request_read"]],
      [
        `${MCP_BASE}/x/pull_requests`,
        ["create_pull_request", "update_pull_request", "pull_request_read"],
      ],
      [`${MCP_BASE}/x/actions`, ["get_job_logs", "actions_run_trigger"]],
      [`${MCP_BASE}/x/actions/readonly`, ["get_job_logs"]],
    ]);
    expect(chooseMcpServers(listed)).toEqual({
      servers: [
        {
          name: "github-1",
          url: `${MCP_BASE}/x/pull_requests`,
          tools: ["create_pull_request", "update_pull_request", "pull_request_read"],
        },
        { name: "github-2", url: `${MCP_BASE}/x/actions/readonly`, tools: ["get_job_logs"] },
      ],
      missing: [],
    });
  });

  it("names the tools no address serves", () => {
    const listed = new Map([[`${MCP_BASE}/`, ["pull_request_read"]]]);
    const chosen = chooseMcpServers(listed);
    expect(chosen.servers).toEqual([
      { name: "github-1", url: `${MCP_BASE}/`, tools: ["pull_request_read"] },
    ]);
    expect(chosen.missing).toEqual(["create_pull_request", "update_pull_request", "get_job_logs"]);
  });
});

describe("readJsonRpcResponse", () => {
  it("reads plain JSON", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
    expect(readJsonRpcResponse("application/json", body, 2)).toEqual({ tools: [] });
  });

  it("reads the matching message from an event stream", () => {
    const body = [
      "event: message",
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
      "",
      "event: message",
      'data: {"jsonrpc":"2.0","id":3,"result":{"ok":true}}',
      "",
    ].join("\n");
    expect(readJsonRpcResponse("text/event-stream; charset=utf-8", body, 3)).toEqual({ ok: true });
  });

  it("throws on a JSON-RPC error", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601 } });
    expect(() => readJsonRpcResponse("application/json", body, 1)).toThrow(/-32601/);
  });
});

describe("mcpAgentConfig", () => {
  it("switches on only the planned tools, each running without asking", () => {
    const config = mcpAgentConfig([
      { name: "github", url: `${MCP_BASE}/`, tools: ["pull_request_read"] },
    ]);
    expect(config.mcp_servers).toEqual([{ type: "url", name: "github", url: `${MCP_BASE}/` }]);
    expect(config.toolsets).toEqual([
      {
        type: "mcp_toolset",
        mcp_server_name: "github",
        default_config: { enabled: false },
        configs: [
          { name: "pull_request_read", enabled: true, permission_policy: { type: "always_allow" } },
        ],
      },
    ]);
  });
});

describe("describeEvent", () => {
  it("shows a tool call's server, name and input", () => {
    expect(
      describeEvent({
        id: "e1",
        type: "agent.mcp_tool_use",
        processed_at: "2026-11-18T10:11:12.000Z",
        mcp_server_name: "github",
        name: "create_pull_request",
        input: { title: "x" },
      }),
    ).toBe('10:11:12 agent.mcp_tool_use: github.create_pull_request {"title":"x"}');
  });

  it("marks a queued message", () => {
    expect(
      describeEvent({
        id: "e2",
        type: "user.message",
        processed_at: null,
        content: [{ type: "text", text: "hello\nthere" }],
      }),
    ).toBe("queued user.message: hello there");
  });
});

describe("dollars", () => {
  it("reads minor units", () => {
    expect(dollars("123")).toBe(1.23);
    expect(dollars(undefined)).toBe(0);
    expect(dollars("1.5")).toBe(0);
  });
});
