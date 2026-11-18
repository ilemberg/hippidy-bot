import {
  SessionNotFoundError,
  type AgentEvent,
  type AgentEventRecord,
  type AgentRuntime,
  type AgentSession,
  type IdleReason,
  type SessionUsage,
} from "./runtime.ts";

interface FakeSession {
  metadata: Record<string, string>;
  sent: string[];
  /** Processed events, in the order the runtime lists them. */
  events: AgentEventRecord[];
  /** User messages still waiting in the session's queue; listed after everything else. */
  queued: { id: string }[];
  interrupted: number;
  usage: SessionUsage;
}

/** The runtime's own names for the events the API acts on, as Managed Agents spells them. */
const TYPE_OF: Record<AgentEvent["kind"], string> = {
  user_message: "user.message",
  agent_message: "agent.message",
  running: "session.status_running",
  idle: "session.status_idle",
  terminated: "session.status_terminated",
  error: "session.error",
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
  failNext: Partial<Record<"startSession" | "sendMessage" | "listEvents" | "readUsage", Error>> =
    {};
  /** Set to make every send fail, as for a session paused at its budget. */
  rejectAllSends: Error | undefined;
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
    const processedAt = new Date(this.clock);
    return {
      id,
      type,
      processedAt,
      payload: { id, type, processed_at: processedAt.toISOString(), ...event },
      event,
    };
  }

  private push(session: FakeSession, event: AgentEvent): void {
    session.events.push(this.record(TYPE_OF[event.kind], event.id, event));
  }

  startSession(input: { title: string; metadata: Record<string, string> }): Promise<AgentSession> {
    this.takeFailure("startSession");
    const sessionId = this.id("sesn");
    this.sessions.set(sessionId, {
      metadata: input.metadata,
      sent: [],
      events: [],
      queued: [],
      interrupted: 0,
      usage: NO_USAGE,
    });
    return Promise.resolve({ sessionId, agentId: "agent_fake", agentVersion: 1 });
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

  listEvents(sessionId: string): Promise<AgentEventRecord[]> {
    this.takeFailure("listEvents");
    const session = this.session(sessionId);
    return Promise.resolve([
      ...session.events,
      ...session.queued.map(({ id }): AgentEventRecord => ({
        id,
        type: TYPE_OF.user_message,
        processedAt: null,
        payload: { id, type: TYPE_OF.user_message },
        event: { kind: "user_message", id, processed: false },
      })),
    ]);
  }

  readUsage(sessionId: string): Promise<SessionUsage> {
    this.takeFailure("readUsage");
    return Promise.resolve(this.session(sessionId).usage);
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
