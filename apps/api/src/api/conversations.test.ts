import type { InboundMessage } from "@hippidy/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../agent/fake.ts";
import { getConversation, MAX_DELIVERY_ATTEMPTS } from "../store/conversations.ts";
import { createTestDb } from "../store/testing.ts";
import { memoryLogger } from "../testing.ts";
import {
  formatForAgent,
  MAX_FORWARD_ATTEMPTS,
  notes,
  reconcile,
  receiveMessage,
  stopConversation,
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

async function onlyConversation() {
  const rows = await db.query(`select id from conversations`);
  expect(rows).toHaveLength(1);
  return getConversation(db, String(rows[0]?.id));
}

async function sync(sessionId: string) {
  await syncConversation(deps, await conversationOf(sessionId), log);
}

/** Makes every waiting conversation and recorded message look `seconds` older. */
async function age(seconds: number) {
  await db.query(
    `update conversations set waiting_since = waiting_since - make_interval(secs => $1)`,
    [seconds],
  );
  await db.query(
    `update inbound_messages set created_at = created_at - make_interval(secs => $1),
       forwarded_at = forwarded_at - make_interval(secs => $1)`,
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
    expect(runtime.sessions.get(runtime.onlySessionId())?.sent).toHaveLength(2);
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

    const target = { source: "slack", workspaceId: "T1", channelId: "C1", threadId: "100.000001" };
    expect(slack.delivered).toEqual([
      { kind: "reply", target, text: "Here's the answer." },
      { kind: "status", target, messageIds: ["100.000001"], status: "answered" },
    ]);
    expect(await conversationOf(sessionId)).toMatchObject({
      status: "answered",
      waitingSince: null,
    });
  });

  it("posts a reply once however many times it syncs", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    runtime.reply(sessionId, "Once.");
    await sync(sessionId);
    await sync(sessionId);
    await reconcile(deps, log);
    expect(slack.replies()).toEqual(["Once."]);
    expect(slack.statuses()).toHaveLength(1);
  });

  it("lets only one sync run at a time, so replies keep their order", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    runtime.reply(sessionId, "First.", "Second.");
    const stalled = slack.stallNext();

    const first = sync(sessionId); // stalls while posting "First."
    await stalled;
    await sync(sessionId); // finds the first sync running and leaves the work to it
    expect(slack.replies()).toEqual([]);

    slack.release();
    await first;
    expect(slack.replies()).toEqual(["First.", "Second."]);
    expect(lines).toContainEqual(expect.objectContaining({ msg: "conversation.sync_skipped" }));
  });

  it("posts several messages of one turn in order", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    runtime.reply(sessionId, "First.", "Second.", "Third.");
    await sync(sessionId);
    expect(slack.replies()).toEqual(["First.", "Second.", "Third."]);
  });

  it("does not mark a queued message answered when the turn before it ends", async () => {
    await receiveMessage(deps, message(1), log);
    await receiveMessage(deps, message(2), log);
    const sessionId = runtime.onlySessionId();

    runtime.reply(sessionId, "Answer 1."); // the session answered message 1; 2 is still queued
    await sync(sessionId);
    expect(slack.replies()).toEqual(["Answer 1."]);
    expect(slack.statuses()).toEqual([{ messageIds: ["100.000001"], status: "answered" }]);
    expect((await conversationOf(sessionId)).status).toBe("waiting");

    runtime.reply(sessionId, "Answer 2.");
    await sync(sessionId);
    expect(slack.replies()).toEqual(["Answer 1.", "Answer 2."]);
    expect(slack.statuses()).toEqual([
      { messageIds: ["100.000001"], status: "answered" },
      { messageIds: ["100.000002"], status: "answered" },
    ]);
    expect((await conversationOf(sessionId)).status).toBe("answered");
  });

  it("retries a failed reply on the next sync, without skipping ahead", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    runtime.reply(sessionId, "First.", "Second.");
    slack.failures = 1;

    await sync(sessionId);
    expect(slack.delivered).toEqual([]);

    await sync(sessionId);
    expect(slack.replies()).toEqual(["First.", "Second."]);
    expect(slack.statuses()).toHaveLength(1);
  });

  it("retries a failed status (reaction), not just replies", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    runtime.reply(sessionId, "Done.");
    slack.failures = 0;
    // Let the reply through, then fail the status once.
    const deliver = slack.deliver.bind(slack);
    let calls = 0;
    slack.deliver = (delivery) => {
      calls++;
      if (calls === 2) return Promise.reject(new Error("reactions down"));
      return deliver(delivery);
    };
    await sync(sessionId);
    expect(slack.statuses()).toEqual([]);

    await reconcile(deps, log);
    expect(slack.statuses()).toEqual([{ messageIds: ["100.000001"], status: "answered" }]);
  });

  it("gives up on a delivery that keeps failing, logs it, and sends what comes after", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    runtime.reply(sessionId, "Doomed.");
    slack.failures = MAX_DELIVERY_ATTEMPTS;
    for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) await sync(sessionId);

    expect(slack.replies()).toEqual([]);
    expect(slack.statuses()).toEqual([{ messageIds: ["100.000001"], status: "answered" }]);
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: "conversation.delivery_abandoned", level: "error" }),
    );
  });

  it.each([
    ["retries_exhausted", notes.retries_exhausted],
    ["refusal", notes.refusal],
  ] as const)("reports %s as a failure of that turn", async (reason, note) => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    runtime.idle(sessionId, reason);
    await sync(sessionId);
    expect(slack.replies()).toEqual([note]);
    expect(slack.statuses()).toEqual([{ messageIds: ["100.000001"], status: "failed" }]);
    expect((await conversationOf(sessionId)).sessionState).toBe("active");
  });

  it("does nothing while the agent is still working", async () => {
    await receiveMessage(deps, message(1), log);
    await sync(runtime.onlySessionId());
    expect(slack.delivered).toEqual([]);
  });
});

