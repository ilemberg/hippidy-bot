/**
 * What the API needs from an agent runtime, independent of who runs the agent (wave 1 rule
 * 3). Managed Agents is the only implementation for now; tests use a fake.
 */
export interface AgentRuntime {
  /**
   * Starts a session for one conversation, with the per-session budget applied, run by the
   * agent the conversation was given (decision 167).
   */
  startSession(input: {
    title: string;
    metadata: Record<string, string>;
    agentKind: AgentKind;
  }): Promise<AgentSession>;
  /**
   * Queues a user message. Sessions process queued messages in order. Returns the event id the
   * runtime gave the message, when it reports one.
   */
  sendMessage(sessionId: string, text: string): Promise<string | undefined>;
  /** Stops the agent's current turn. */
  interrupt(sessionId: string): Promise<void>;
  /**
   * Answers tool calls that wait for approval with a denial, so the session carries on
   * (decision 119). The ids are those an idle event is blocked on.
   */
  denyToolCalls(sessionId: string, toolUseIds: readonly string[], message: string): Promise<void>;
  /**
   * Answers one custom tool call with its result (decision 167). The session waits on the call
   * until it is answered; `isError` tells the agent the call failed, and the text says why.
   */
  answerCustomTool(
    sessionId: string,
    customToolUseId: string,
    result: { text: string; isError: boolean },
  ): Promise<void>;
  /**
   * Every event of the session so far, oldest first, exactly as the runtime reported it, each
   * with what the API makes of it. With `since` (an ISO 8601 time), only the events processed
   * at or after it, plus user messages still in the queue (decisions 95, 127). Throws
   * SessionNotFoundError if the runtime no longer has the session.
   */
  listEvents(sessionId: string, options?: { since?: string }): Promise<AgentEventRecord[]>;
  /**
   * Reads back an event kept in the record: the payload exactly as `listEvents` reported it.
   * Undefined if it is not one of this runtime's events.
   */
  readStoredEvent(payload: unknown): AgentEventRecord | undefined;
  /**
   * What the session has used so far and the budget it runs under. Throws
   * SessionNotFoundError if the runtime no longer has the session.
   */
  readUsage(sessionId: string): Promise<SessionUsage>;
}

/**
 * Which of the bot's agents runs a session. The engineer is the coding worker (decision 181,
 * `agents/hippidy.md`): it changes code, given work as a brief, and threads opened on it
 * before slice 2.1 keep it. The teammate (`agents/teammate.md`) talks with every new thread,
 * reads Jira, Confluence and the repo, and cannot publish. The product agent (decision 139)
 * writes the plan, reads the repo and changes nothing; threads opened on it keep it.
 */
export type AgentKind = "engineer" | "product" | "teammate";

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
  /** `blockedOn`: for `requires_action`, the tool calls waiting for approval. */
  | { kind: "idle"; id: string; reason: IdleReason; blockedOn?: string[] }
  /** A pull request the agent opened, updated or read: its link, from a GitHub tool's result. */
  | { kind: "pull_request"; id: string; url: string }
  /** The agent ran `git push` in its sandbox. */
  | { kind: "pushed"; id: string }
  /**
   * The agent called a tool of an MCP server (Jira, Confluence, GitHub). The start rule of
   * slice 2.1 reads these: a brief written after one needs a person to start it (decision 181).
   */
  | { kind: "mcp_tool_use"; id: string; server: string; name: string }
  /** An answer to a tool call that waited for approval. */
  | { kind: "tool_confirmation"; id: string; toolUseId: string }
  /**
   * The agent called a custom tool the API answers (decision 167); `id` is the call's id.
   * `processedAt` is when, by the runtime's clock, exactly as given; null if it gave none.
   */
  | {
      kind: "custom_tool_use";
      id: string;
      name: string;
      input: unknown;
      processedAt: string | null;
    }
  /** An answer to a custom tool call. */
  | { kind: "custom_tool_result"; id: string; customToolUseId: string }
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
  /**
   * The runtime's clock, as an ISO 8601 timestamp exactly as it was given (it can be finer
   * than a JavaScript Date). Null while a user message still waits in the session's queue.
   */
  processedAt: string | null;
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
