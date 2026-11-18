import { Anthropic } from "@anthropic-ai/sdk";
import type { BetaManagedAgentsSessionEvent } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { AgentConfig } from "./config.ts";
import type { AgentEvent, AgentRuntime } from "./runtime.ts";

interface Ids {
  agentId: string;
  environmentId: string;
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
      const { agentId, environmentId } = await resolveIds();
      const session = await client.beta.sessions.create({
        agent: agentId,
        environment_id: environmentId,
        title,
        metadata,
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
      await client.beta.sessions.events.send(sessionId, {
        events: [{ type: "user.message", content: [{ type: "text", text }] }],
      });
    },

    async interrupt(sessionId) {
      await client.beta.sessions.events.send(sessionId, { events: [{ type: "user.interrupt" }] });
    },

    async listEvents(sessionId) {
      const events: AgentEvent[] = [];
      for await (const event of client.beta.sessions.events.list(sessionId, { order: "asc" })) {
        const mapped = toAgentEvent(event);
        if (mapped !== undefined) events.push(mapped);
      }
      return events;
    },
  };
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
  if (agentId === undefined || environmentId === undefined) {
    throw new Error(
      `Agent "${config.agentName}" or environment "${config.environmentName}" not found. ` +
        "Run the agent sync (pnpm agent:sync) with this workspace's API key.",
    );
  }
  return { agentId, environmentId };
}

/** Reduces a Managed Agents event to what the API acts on; everything else is dropped. */
export function toAgentEvent(event: BetaManagedAgentsSessionEvent): AgentEvent | undefined {
  switch (event.type) {
    case "user.message":
      return { kind: "user_message", id: event.id };
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
      return { kind: "idle", id: event.id, reason: event.stop_reason.type };
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
