import type { InboundMessage } from "@hippidy/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../agent/fake.ts";
import { syncChange } from "../api/changes.ts";
import { receiveMessage, syncConversation, type ConversationDeps } from "../api/conversations.ts";
import { RecordingDeliverer } from "../api/testing.ts";
import { memoryLogger } from "../testing.ts";
import { getChange } from "./changes.ts";
import { findOrCreateConversation, getConversation } from "./conversations.ts";
import { listSessions, SNIPPET_CHARACTERS } from "./sessions.ts";
import { createTestDb } from "./testing.ts";

// Slice 2.4: the agents at work, read from the database alone.

let db: Awaited<ReturnType<typeof createTestDb>>;
let runtime: FakeAgentRuntime;
let deps: ConversationDeps;
const { log } = memoryLogger();

beforeEach(async () => {
  db = await createTestDb();
  runtime = new FakeAgentRuntime();
  deps = {
    db,
    runtime,
    deliverers: { slack: new RecordingDeliverer() },
    sleep: () => Promise.resolve(),
  };
});

afterEach(async () => {
  await db.close();
});

function message(thread: string, text: string, actor = "U1", name = "Ada"): InboundMessage {
  return {
    source: "slack",
    sourceEventId: `Ev${thread}${text.length}`,
    conversation: {
      workspaceId: "T1",
      channelId: "C1",
      threadId: thread,
      messageId: `${thread}.1`,
    },
    actor: { id: actor, displayName: name },
    text,
    sentAt: "2026-11-25T00:00:01.000Z",
  };
}

async function conversation(thread: string) {
  return findOrCreateConversation(db, {
    source: "slack",
    workspaceId: "T1",
    channelId: "C1",
    threadId: thread,
  });
}

describe("listSessions", () => {
  it("lists a thread's session with who asked, its latest words and its cost", async () => {
    await receiveMessage(deps, message("100.1", "how does search work?"), log);
    const sessionId = runtime.onlySessionId();
    runtime.reply(sessionId, "It uses full-text search.");
    runtime.setUsage(sessionId, { listCostMinor: 42, budgetMinor: 500, currency: "USD" });
    await syncConversation(deps, await conversation("100.1"), log);

    const [session] = await listSessions(db, 10);
    expect(session).toMatchObject({
      kind: "thread",
      changeId: null,
      title: "how does search work?",
      agent: "teammate",
      state: "idle",
      askedBy: { actorId: "U1", name: "Ada" },
      project: null,
      latestActivity: { text: "It uses full-text search." },
      cost: { spentMinor: 42, budgetMinor: 500, currency: "USD" },
      thread: { source: "slack", channelId: "C1", threadId: "100.1" },
    });
  });

  it("lists a change's worker beside its thread, working ones first", async () => {
    // An older, finished thread.
    await receiveMessage(deps, message("100.1", "a question"), log);
    runtime.reply(runtime.onlySessionId(), "An answer.");
    await syncConversation(deps, await conversation("100.1"), log);

    // A newer thread whose teammate hands a change to a worker.
    await receiveMessage(deps, message("200.1", "change the reaction", "U2", "Grace"), log);
    const teammate = [...runtime.sessions.keys()][1] ?? "";
    runtime.work(teammate);
    runtime.callCustomTools(teammate, [
      {
        name: "start_change",
        input: { title: "Change the reaction", what: "Use 🫡.", why: "Asked.", doneWhen: "CI." },
      },
    ]);
    await syncConversation(deps, await conversation("200.1"), log);

    const sessions = await listSessions(db, 10);
    // Active ones first, the newest (the worker, started after its thread) at the top.
    expect(sessions.map((s) => [s.kind, s.state, s.title])).toEqual([
      ["worker", "working", "Change the reaction"],
      ["thread", "working", "change the reaction"],
      ["thread", "idle", "a question"],
    ]);
    expect(sessions[0]).toMatchObject({
      agent: "worker",
      askedBy: { actorId: "U2", name: "Grace" },
    });
  });

  it("shows a brief waiting for Start, and a stopped change", async () => {
    await receiveMessage(deps, message("300.1", "fix SCRUM-12"), log);
    const teammate = runtime.onlySessionId();
    runtime.work(teammate);
    runtime.mcpToolUse(teammate, "atlassian", "getJiraIssue");
    runtime.callCustomTools(teammate, [
      { name: "start_change", input: { title: "Fix it", what: "x", why: "y", doneWhen: "z" } },
    ]);
    await syncConversation(deps, await conversation("300.1"), log);
    const waiting = (await listSessions(db, 10)).find((s) => s.kind === "worker");
    expect(waiting).toMatchObject({ state: "waiting_for_start", cost: { spentMinor: null } });

    await db.query(`update changes set status = 'stopped'`);
    expect((await listSessions(db, 10)).find((s) => s.kind === "worker")?.state).toBe("stopped");
  });

  it("leaves out a thread with no session yet, shortens long text, and keeps to the limit", async () => {
    await conversation("400.1");
    expect(await listSessions(db, 10)).toEqual([]);
    for (const thread of ["500.1", "500.2", "500.3"]) {
      await receiveMessage(deps, message(thread, "x".repeat(SNIPPET_CHARACTERS + 50)), log);
    }
    const sessions = await listSessions(db, 2);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.title).toHaveLength(SNIPPET_CHARACTERS);
    expect(sessions[0]?.title.endsWith("…")).toBe(true);
  });

  it("names a worker failed when its budget ran out", async () => {
    await receiveMessage(deps, message("600.1", "change it"), log);
    const teammate = runtime.onlySessionId();
    runtime.work(teammate);
    runtime.callCustomTools(teammate, [
      { name: "start_change", input: { title: "Change it", what: "x", why: "y", doneWhen: "z" } },
    ]);
    await syncConversation(deps, await getConversation(db, (await conversation("600.1")).id), log);
    const [row] = await db.query(`select id from changes`);
    const change = await getChange(db, String(row?.id));
    runtime.idle(change.agentSessionId ?? "", "budget_reached");
    await syncChange(deps, change, log);
    expect((await listSessions(db, 10)).find((s) => s.kind === "worker")?.state).toBe("failed");
  });
});
