import { Anthropic } from "@anthropic-ai/sdk";
import type { BetaManagedAgentsSessionEvent } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { BetaManagedAgentsSession } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import type { AgentConfig } from "./config.ts";
import {
  SessionNotFoundError,
  type AgentEvent,
  type AgentEventRecord,
  type AgentRuntime,
  type SessionUsage,
} from "./runtime.ts";

/** What a session starts with: its agent, the one environment and the one vault. */
interface SessionIds {
  agentId: string;
  environmentId: string;
  vaultId: string;
}

/**
 * Claude Managed Agents behind the AgentRuntime interface. The agents and environment are
 * created and updated by the sync script from the files in the repo; here they are looked up
 * by name once per server instance, each agent on its own, so a missing product agent never
 * holds up the engineer.
 */
export function createManagedAgentRuntime(
  config: AgentConfig,
  client = new Anthropic({ apiKey: config.apiKey, maxRetries: 2, timeout: 20_000 }),
): AgentRuntime {
  let engineerIds: Promise<SessionIds> | undefined;
  let productIds: Promise<SessionIds> | undefined;

  const resolveEngineerIds = (): Promise<SessionIds> => {
    engineerIds ??= lookUpEngineerIds(client, config).catch((error: unknown) => {
      engineerIds = undefined; // try again on the next call
      throw error;
    });
    return engineerIds;
  };

  const resolveProductIds = (): Promise<SessionIds> => {
    productIds ??= lookUpProductIds(client, config).catch((error: unknown) => {
      productIds = undefined; // try again on the next call
      throw error;
    });
    return productIds;
  };

  const budget = () => ({
    type: "limit" as const,
    max_list_cost: { amount: String(config.sessionBudgetCents), currency: "USD" as const },
  });

  return {
    async startSession({ title, metadata, agentKind }) {
      if (agentKind === "product") {
        // The product agent (decisions 147, 167): the public repo mounted without a token, so
        // it can read and clone but not push, and the vault, for Atlassian's MCP server
        // (slice 5A part F). Fails closed like the engineer: if the agent or the vault is not
        // found, no session starts.
        const { agentId, environmentId, vaultId } = await resolveProductIds();
        const session = await client.beta.sessions.create({
          agent: agentId,
          environment_id: environmentId,
          title,
          metadata,
          resources: [{ type: "github_repository", url: config.repositoryUrl }],
          vault_ids: [vaultId],
          budget: budget(),
        });
        return {
          sessionId: session.id,
          agentId: session.agent.id,
          agentVersion: session.agent.version,
        };
      }
      // Fails closed (decision 122): without the token, no session starts, so the message
      // is answered with a note rather than reaching an agent that cannot see its repo.
      if (config.repository === undefined) {
        throw new Error("AGENT_GITHUB_TOKEN is missing or invalid; sessions cannot mount the repo");
      }
      const { agentId, environmentId, vaultId } = await resolveEngineerIds();
      const session = await client.beta.sessions.create({
        agent: agentId,
        environment_id: environmentId,
        title,
        metadata,
        // The default branch, so a new thread starts from the latest main (decision 109). The
        // token stays outside the sandbox: git reaches GitHub through a proxy that adds it.
        resources: [
          {
            type: "github_repository",
            url: config.repository.url,
            authorization_token: config.repository.token,
          },
        ],
        vault_ids: [vaultId],
        budget: budget(),
      });
      return {
        sessionId: session.id,
        agentId: session.agent.id,
        agentVersion: session.agent.version,
      };
    },

    async sendMessage(sessionId, text) {
      const sent = await client.beta.sessions.events.send(sessionId, {
        events: [{ type: "user.message", content: [{ type: "text", text }] }],
      });
      return sent.data?.[0]?.id;
    },

    async interrupt(sessionId) {
      await client.beta.sessions.events.send(sessionId, { events: [{ type: "user.interrupt" }] });
    },

    async denyToolCalls(sessionId, toolUseIds, message) {
      if (toolUseIds.length === 0) return;
      await client.beta.sessions.events.send(sessionId, {
        events: toolUseIds.map((id) => ({
          type: "user.tool_confirmation" as const,
          tool_use_id: id,
          result: "deny" as const,
          deny_message: message,
        })),
      });
    },

    async answerCustomTool(sessionId, customToolUseId, { text, isError }) {
      await client.beta.sessions.events.send(sessionId, {
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: customToolUseId,
            content: [{ type: "text", text }],
            is_error: isError,
          },
        ],
      });
    },

    async listEvents(sessionId, options) {
      const records: AgentEventRecord[] = [];
      const since = options?.since;
      try {
        for await (const event of client.beta.sessions.events.list(sessionId, {
          order: "asc",
          ...(since === undefined ? {} : { "created_at[gte]": since }),
        })) {
          records.push(toAgentEventRecord(event));
        }
      } catch (error) {
        if (isNotFound(error)) throw new SessionNotFoundError(sessionId, { cause: error });
        throw error;
      }
      return records;
    },

    readStoredEvent(payload) {
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("id" in payload) ||
        typeof payload.id !== "string" ||
        !("type" in payload) ||
        typeof payload.type !== "string"
      ) {
        return undefined;
      }
      // Stored exactly as the API listed it, so it reads back the same way.
      return toAgentEventRecord(payload as BetaManagedAgentsSessionEvent);
    },

    async readUsage(sessionId) {
      try {
        return toSessionUsage(await client.beta.sessions.retrieve(sessionId));
      } catch (error) {
        if (isNotFound(error)) throw new SessionNotFoundError(sessionId, { cause: error });
        throw error;
      }
    },
  };
}

