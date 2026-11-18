/**
 * What the API needs from an agent runtime, independent of who runs the agent (wave 1 rule
 * 3). Managed Agents is the only implementation for now; tests use a fake.
 */
export interface AgentRuntime {
  /** Starts a session for one conversation, with the per-session budget applied. */
  startSession(input: { title: string; metadata: Record<string, string> }): Promise<AgentSession>;
  /**
   * Queues a user message. Sessions process queued messages in order. Returns the event id the
   * runtime gave the message, when it reports one.
   */
  sendMessage(sessionId: string, text: string): Promise<string | undefined>;
  /** Stops the agent's current turn. */
  interrupt(sessionId: string): Promise<void>;
  /**
   * Every event of the session so far, oldest first, exactly as the runtime reported it, each
   * with what the API makes of it. Throws SessionNotFoundError if the runtime no longer has
   * the session.
   */
  listEvents(sessionId: string): Promise<AgentEventRecord[]>;
  /**
   * What the session has used so far and the budget it runs under. Throws
   * SessionNotFoundError if the runtime no longer has the session.
   */
  readUsage(sessionId: string): Promise<SessionUsage>;
}

/** The runtime no longer has this session (deleted, or past its retention). */
export class SessionNotFoundError extends Error {
  constructor(sessionId: string, options?: { cause: unknown }) {
    super(`the agent runtime has no session ${sessionId}`, options);
    this.name = "SessionNotFoundError";
  }
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
  /** `processed` is false while the message waits in the session's queue. */
  | { kind: "user_message"; id: string; processed: boolean }
  | { kind: "agent_message"; id: string; text: string }
  | { kind: "running"; id: string }
  | { kind: "idle"; id: string; reason: IdleReason }
  | { kind: "terminated"; id: string }
  | { kind: "error"; id: string; message: string };

/**
 * One event as the runtime reported it (decision 75: kept as a log), with what the API makes
 * of it. Most events are only recorded: tool use, thinking, model requests, usage.
 */
export interface AgentEventRecord {
  id: string;
  /** The runtime's own name for the event, for example "agent.message". */
  type: string;
  /** The runtime's clock. Null while a user message still waits in the session's queue. */
  processedAt: Date | null;
  /** The event as the runtime sent it: plain JSON. */
  payload: unknown;
  /** What the API acts on; undefined for events it only records. */
  event: AgentEvent | undefined;
}

/**
 * Cumulative use of a session, as the runtime reports it. A number is null when the runtime
 * did not report it. Money is in minor units of `currency` (cents for USD).
 */
export interface SessionUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  /** Seconds the session was running: what its runtime cost is priced on. */
  activeSeconds: number | null;
  /** Cost so far at public list prices. */
  listCostMinor: number | null;
  /** The session's spend ceiling. */
  budgetMinor: number | null;
  currency: string | null;
}

/** The events the API acts on, in order, from the full list. */
export function actedOn(records: readonly AgentEventRecord[]): AgentEvent[] {
  return records.flatMap((record) => (record.event === undefined ? [] : [record.event]));
}
