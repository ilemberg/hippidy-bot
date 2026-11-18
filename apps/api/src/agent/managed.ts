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

interface Ids {
  agentId: string;
  environmentId: string;
  vaultId: string;
}

/**
 * Claude Managed Agents behind the AgentRuntime interface. The agent and environment are
 * created and updated by the sync script from the files in the repo; here they are looked up
 * by name once per server instance.
 */
export function createManagedAgentRuntime(
  config: AgentConfig,
  client = new Anthropic({ apiKey: config.apiKey, maxRetries: 2, timeout: 20_000 }),
): AgentRuntime {
  let ids: Promise<Ids> | undefined;

  const resolveIds = (): Promise<Ids> => {
    ids ??= lookUpIds(client, config).catch((error: unknown) => {
      ids = undefined; // try again on the next call
      throw error;
    });
    return ids;
  };

  return {
    async startSession({ title, metadata }) {
      // Fails closed (decision 122): without the token, no session starts, so the message
      // is answered with a note rather than reaching an agent that cannot see its repo.
      if (config.repository === undefined) {
        throw new Error("AGENT_GITHUB_TOKEN is missing or invalid; sessions cannot mount the repo");
      }
      const { agentId, environmentId, vaultId } = await resolveIds();
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
        budget: {
          type: "limit",
          max_list_cost: { amount: String(config.sessionBudgetCents), currency: "USD" },
        },
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

    async listEvents(sessionId) {
      const records: AgentEventRecord[] = [];
      try {
        for await (const event of client.beta.sessions.events.list(sessionId, { order: "asc" })) {
          records.push(toAgentEventRecord(event));
        }
      } catch (error) {
        if (isNotFound(error)) throw new SessionNotFoundError(sessionId, { cause: error });
        throw error;
      }
      return records;
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

async function lookUpIds(client: Anthropic, config: AgentConfig): Promise<Ids> {
  let agentId: string | undefined;
  for await (const agent of client.beta.agents.list()) {
    if (agent.name === config.agentName && agent.archived_at === null) agentId = agent.id;
  }
  let environmentId: string | undefined;
  for await (const environment of client.beta.environments.list()) {
    if (environment.name === config.environmentName && environment.archived_at === null) {
      environmentId = environment.id;
    }
  }
  let vaultId: string | undefined;
  for await (const vault of client.beta.vaults.list()) {
    if (vault.display_name === config.vaultName && vault.archived_at === null) vaultId = vault.id;
  }
  if (agentId === undefined || environmentId === undefined || vaultId === undefined) {
    throw new Error(
      `Agent "${config.agentName}", environment "${config.environmentName}" or vault ` +
        `"${config.vaultName}" not found. Run the agent sync (pnpm agent:sync) with this ` +
        "workspace's API key and AGENT_GITHUB_TOKEN.",
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
    case "user.tool_confirmation":
      return { kind: "tool_confirmation", id: event.id, toolUseId: event.tool_use_id };
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