/** Anthropic answers 404 for a session it no longer has. */
function isNotFound(error: unknown): boolean {
  return error instanceof Error && "status" in error && error.status === 404;
}

async function findAgentId(client: Anthropic, name: string): Promise<string | undefined> {
  let agentId: string | undefined;
  for await (const agent of client.beta.agents.list()) {
    if (agent.name === name && agent.archived_at === null) agentId = agent.id;
  }
  return agentId;
}

async function findEnvironmentId(client: Anthropic, name: string): Promise<string | undefined> {
  let environmentId: string | undefined;
  for await (const environment of client.beta.environments.list()) {
    if (environment.name === name && environment.archived_at === null) {
      environmentId = environment.id;
    }
  }
  return environmentId;
}

async function findVaultId(client: Anthropic, name: string): Promise<string | undefined> {
  let vaultId: string | undefined;
  for await (const vault of client.beta.vaults.list()) {
    if (vault.display_name === name && vault.archived_at === null) vaultId = vault.id;
  }
  return vaultId;
}

async function lookUpEngineerIds(client: Anthropic, config: AgentConfig): Promise<SessionIds> {
  const agentId = await findAgentId(client, config.agentName);
  const environmentId = await findEnvironmentId(client, config.environmentName);
  const vaultId = await findVaultId(client, config.vaultName);
  if (agentId === undefined || environmentId === undefined || vaultId === undefined) {
    throw new Error(
      `Agent "${config.agentName}", environment "${config.environmentName}" or vault ` +
        `"${config.vaultName}" not found. Run the agent sync (pnpm agent:sync) with this ` +
        "workspace's API key and AGENT_GITHUB_TOKEN.",
    );
  }
  return { agentId, environmentId, vaultId };
}

async function lookUpProductIds(client: Anthropic, config: AgentConfig): Promise<SessionIds> {
  const agentId = await findAgentId(client, config.productAgentName);
  const environmentId = await findEnvironmentId(client, config.environmentName);
  const vaultId = await findVaultId(client, config.vaultName);
  if (agentId === undefined || environmentId === undefined || vaultId === undefined) {
    throw new Error(
      `Agent "${config.productAgentName}", environment "${config.environmentName}" or vault ` +
        `"${config.vaultName}" not found. Run the agent sync (pnpm agent:sync) with this ` +
        "workspace's API key and ATLASSIAN_SERVICE_KEY.",
    );
  }
  return { agentId, environmentId, vaultId };
}

/** A Managed Agents event as it is recorded: untouched, with what the API makes of it. */
export function toAgentEventRecord(event: BetaManagedAgentsSessionEvent): AgentEventRecord {
  return {
    id: event.id,
    type: event.type,
    processedAt: processedAtOf(event),
    payload: event,
    event: toAgentEvent(event),
  };
}

