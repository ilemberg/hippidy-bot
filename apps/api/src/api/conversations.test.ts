import type { InboundMessage } from "@hippidy/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../agent/fake.ts";
import { getConversation } from "../store/conversations.ts";
import { createTestDb } from "../store/testing.ts";
import { memoryLogger } from "../testing.ts";
import {
  formatForAgent,
  reconcile,
  receiveMessage,
  syncConversation,
  type ConversationDeps,
} from "./conversations.ts";
import { RecordingDeliverer } from "./testing.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
let runtime: FakeAgentRuntime;
let slack: RecordingDeliverer;
let deps: ConversationDeps;
const { log, lines } = memoryLogger();

beforeEach(async () => {
  db = await createTestDb();
  runtime = new FakeAgentRuntime();
  slack = new RecordingDeliverer();
  deps = { db, runtime, deliverers: { slack }, sleep: () => Promise.resolve() };
  lines.length = 0;
});

afterEach(async () => {
  await db.close();
});

function message(n: number, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    source: "slack",
    sourceEventId: `Ev${n}`,
    conversation: {
      workspaceId: "T1",
      channelId: "C1",
      threadId: "100.000001",
      messageId: `100.00000${n}`,
    },
    actor: { id: "U1" },
    text: `question ${n}`,
    sentAt: `2026-11-18T00:00:0${n}.000Z`,
    ...overrides,
  };
}

async function conversationOf(sessionId: string) {
  const rows = await db.query(`select id from conversations where agent_session_id = $1`, [
    sessionId,
  ]);
  return getConversation(db, String(rows[0]?.id));
}

async function sync(sessionId: string) {
  await syncConversation(deps, await conversationOf(sessionId), log);
}

/** Makes every waiting conversation and message look old enough for reconcile. */
async function age(seconds: number) {
  await db.query(
    `update conversations set waiting_since = waiting_since - make_interval(secs => $1)`,
    [seconds],
  );
  await db.query(
    `update inbound_messages set created_at = created_at - make_interval(secs => $1)`,
    [seconds],
  );
}

describe("receiveMessage", () => {
  it("starts a session for a new thread and hands the message to it", async () => {
    const result = await receiveMessage(deps, message(1), log);
    expect(result.duplicate).toBe(false);

    const sessionId = runtime.onlySessionId();
    expect(runtime.sessions.get(sessionId)?.sent).toEqual([formatForAgent("U1", "question 1")]);
    expect(runtime.sessions.get(sessionId)?.metadata).toMatchObject({
      source: "slack",
      channel_id: "C1",
      thread_id: "100.000001",
    });
    expect(await conversationOf(sessionId)).toMatchObject({ status: "waiting", agentVersion: 1 });
  });

  it("continues the same session for a later message in the thread", async () => {
    await receiveMessage(deps, message(1), log);
    await receiveMessage(deps, message(2), log);
    const sessionId = runtime.onlySessionId();
    expect(runtime.sessions.get(sessionId)?.sent).toHaveLength(2);
  });

  it("starts a separate session for a different thread", async () => {
    await receiveMessage(deps, message(1), log);
    await receiveMessage(
      deps,
      message(2, {
        conversation: { workspaceId: "T1", channelId: "C1", threadId: "200.1", messageId: "200.1" },
      }),
      log,
    );
    expect(runtime.sessions.size).toBe(2);
  });

  it("ignores a message it already handed over", async () => {
    await receiveMessage(deps, message(1), log);
    const again = await receiveMessage(deps, message(1), log);
    expect(again.duplicate).toBe(true);
    expect(runtime.sessions.get(runtime.onlySessionId())?.sent).toHaveLength(1);
  });

  it("starts one session when two first messages in a thread arrive together", async () => {
    await Promise.all([
      receiveMessage(deps, message(1), log),
      receiveMessage(deps, message(2), log),
    ]);
    expect(runtime.sessions.size).toBe(1);
    expect(runtime.sessions.get(runtime.onlySessionId())?.sent).toHaveLength(2);
  });

  it("lets a retry finish the job when the agent call failed the first time", async () => {
    runtime.failNext.sendMessage = new Error("anthropic down");
    await expect(receiveMessage(deps, message(1), log)).rejects.toThrow("anthropic down");
    const retry = await receiveMessage(deps, message(1), log);
    expect(retry.duplicate).toBe(true);
    expect(runtime.sessions.get(runtime.onlySessionId())?.sent).toHaveLength(1);
  });

  it("tries again to start the session after a failed start", async () => {
    runtime.failNext.startSession = new Error("anthropic down");
    await expect(receiveMessage(deps, message(1), log)).rejects.toThrow("anthropic down");
    await receiveMessage(deps, message(1), log);
    expect(runtime.sessions.size).toBe(1);
  });
});

