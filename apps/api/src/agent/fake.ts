import type { AgentEvent, AgentRuntime, AgentSession, IdleReason } from "./runtime.ts";

interface FakeSession {
  metadata: Record<string, string>;
  sent: string[];
  events: AgentEvent[];
  interrupted: number;
}

/** An in-memory agent runtime for tests. The test plays the agent with `reply` and `idle`. */
export class FakeAgentRuntime implements AgentRuntime {
  readonly sessions = new Map<string, FakeSession>();
  /** Set to make the next call of that kind fail once. */
  failNext: Partial<Record<"startSession" | "sendMessage" | "listEvents", Error>> = {};
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
      interrupted: 0,
    });
    return Promise.resolve({ sessionId, agentId: "agent_fake", agentVersion: 1 });
  }

  sendMessage(sessionId: string, text: string): Promise<void> {
    this.takeFailure("sendMessage");
    const session = this.session(sessionId);
    session.sent.push(text);
    session.events.push({ kind: "user_message", id: this.id("sevt") });
    return Promise.resolve();
  }

  interrupt(sessionId: string): Promise<void> {
    this.session(sessionId).interrupted++;
    return Promise.resolve();
  }

  listEvents(sessionId: string): Promise<AgentEvent[]> {
    this.takeFailure("listEvents");
    return Promise.resolve([...this.session(sessionId).events]);
  }

  /** The agent answers: it runs, says each text, and goes idle with end_turn. */
  reply(sessionId: string, ...texts: string[]): void {
    const { events } = this.session(sessionId);
    events.push({ kind: "running", id: this.id("sevt") });
    for (const text of texts) events.push({ kind: "agent_message", id: this.id("sevt"), text });
    events.push({ kind: "idle", id: this.id("sevt"), reason: "end_turn" });
  }

  /** The agent stops without finishing, for the given reason. */
  idle(sessionId: string, reason: IdleReason): void {
    this.session(sessionId).events.push({ kind: "idle", id: this.id("sevt"), reason });
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