/**
 * Every event carries `processed_at`; a user message still in the queue has none yet. Kept
 * as the string it came as, so no precision is lost on the way to the database.
 */
function processedAtOf(event: object): string | null {
  const value: unknown = "processed_at" in event ? event.processed_at : undefined;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return value;
}

/** A session's cumulative usage and budget, in the runtime-independent shape. */
export function toSessionUsage(
  session: Pick<BetaManagedAgentsSession, "usage" | "budget">,
): SessionUsage {
  const { usage, budget } = session;
  const cost = usage.list_cost ?? undefined;
  const limit = budget === null ? undefined : budget.max_list_cost;
  const creation = usage.cache_creation;
  return {
    inputTokens: usage.input_tokens ?? null,
    outputTokens: usage.output_tokens ?? null,
    cacheReadTokens: usage.cache_read_input_tokens ?? null,
    cacheCreationTokens:
      creation === undefined
        ? null
        : (creation.ephemeral_1h_input_tokens ?? 0) + (creation.ephemeral_5m_input_tokens ?? 0),
    activeSeconds: usage.active_seconds ?? null,
    listCostMinor: minorUnits(cost?.amount),
    budgetMinor: minorUnits(limit?.amount),
    currency: cost?.currency ?? limit?.currency ?? null,
  };
}

/** Anthropic gives money as an integer string in minor units ("50" is fifty cents). */
function minorUnits(amount: string | undefined): number | null {
  if (amount === undefined || !/^\d+$/.test(amount)) return null;
  const value = Number(amount);
  return Number.isSafeInteger(value) ? value : null;
}

/** A pull request's own link, as GitHub's MCP tools report it (`"html_url": "…/pull/22"`). */
const PULL_REQUEST_URL = /"html_url"\s*:\s*"(https:\/\/github\.com\/[^/"]+\/[^/"]+\/pull\/\d+)"/;
/** `git push`, also with options between (`git -C dir push`), in a shell command. */
const GIT_PUSH = /\bgit\b[^\n;&|]*\spush\b/;

/** Reduces a Managed Agents event to what the API acts on; undefined for everything else. */
export function toAgentEvent(event: BetaManagedAgentsSessionEvent): AgentEvent | undefined {
  switch (event.type) {
    case "user.message":
      return {
        kind: "user_message",
        id: event.id,
        processed: event.processed_at !== null && event.processed_at !== undefined,
      };
    case "agent.message": {
      const text = event.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n\n")
        .trim();
      return text === "" ? undefined : { kind: "agent_message", id: event.id, text };
    }
    case "session.status_running":
      return { kind: "running", id: event.id };
    case "session.status_idle":
      return event.stop_reason.type === "requires_action"
        ? {
            kind: "idle",
            id: event.id,
            reason: "requires_action",
            blockedOn: event.stop_reason.event_ids,
          }
        : { kind: "idle", id: event.id, reason: event.stop_reason.type };
    case "agent.mcp_tool_result": {
      if (event.is_error === true) return undefined;
      const text = (event.content ?? [])
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
      const url = PULL_REQUEST_URL.exec(text)?.[1];
      return url === undefined ? undefined : { kind: "pull_request", id: event.id, url };
    }
    case "agent.mcp_tool_use":
      return {
        kind: "mcp_tool_use",
        id: event.id,
        server: event.mcp_server_name,
        name: event.name,
      };
    case "agent.tool_use": {
      const command = event.name === "bash" ? event.input.command : undefined;
      return typeof command === "string" && GIT_PUSH.test(command)
        ? { kind: "pushed", id: event.id }
        : undefined;
    }
    case "user.tool_confirmation":
      return { kind: "tool_confirmation", id: event.id, toolUseId: event.tool_use_id };
    case "agent.custom_tool_use":
      return {
        kind: "custom_tool_use",
        id: event.id,
        name: event.name,
        input: event.input,
        processedAt: processedAtOf(event),
      };
    case "user.custom_tool_result":
      return {
        kind: "custom_tool_result",
        id: event.id,
        customToolUseId: event.custom_tool_use_id,
      };
    case "session.status_terminated":
      return { kind: "terminated", id: event.id };
    case "session.error":
      return {
        kind: "error",
        id: event.id,
        message: event.error.message,
      };
    default:
      return undefined;
  }
}
