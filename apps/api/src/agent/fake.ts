import {
  SessionNotFoundError,
  type AgentEvent,
  type AgentEventRecord,
  type AgentKind,
  type AgentRuntime,
  type AgentSession,
  type IdleReason,
  type SessionUsage,
} from "./runtime.ts";

interface FakeSession {
  /** The agent the session was started with. */
  agentKind: AgentKind;
  metadata: Record<string, string>;
  sent: string[];
  /** Processed events, in the order the runtime lists them. */
  events: AgentEventRecord[];
  /** User messages still waiting in the session's queue; listed after everything else. */
  queued: { id: string }[];
  interrupted: number;
  /** Tool calls the API denied, in order (decision 119). */
  denied: string[];
  /** Custom tool calls the API answered, in order (decision 167). */
  answered: { customToolUseId: string; text: string; isError: boolean }[];
  usage: SessionUsage;
}

/** The agent id a session of each kind reports. */
const FAKE_AGENT_IDS: Record<AgentKind, string> = {
  engineer: "agent_fake",
  product: "agent_fake_product",
  teammate: "agent_fake_teammate",
};

/** The runtime's own names for the events the API acts on, as Managed Agents spells them. */
const TYPE_OF: Record<AgentEvent["kind"], string> = {
  user_message: "user.message",
  agent_message: "agent.message",
  running: "session.status_running",
  idle: "session.status_idle",
  terminated: "session.status_terminated",
  error: "session.error",
  tool_confirmation: "user.tool_confirmation",
  pull_request: "agent.mcp_tool_result",
  pushed: "agent.tool_use",
  mcp_tool_use: "agent.mcp_tool_use",
  git_read: "agent.tool_use",
  custom_tool_use: "agent.custom_tool_use",
  custom_tool_result: "user.custom_tool_result",
};

const NO_USAGE: SessionUsage = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  activeSeconds: null,
  listCostMinor: null,
  budgetMinor: null,
  currency: null,
};

/**
 * An in-memory agent runtime for tests. The test plays the agent: `reply` answers the oldest
 * queued message in one turn, `idle` and `terminate` end a session's work other ways. Queued
 * messages are listed last with `processed: false`, as Managed Agents orders events by when
 * they were processed. Like the real runtime, it also lists events the API does not act on
 * (a model request around every turn), and a user message changes once it is processed.
 */
export class FakeAgentRuntime implements AgentRuntime {
  readonly sessions = new Map<string, FakeSession>();
  /** Set to make the next call of that kind fail once. */
  failNext: Partial<
    Record<"startSession" | "sendMessage" | "listEvents" | "readUsage" | "answerCustomTool", Error>
  > = {};
  /** Agents the runtime does not have, as before the sync made them: starting one fails. */
  readonly missingAgents = new Set<AgentKind>();
  /** Set to make every send fail, as for a session paused at its budget. */
  rejectAllSends: Error | undefined;
  /** Runs while a usage read is under way: to look at, or hold up, what happens meanwhile. */
  onReadUsage: (() => Promise<void>) | undefined;
  private nextId = 1;
  private clock = Date.parse("2026-11-18T00:00:00.000Z");
  private readonly gone = new Set<string>();

  private id(prefix: string): string {
    return `${prefix}_${this.nextId++}`;
  }