describe("syncConversation", () => {
  it("posts the agent's reply in the thread and marks the message answered", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    runtime.reply(sessionId, "Here's the answer.");

    await sync(sessionId);

    expect(slack.delivered).toEqual([
      {
        kind: "reply",
        target: { source: "slack", workspaceId: "T1", channelId: "C1", threadId: "100.000001" },
        text: "Here's the answer.",
      },
      {
        kind: "status",
        target: { source: "slack", workspaceId: "T1", channelId: "C1", threadId: "100.000001" },
        messageIds: ["100.000001"],
        status: "answered",
      },
    ]);
    expect(await conversationOf(sessionId)).toMatchObject({
      status: "answered",
      waitingSince: null,
    });
  });

  it("posts a reply once when the webhook and reconcile both sync", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    runtime.reply(sessionId, "Once.");
    await Promise.all([sync(sessionId), sync(sessionId)]);
    await sync(sessionId);
    expect(slack.replies()).toEqual(["Once."]);
    expect(slack.statuses()).toHaveLength(1);
  });

  it("posts several messages of one turn in order", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    runtime.reply(sessionId, "First.", "Second.", "Third.");
    await sync(sessionId);
    expect(slack.replies()).toEqual(["First.", "Second.", "Third."]);
  });

  it("answers two quick messages in order, settling each only when its turn is done", async () => {
    await receiveMessage(deps, message(1), log);
    await receiveMessage(deps, message(2), log);
    const sessionId = runtime.onlySessionId();

    // The agent has answered the first message but not yet started on the second.
    runtime.reply(sessionId, "Answer 1.");
    const events = runtime.sessions.get(sessionId)?.events ?? [];
    // Move the second user message after the first answer, as the session queue does.
    const second = events.splice(1, 1);
    events.push(...second);
    await sync(sessionId);
    expect(slack.replies()).toEqual(["Answer 1."]);
    expect(slack.statuses()).toEqual([]); // a user message is still pending after the idle

    runtime.reply(sessionId, "Answer 2.");
    await sync(sessionId);
    expect(slack.replies()).toEqual(["Answer 1.", "Answer 2."]);
    expect(slack.statuses()).toEqual([
      { messageIds: ["100.000001", "100.000002"], status: "answered" },
    ]);
  });

  it("retries a failed reply on the next sync, without skipping ahead", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    runtime.reply(sessionId, "First.", "Second.");
    slack.failures = 1;

    await sync(sessionId);
    expect(slack.replies()).toEqual([]);
    expect((await conversationOf(sessionId)).status).toBe("waiting");

    await sync(sessionId);
    expect(slack.replies()).toEqual(["First.", "Second."]);
    expect((await conversationOf(sessionId)).status).toBe("answered");
  });

  it.each([
    ["budget_reached", "spending limit"],
    ["retries_exhausted", "went wrong"],
    ["refusal", "can't help"],
  ] as const)("reports %s as a failure", async (reason, words) => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    runtime.idle(sessionId, reason);
    await sync(sessionId);
    expect(slack.replies()).toEqual([expect.stringContaining(words) as string]);
    expect(slack.statuses()).toEqual([{ messageIds: ["100.000001"], status: "failed" }]);
  });

  it("reports a terminated session as a failure", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    runtime.terminate(sessionId);
    await sync(sessionId);
    expect(slack.statuses()).toEqual([{ messageIds: ["100.000001"], status: "failed" }]);
  });

  it("does nothing while the agent is still working", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    await sync(sessionId);
    expect(slack.delivered).toEqual([]);
  });
});

describe("reconcile", () => {
  it("delivers a reply whose webhook was lost", async () => {
    await receiveMessage(deps, message(1), log);
    runtime.reply(runtime.onlySessionId(), "Recovered.");
    await age(120);

    expect(await reconcile(deps, log)).toEqual({ checked: 1, failed: 0 });
    expect(slack.replies()).toEqual(["Recovered."]);
    expect(await reconcile(deps, log)).toEqual({ checked: 0, failed: 0 });
  });

  it("leaves a conversation alone until it has waited a minute", async () => {
    await receiveMessage(deps, message(1), log);
    runtime.reply(runtime.onlySessionId(), "Not yet.");
    expect(await reconcile(deps, log)).toEqual({ checked: 0, failed: 0 });
  });

  it("hands over a message that never reached the agent", async () => {
    runtime.failNext.startSession = new Error("anthropic down");
    await expect(receiveMessage(deps, message(1), log)).rejects.toThrow();
    await age(120);

    await reconcile(deps, log);
    expect(runtime.sessions.get(runtime.onlySessionId())?.sent).toEqual([
      formatForAgent("U1", "question 1"),
    ]);
  });

  it("retries a failed delivery", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    runtime.reply(sessionId, "Eventually.");
    slack.failures = 1;
    await sync(sessionId);
    expect(slack.replies()).toEqual([]);

    await reconcile(deps, log);
    expect(slack.replies()).toEqual(["Eventually."]);
  });

  it("stops a turn that has run for half an hour and says so", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    await age(31 * 60);

    await reconcile(deps, log);
    expect(runtime.sessions.get(sessionId)?.interrupted).toBe(1);
    expect(slack.replies()).toEqual([expect.stringContaining("took too long") as string]);
    expect(slack.statuses()).toEqual([{ messageIds: ["100.000001"], status: "failed" }]);
  });

  it("keeps going when one conversation fails", async () => {
    await receiveMessage(deps, message(1), log);
    await age(120);
    runtime.failNext.listEvents = new Error("anthropic down");
    expect(await reconcile(deps, log)).toEqual({ checked: 1, failed: 1 });
  });
});