describe("a thread whose session can take no more", () => {
  it("reports reaching the budget, and answers later messages there with a note", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    runtime.idle(sessionId, "budget_reached");
    await sync(sessionId);
    expect(slack.replies()).toEqual([notes.budget_reached]);
    expect(slack.statuses()).toEqual([{ messageIds: ["100.000001"], status: "failed" }]);

    runtime.rejectAllSends = new Error("400: session is paused at its budget");
    const later = await receiveMessage(deps, message(2), log);
    expect(later.duplicate).toBe(false);
    await reconcile(deps, log);
    expect(slack.replies()).toEqual([notes.budget_reached, notes.closed_budget]);
    expect(slack.statuses()).toEqual([
      { messageIds: ["100.000001"], status: "failed" },
      { messageIds: ["100.000002"], status: "failed" },
    ]);
    expect(runtime.sessions.get(sessionId)?.sent).toHaveLength(1);
  });

  it("reports a terminated session, including messages still queued in it", async () => {
    await receiveMessage(deps, message(1), log);
    await receiveMessage(deps, message(2), log);
    const sessionId = runtime.onlySessionId();
    runtime.terminate(sessionId);
    await sync(sessionId);
    expect(slack.replies()).toEqual([notes.terminated]);
    expect(slack.statuses()).toEqual([
      { messageIds: ["100.000001", "100.000002"], status: "failed" },
    ]);

    await receiveMessage(deps, message(3), log);
    await reconcile(deps, log);
    expect(slack.replies()).toEqual([notes.terminated, notes.closed_terminated]);
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

  it("reports a message as failed after it could not be handed over several times", async () => {
    runtime.failNext.startSession = new Error("agent not synced");
    await expect(receiveMessage(deps, message(1), log)).rejects.toThrow();
    for (let attempt = 1; attempt < MAX_FORWARD_ATTEMPTS; attempt++) {
      runtime.failNext.startSession = new Error("agent not synced");
      await age(120);
      await reconcile(deps, log);
    }
    expect(slack.replies()).toEqual([notes.undeliverable]);
    expect(slack.statuses()).toEqual([{ messageIds: ["100.000001"], status: "failed" }]);
    await age(120);
    expect(await reconcile(deps, log)).toEqual({ checked: 0, failed: 0 });
  });

  it("stops a turn that has run for half an hour and says so", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    await age(31 * 60);

    await reconcile(deps, log);
    expect(runtime.sessions.get(sessionId)?.interrupted).toBe(1);
    expect(slack.replies()).toEqual([notes.timeout]);
    expect(slack.statuses()).toEqual([{ messageIds: ["100.000001"], status: "failed" }]);
  });

  it("keeps going when one conversation fails", async () => {
    await receiveMessage(deps, message(1), log);
    await age(120);
    runtime.failNext.listEvents = new Error("anthropic down");
    expect(await reconcile(deps, log)).toEqual({ checked: 1, failed: 1 });
    expect((await onlyConversation()).status).toBe("waiting");
  });
});