  private session(sessionId: string): FakeSession {
    if (this.gone.has(sessionId)) throw new SessionNotFoundError(sessionId);
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`no such session ${sessionId}`);
    return session;
  }

  private takeFailure(kind: keyof FakeAgentRuntime["failNext"]): void {
    const error = this.failNext[kind];
    if (error !== undefined) {
      this.failNext = { ...this.failNext, [kind]: undefined };
      throw error;
    }
  }

  /** A processed event, one second after the one before it. */
  private record(type: string, id: string, event: AgentEvent | undefined): AgentEventRecord {
    this.clock += 1000;
    const processedAt = new Date(this.clock).toISOString();
    return {
      id,
      type,
      processedAt,
      payload: { id, type, processed_at: processedAt, ...event },
      event,
    };
  }

  private push(session: FakeSession, event: AgentEvent): void {
    session.events.push(this.record(TYPE_OF[event.kind], event.id, event));
  }

  startSession(input: {
    title: string;
    metadata: Record<string, string>;
    agentKind: AgentKind;
  }): Promise<AgentSession> {
    this.takeFailure("startSession");
    if (this.missingAgents.has(input.agentKind)) {
      return Promise.reject(new Error(`the ${input.agentKind} agent was not found`));
    }
    const sessionId = this.id("sesn");
    this.sessions.set(sessionId, {
      agentKind: input.agentKind,
      metadata: input.metadata,
      sent: [],
      events: [],
      queued: [],
      interrupted: 0,
      denied: [],
      answered: [],
      usage: NO_USAGE,
    });
    return Promise.resolve({
      sessionId,
      agentId: FAKE_AGENT_IDS[input.agentKind],
      agentVersion: 1,
    });
  }

  sendMessage(sessionId: string, text: string): Promise<string | undefined> {
    this.takeFailure("sendMessage");
    if (this.rejectAllSends !== undefined) return Promise.reject(this.rejectAllSends);
    const session = this.session(sessionId);
    session.sent.push(text);
    const id = this.id("sevt");
    session.queued.push({ id });
    return Promise.resolve(id);
  }

  interrupt(sessionId: string): Promise<void> {
    this.session(sessionId).interrupted++;
    return Promise.resolve();
  }

  denyToolCalls(sessionId: string, toolUseIds: readonly string[]): Promise<void> {
    const session = this.session(sessionId);
    for (const toolUseId of toolUseIds) {
      session.denied.push(toolUseId);
      this.push(session, { kind: "tool_confirmation", id: this.id("sevt"), toolUseId });
    }
    return Promise.resolve();
  }

  answerCustomTool(
    sessionId: string,
    customToolUseId: string,
    result: { text: string; isError: boolean },
  ): Promise<void> {
    this.takeFailure("answerCustomTool");
    const session = this.session(sessionId);
    session.answered.push({ customToolUseId, ...result });
    this.push(session, { kind: "custom_tool_result", id: this.id("sevt"), customToolUseId });
    return Promise.resolve();
  }

  /** Every `since` the API asked for, in order: to check what it reads. */
  readonly listedSince: (string | undefined)[] = [];

  listEvents(sessionId: string, options?: { since?: string }): Promise<AgentEventRecord[]> {
    this.takeFailure("listEvents");
    const session = this.session(sessionId);
    const since = options?.since;
    this.listedSince.push(since);
    const processed =
      since === undefined
        ? session.events
        : session.events.filter(
            (record) => record.processedAt !== null && record.processedAt >= since,
          );
    return Promise.resolve([
      ...processed,
      ...session.queued.map(({ id }): AgentEventRecord => ({
        id,
        type: TYPE_OF.user_message,
        processedAt: null,
        payload: { id, type: TYPE_OF.user_message },
        event: { kind: "user_message", id, processed: false },
      })),
    ]);
  }

  readStoredEvent(payload: unknown): AgentEventRecord | undefined {
    if (typeof payload !== "object" || payload === null || !("id" in payload)) return undefined;
    for (const session of this.sessions.values()) {
      const found = session.events.find((record) => record.id === payload.id);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  async readUsage(sessionId: string): Promise<SessionUsage> {
    this.takeFailure("readUsage");
    const session = this.session(sessionId);
    await this.onReadUsage?.();
    return session.usage;
  }

  /** The time the next event is processed at (each event moves it on by a second). */
  setClock(at: Date): void {
    this.clock = at.getTime() - 1000;
  }

  /**
   * The start of a turn that is still running: the oldest queued message is processed and the
   * agent says each text, but does not idle. End it with `idle` or `reply`.
   */
  work(sessionId: string, ...texts: string[]): void {
    const session = this.session(sessionId);
    const next = session.queued.shift();
    if (next !== undefined) {
      this.push(session, { kind: "user_message", id: next.id, processed: true });
    }
    this.push(session, { kind: "running", id: this.id("sevt") });
    for (const text of texts) {
      this.push(session, { kind: "agent_message", id: this.id("sevt"), text });
    }
  }

  /** The agent says each text (in a turn already running) and ends the turn. */
  finish(sessionId: string, ...texts: string[]): void {
    const session = this.session(sessionId);
    for (const text of texts) {
      this.push(session, { kind: "agent_message", id: this.id("sevt"), text });
    }
    this.push(session, { kind: "idle", id: this.id("sevt"), reason: "end_turn" });
  }

  /** The agent opens (or reads) a pull request, in a turn already running. */
  pullRequest(sessionId: string, url: string): void {
    this.push(this.session(sessionId), { kind: "pull_request", id: this.id("sevt"), url });
  }

  /** The agent calls a tool of an MCP server, in a turn already running. */
  mcpToolUse(sessionId: string, server: string, name: string): void {
    this.push(this.session(sessionId), { kind: "mcp_tool_use", id: this.id("sevt"), server, name });
  }

  /** The agent fetches or reads git refs other than `main`, in a turn already running. */
  gitRead(sessionId: string): void {
    this.push(this.session(sessionId), { kind: "git_read", id: this.id("sevt") });
  }

  /** The agent runs `git push`, in a turn already running. */
  pushed(sessionId: string): void {
    this.push(this.session(sessionId), { kind: "pushed", id: this.id("sevt") });
  }

  /** The agent waits for approval of new tool calls; returns their ids. */
  waitForApproval(sessionId: string, count = 1): string[] {
    const session = this.session(sessionId);
    const toolUseIds = Array.from({ length: count }, () =>
      this.other(sessionId, "agent.mcp_tool_use"),
    );
    this.push(session, {
      kind: "idle",
      id: this.id("sevt"),
      reason: "requires_action",
      blockedOn: toolUseIds,
    });
    return toolUseIds;
  }

  /**
   * The agent calls custom tools, in a turn already running, then waits on them, and on
   * `approvals` new tool calls that wait for approval besides (decision 167). Returns the ids
   * of the custom calls and of the others.
   */
  callCustomTools(
    sessionId: string,
    calls: readonly { name: string; input: unknown }[],
    approvals = 0,
  ): { custom: string[]; approvals: string[] } {
    const session = this.session(sessionId);
    const custom = calls.map(({ name, input }) => {
      const id = this.id("sevt");
      // The time `push` gives the event's record: one second after the one before it.
      const processedAt = new Date(this.clock + 1000).toISOString();
      this.push(session, { kind: "custom_tool_use", id, name, input, processedAt });
      return id;
    });
    const others = Array.from({ length: approvals }, () =>
      this.other(sessionId, "agent.mcp_tool_use"),
    );
    this.push(session, {
      kind: "idle",
      id: this.id("sevt"),
      reason: "requires_action",
      blockedOn: [...custom, ...others],
    });
    return { custom, approvals: others };
  }

  /** One turn: the oldest queued message is processed, the agent says each text, then idles. */
  reply(sessionId: string, ...texts: string[]): void {
    const session = this.session(sessionId);
    const next = session.queued.shift();
    if (next !== undefined) {
      this.push(session, { kind: "user_message", id: next.id, processed: true });
    }
    this.push(session, { kind: "running", id: this.id("sevt") });
    this.other(sessionId, "span.model_request_start");
    for (const text of texts) {
      this.push(session, { kind: "agent_message", id: this.id("sevt"), text });
    }
    this.other(sessionId, "span.model_request_end");
    this.push(session, { kind: "idle", id: this.id("sevt"), reason: "end_turn" });
  }

  /** The agent stops for the given reason after processing the oldest queued message. */
  idle(sessionId: string, reason: IdleReason): void {
    const session = this.session(sessionId);
    const next = session.queued.shift();
    if (next !== undefined) {
      this.push(session, { kind: "user_message", id: next.id, processed: true });
    }
    this.push(session, { kind: "idle", id: this.id("sevt"), reason });
  }

  terminate(sessionId: string): void {
    this.push(this.session(sessionId), { kind: "terminated", id: this.id("sevt") });
  }

  /** An event the API only records, such as a tool use or a model request. Returns its id. */
  other(sessionId: string, type: string): string {
    const id = this.id("sevt");
    this.session(sessionId).events.push(this.record(type, id, undefined));
    return id;
  }

  /** What the session reports as used from now on. */
  setUsage(sessionId: string, usage: Partial<SessionUsage>): void {
    const session = this.session(sessionId);
    session.usage = { ...session.usage, ...usage };
  }

  /** The runtime no longer has the session: reading it throws SessionNotFoundError. */
  forget(sessionId: string): void {
    this.gone.add(sessionId);
  }

  /** The only session, for tests that start exactly one. */
  onlySessionId(): string {
    const ids = [...this.sessions.keys()];
    if (ids.length !== 1 || ids[0] === undefined) {
      throw new Error(`expected one session, found ${ids.length}`);
    }
    return ids[0];
  }
}
