// The pure parts of the slice 4 experiment (`experiment.ts`), kept apart so they can be tested
// without the network.

/** The GitHub MCP tools the agent gets (decision 105). */
export const WANTED_TOOLS = [
  "create_pull_request",
  "update_pull_request",
  "pull_request_read",
  "get_job_logs",
] as const;

/** Addresses of GitHub's remote MCP server to try, in order of preference (decision 116). */
export const MCP_BASE = "https://api.githubcopilot.com/mcp";
export const MCP_CANDIDATES = [
  `${MCP_BASE}/`,
  `${MCP_BASE}/x/all`,
  `${MCP_BASE}/x/pull_requests,actions`,
  `${MCP_BASE}/x/pull_requests`,
  `${MCP_BASE}/x/actions`,
  `${MCP_BASE}/x/actions/readonly`,
];

export interface McpServerPlan {
  name: string;
  url: string;
  tools: string[];
}

/**
 * Picks how the agent reaches the four tools: one address that serves all of them if any
 * does, else one for the pull request tools and one for `get_job_logs` (decision 116).
 * `listed` maps each address that answered to the tool names it serves.
 */
export function chooseMcpServers(listed: ReadonlyMap<string, readonly string[]>): {
  servers: McpServerPlan[];
  missing: string[];
} {
  const serves = (url: string, tool: string) => listed.get(url)?.includes(tool) === true;
  for (const url of MCP_CANDIDATES) {
    if (WANTED_TOOLS.every((tool) => serves(url, tool))) {
      return { servers: [{ name: "github", url, tools: [...WANTED_TOOLS] }], missing: [] };
    }
  }
  const servers: McpServerPlan[] = [];
  const missing: string[] = [];
  const remaining = new Set<string>(WANTED_TOOLS);
  // Prefer the narrowest address for each part: read-only actions over all actions.
  const order = [
    `${MCP_BASE}/x/pull_requests`,
    `${MCP_BASE}/x/actions/readonly`,
    `${MCP_BASE}/x/actions`,
    ...MCP_CANDIDATES,
  ];
  for (const url of order) {
    const here = [...remaining].filter((tool) => serves(url, tool));
    if (here.length === 0) continue;
    servers.push({ name: `github-${String(servers.length + 1)}`, url, tools: here });
    for (const tool of here) remaining.delete(tool);
  }
  missing.push(...remaining);
  return { servers, missing };
}

/**
 * Reads the JSON-RPC message with the given id from an MCP Streamable HTTP response, which is
 * either plain JSON or a server-sent event stream (decided by the server per request).
 */
export function readJsonRpcResponse(contentType: string, body: string, id: number): unknown {
  const messages: unknown[] = [];
  if (contentType.includes("text/event-stream")) {
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data !== "") messages.push(JSON.parse(data));
    }
  } else {
    const parsed: unknown = JSON.parse(body);
    if (Array.isArray(parsed)) messages.push(...(parsed as unknown[]));
    else messages.push(parsed);
  }
  const message = messages.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      "id" in candidate &&
      candidate.id === id,
  );
  if (message === undefined) throw new Error(`no JSON-RPC response with id ${String(id)}`);
  if (typeof message === "object" && message !== null && "error" in message) {
    throw new Error(`JSON-RPC error: ${JSON.stringify(message.error)}`);
  }
  return typeof message === "object" && message !== null && "result" in message
    ? message.result
    : undefined;
}

/** The agent's MCP servers and tool list for a plan: the four tools on and never asking. */
export function mcpAgentConfig(servers: readonly McpServerPlan[]) {
  return {
    mcp_servers: servers.map((server) => ({
      type: "url" as const,
      name: server.name,
      url: server.url,
    })),
    toolsets: servers.map((server) => ({
      type: "mcp_toolset" as const,
      mcp_server_name: server.name,
      default_config: { enabled: false },
      configs: server.tools.map((name) => ({
        name,
        enabled: true,
        permission_policy: { type: "always_allow" as const },
      })),
    })),
  };
}

/** Shortens text for a one-line log entry. */
export function clip(text: string, length = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= length ? flat : `${flat.slice(0, length - 1)}…`;
}

interface LooseEvent {
  id: string;
  type: string;
  processed_at?: string | null;
  [key: string]: unknown;
}

/** One line per event for the experiment's log: its time, type and the part worth seeing. */
export function describeEvent(event: LooseEvent): string {
  const time = typeof event.processed_at === "string" ? event.processed_at.slice(11, 19) : "queued";
  const detail = eventDetail(event);
  return `${time} ${event.type}${detail === "" ? "" : `: ${detail}`}`;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) =>
      typeof block === "object" &&
      block !== null &&
      "text" in block &&
      typeof block.text === "string"
        ? block.text
        : "",
    )
    .join(" ");
}

function eventDetail(event: LooseEvent): string {
  switch (event.type) {
    case "user.message":
    case "agent.message":
      return clip(textOf(event.content));
    case "agent.tool_use":
      return `${String(event.name)} ${clip(JSON.stringify(event.input), 200)}`;
    case "agent.mcp_tool_use":
      return `${String(event.mcp_server_name)}.${String(event.name)} ${clip(JSON.stringify(event.input), 200)}`;
    case "agent.tool_result":
    case "agent.mcp_tool_result":
      return `${event.is_error === true ? "ERROR " : ""}${clip(textOf(event.content), 120)}`;
    case "session.status_idle":
      return JSON.stringify(event.stop_reason);
    case "session.error":
      return clip(JSON.stringify(event.error), 300);
    case "span.outcome_evaluation_end":
      return `${String(event.result)}: ${clip(String(event.explanation), 300)}`;
    default:
      return "";
  }
}

/** Dollars from Anthropic's minor-unit string ("123" is $1.23). */
export function dollars(minor: string | null | undefined): number {
  return minor === null || minor === undefined || !/^\d+$/.test(minor) ? 0 : Number(minor) / 100;
}