describe("names", () => {
  it("tells the agent who is talking by name when the source knows it", async () => {
    await receiveMessage(deps, message(1, { actor: { id: "U1", displayName: "Ilya" } }), log);
    expect(runtime.sessions.get(runtime.onlySessionId())?.sent).toEqual([
      "From: Ilya (Slack user U1)\n\nquestion 1",
    ]);
  });

  it("keeps the name for messages handed over later by reconcile", async () => {
    runtime.failNext.startSession = new Error("anthropic down");
    await expect(
      receiveMessage(deps, message(1, { actor: { id: "U1", displayName: "Ilya" } }), log),
    ).rejects.toThrow();
    await age(120);
    await reconcile(deps, log);
    expect(runtime.sessions.get(runtime.onlySessionId())?.sent).toEqual([
      "From: Ilya (Slack user U1)\n\nquestion 1",
    ]);
  });
});

describe("stopConversation", () => {
  const thread = { source: "slack" as const, workspaceId: "T1", channelId: "C1" };

  it("interrupts a working agent, marks its messages and the stop message stopped, and says so", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();

    const result = await stopConversation(
      deps,
      {
        ...thread,
        sourceEventId: "EvStop",
        threadId: "100.000001",
        stopMessage: { messageId: "100.000009", sentAt: "2026-11-18T00:00:09.000Z" },
        actor: { id: "U1" },
      },
      log,
    );

    expect(result).toEqual({ status: "stopped" });
    expect(runtime.sessions.get(sessionId)?.interrupted).toBe(1);
    expect(slack.replies()).toEqual([notes.stopped]);
    expect(slack.statuses()).toEqual([
      { messageIds: ["100.000001"], status: "stopped" },
      { messageIds: ["100.000009"], status: "stopped" },
    ]);
    expect((await conversationOf(sessionId)).status).toBe("stopped");
  });

  it("does not mark the stopped messages answered when the interrupted turn ends", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    await stopConversation(
      deps,
      { ...thread, sourceEventId: "EvStop", threadId: "100.000001", actor: { id: "U1" } },
      log,
    );
    runtime.reply(sessionId); // the session goes idle after the interrupt
    await sync(sessionId);
    expect(slack.statuses()).toEqual([{ messageIds: ["100.000001"], status: "stopped" }]);
  });

  it("finds the conversation from a message, for a 🛑 reaction", async () => {
    await receiveMessage(deps, message(1), log);
    const result = await stopConversation(
      deps,
      { ...thread, sourceEventId: "EvR", messageId: "100.000001", actor: { id: "U1" } },
      log,
    );
    expect(result).toEqual({ status: "stopped" });
  });

  it("says when there is nothing to stop, and the thread carries on afterwards", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    runtime.reply(sessionId, "Done.");
    await sync(sessionId);

    const result = await stopConversation(
      deps,
      { ...thread, sourceEventId: "EvStop", threadId: "100.000001", actor: { id: "U1" } },
      log,
    );
    expect(result).toEqual({ status: "nothing_to_stop" });
    expect(runtime.sessions.get(sessionId)?.interrupted).toBe(0);
    expect(slack.replies()).toEqual(["Done.", notes.nothing_to_stop]);

    await receiveMessage(deps, message(2), log);
    expect(runtime.sessions.get(sessionId)?.sent).toHaveLength(2);
  });

  it("reports a stop for a thread it does not know", async () => {
    const result = await stopConversation(
      deps,
      { ...thread, sourceEventId: "EvStop", threadId: "999.1", actor: { id: "U1" } },
      log,
    );
    expect(result).toEqual({ status: "unknown_conversation" });
    expect(slack.delivered).toEqual([]);
  });

  it("is safe to repeat (a retried stop posts once)", async () => {
    await receiveMessage(deps, message(1), log);
    const request = {
      ...thread,
      sourceEventId: "EvStop",
      threadId: "100.000001",
      actor: { id: "U1" },
    };
    await stopConversation(deps, request, log);
    await stopConversation(deps, request, log);
    expect(slack.replies()).toEqual([notes.stopped]);
  });
});
