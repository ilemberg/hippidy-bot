import type { AgentEvent, AgentRuntime, AgentSession, IdleReason } from "./runtime.ts";

interface FakeSession {
  metadata: Record<string, string>;
  sent: string[];
  /** Processed events, in the order the runtime lists them. */
  events: AgentEvent[];
  /** User messages still waiting in the session's queue; listed after everything else. */
  queued: { id: string }[];
  interrupted: number;
}

/**
 * An in-memory agent runtime for tests. The test plays the agent: `reply` answers the oldest
 * queued message in one turn, `idle` and `terminate` end a session's work other ways. Queued
 * messages are listed last with `processed: false`, as Managed Agents orders events by when
 * they were processed.
 */
export class FakeAgentRuntime implements AgentRuntime {
  readonly sessions = new Map<string, FakeSession>();
  /** Set to make the next call of that kind fail once. */
  failNext: Partial<Record<"startSession" | "sendMessage" | "listEvents", Error>> = {};
  /** Set to make every send fail, as for a session paused at its budget. */
  rejectAllSends: Error | undefined;
  private nextId = 1;

  private id(prefix: string): string {
    return `${prefix}_${this.nextId++}`;
  }

  private session(sessionId: string): FakeSession {
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

  startSession(input: { title: string; metadata: Record<string, string> }): Promise<AgentSession> {
    this.takeFailure("startSession");
    const sessionId = this.id("sesn");
    this.sessions.set(sessionId, {
      metadata: input.metadata,
      sent: [],
      events: [],
      queued: [],
      interrupted: 0,
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

  listEvents(sessionId: string): Promise<AgentEvent[]> {
    this.takeFailure("listEvents");
    const session = this.session(sessionId);
    return Promise.resolve([
      ...session.events,
      ...session.queued.map(({ id }) => ({ kind: "user_message" as const, id, processed: false })),
    ]);
  }

  /** One turn: the oldest queued message is processed, the agent says each text, then idles. */
  reply(sessionId: string, ...texts: string[]): void {
    const session = this.session(sessionId);
    const next = session.queued.shift();
    if (next !== undefined) {
      session.events.push({ kind: "user_message", id: next.id, processed: true });
    }
    session.events.push({ kind: "running", id: this.id("sevt") });
    for (const text of texts) {
      session.events.push({ kind: "agent_message", id: this.id("sevt"), text });
    }
    session.events.push({ kind: "idle", id: this.id("sevt"), reason: "end_turn" });
  }

  /** The agent stops for the given reason after processing the oldest queued message. */
  idle(sessionId: string, reason: IdleReason): void {
    const session = this.session(sessionId);
    const next = session.queued.shift();
    if (next !== undefined) {
      session.events.push({ kind: "user_message", id: next.id, processed: true });
    }
    session.events.push({ kind: "idle", id: this.id("sevt"), reason });
  }

  terminate(sessionId: string): void {
    this.session(sessionId).events.push({ kind: "terminated", id: this.id("sevt") });
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
