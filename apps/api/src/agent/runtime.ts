/**
 * What the API needs from an agent runtime, independent of who runs the agent (wave 1 rule
 * 3). Managed Agents is the only implementation for now; tests use a fake.
 */
export interface AgentRuntime {
  /** Starts a session for one conversation, with the per-session budget applied. */
  startSession(input: { title: string; metadata: Record<string, string> }): Promise<AgentSession>;
  /** Queues a user message. Sessions process queued messages in order. */
  sendMessage(sessionId: string, text: string): Promise<void>;
  /** Stops the agent's current turn. */
  interrupt(sessionId: string): Promise<void>;
  /** Every event of the session so far, oldest first, reduced to what the API acts on. */
  listEvents(sessionId: string): Promise<AgentEvent[]>;
}

export interface AgentSession {
  sessionId: string;
  agentId: string;
  agentVersion: number;
}

/** Why the agent stopped and is waiting. */
export type IdleReason =
  "end_turn" | "budget_reached" | "retries_exhausted" | "refusal" | "requires_action";

export type AgentEvent =
  | { kind: "user_message"; id: string }
  | { kind: "agent_message"; id: string; text: string }
  | { kind: "running"; id: string }
  | { kind: "idle"; id: string; reason: IdleReason }
  | { kind: "terminated"; id: string }
  | { kind: "error"; id: string; message: string };
