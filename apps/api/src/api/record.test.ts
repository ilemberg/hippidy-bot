import type { InboundMessage } from "@hippidy/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../agent/fake.ts";
import type { Db } from "../store/db.ts";
import { createTestDb } from "../store/testing.ts";
import { memoryLogger } from "../testing.ts";
import { receiveMessage, syncConversation, type ConversationDeps } from "./conversations.ts";
import { getConversation } from "../store/conversations.ts";
import { backfillRecord, BACKFILL_PER_RUN } from "./record.ts";
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

function message(n: number, threadId = "100.000001"): InboundMessage {
  return {
    source: "slack",
    sourceEventId: `Ev${threadId}-${n}`,
    conversation: {
      workspaceId: "T1",
      channelId: "C1",
      threadId,
      messageId: n === 1 ? threadId : `${threadId}${n}`,
    },
    actor: { id: "U1", displayName: "Ilya" },
    text: `question ${n}`,
    sentAt: `2026-11-17T00:00:0${n}.000Z`,
  };
}

async function conversationOf(sessionId: string) {
  const rows = await db.query(`select id from conversations where agent_session_id = $1`, [
    sessionId,
  ]);
  return getConversation(db, String(rows[0]?.id));
}

async function sync(sessionId: string, using: ConversationDeps = deps) {
  await syncConversation(using, await conversationOf(sessionId), log);
}

function storedEvents() {
  return db.query(
    `select event_id, type, kind, text, processed_at is not null as processed
     from agent_events order by seq`,
  );
}

function logged(msg: string) {
  return lines.filter((line) => line.msg === msg);
}

async function syncedAt(sessionId: string) {
  const rows = await db.query(
    `select agent_events_synced_at as at from conversations where agent_session_id = $1`,
    [sessionId],
  );
  return rows[0]?.at;
}

/** A database whose writes to the event log fail, as if the record were broken. */
function withBrokenEventLog(real: Db): Db {
  return {
    query: (text, params) =>
      text.includes("insert into agent_events")
        ? Promise.reject(new Error("event log is down"))
        : real.query(text, params),
    transaction: (work) => real.transaction(work),
  };
}

describe("a sync keeps the record", () => {
  it("stores every event the session lists, including those the API does not act on", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    runtime.reply(sessionId, "An answer.");
    await sync(sessionId);

    expect(slack.replies()).toEqual(["An answer."]);
    expect((await storedEvents()).map(({ type, kind, text }) => ({ type, kind, text }))).toEqual([
      { type: "user.message", kind: "user_message", text: null },
      { type: "session.status_running", kind: "running", text: null },
      { type: "span.model_request_start", kind: null, text: null },
      { type: "agent.message", kind: "agent_message", text: "An answer." },
      { type: "span.model_request_end", kind: null, text: null },
      { type: "session.status_idle", kind: "idle", text: null },
    ]);
    expect(await syncedAt(sessionId)).toBeInstanceOf(Date);
  });

  it("makes the conversation readable from the database alone", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    runtime.reply(sessionId, "An answer.", "And a second part.");
    await sync(sessionId);
    await receiveMessage(deps, message(2), log);
    runtime.idle(sessionId, "budget_reached");
    await sync(sessionId);

    const rows = await db.query(
      `select role, text, actor_name, message_status, delivery_status
       from conversation_transcript order by occurred_at, recorded_at`,
    );
    expect(rows).toEqual([
      {
        role: "user",
        text: "question 1",
        actor_name: "Ilya",
        message_status: "answered",
        delivery_status: null,
      },
      {
        role: "user",
        text: "question 2",
        actor_name: "Ilya",
        message_status: "failed",
        delivery_status: null,
      },
      // The fake agent's clock is a day ahead of the messages' `sentAt` here.
      {
        role: "agent",
        text: "An answer.",
        actor_name: null,
        message_status: null,
        delivery_status: "sent",
      },
      {
        role: "agent",
        text: "And a second part.",
        actor_name: null,
        message_status: null,
        delivery_status: "sent",
      },
      {
        role: "note",
        text: expect.stringContaining("spending limit") as unknown,
        actor_name: null,
        message_status: null,
        delivery_status: "sent",
      },
    ]);
  });

  it("updates a queued message's event once the agent has processed it", async () => {
    await receiveMessage(deps, message(1), log);
    await receiveMessage(deps, message(2), log);
    const sessionId = runtime.onlySessionId();
    runtime.reply(sessionId, "First answer.");
    await sync(sessionId);

    const queued = (await storedEvents()).filter((event) => event.processed === false);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ type: "user.message", kind: "user_message" });

    runtime.reply(sessionId, "Second answer.");
    await sync(sessionId);
    const events = await storedEvents();
    expect(events.filter((event) => event.processed === false)).toEqual([]);
    expect(events.filter((event) => event.event_id === queued[0]?.event_id)).toHaveLength(1);
    expect(slack.replies()).toEqual(["First answer.", "Second answer."]);
  });

  it("stores nothing twice when a sync runs again with nothing new", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    runtime.reply(sessionId, "An answer.");
    await sync(sessionId);
    lines.length = 0;
    await sync(sessionId);

    expect(await storedEvents()).toHaveLength(6);
    expect(logged("record.events_stored")).toEqual([]);
    expect(slack.replies()).toEqual(["An answer."]);
  });

  it("still answers when the event log cannot be written, and catches up later", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    runtime.reply(sessionId, "An answer.");
    await sync(sessionId, { ...deps, db: withBrokenEventLog(db) });

    expect(slack.replies()).toEqual(["An answer."]);
    expect(slack.statuses()).toEqual([{ messageIds: ["100.000001"], status: "answered" }]);
    expect(logged("record.events_failed")).toHaveLength(1);
    expect(logged("record.events_failed")[0]?.level).toBe("error");
    expect(await storedEvents()).toEqual([]);
    expect(await syncedAt(sessionId)).toBeNull();

    await sync(sessionId);
    expect(await storedEvents()).toHaveLength(6);
    expect(slack.replies()).toEqual(["An answer."]);
  });
});

describe("a sync keeps the session's usage", () => {
  function usage() {
    return db.query(
      `select usage_input_tokens::int as input, usage_output_tokens::int as output,
              usage_list_cost_minor::int as cost, budget_list_cost_minor::int as budget,
              cost_currency as currency
       from conversations`,
    );
  }

  it("stores what the session has used so far, and its budget", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    runtime.reply(sessionId, "An answer.");
    runtime.setUsage(sessionId, {
      inputTokens: 1200,
      outputTokens: 340,
      listCostMinor: 7,
      budgetMinor: 200,
      currency: "USD",
    });
    await sync(sessionId);
    expect(await usage()).toEqual([
      { input: 1200, output: 340, cost: 7, budget: 200, currency: "USD" },
    ]);

    await receiveMessage(deps, message(2), log);
    runtime.reply(sessionId, "Another.");
    runtime.setUsage(sessionId, { inputTokens: 2600, outputTokens: 700, listCostMinor: 15 });
    await sync(sessionId);
    expect(await usage()).toEqual([
      { input: 2600, output: 700, cost: 15, budget: 200, currency: "USD" },
    ]);
  });

  it("still answers, and frees the conversation, when the usage cannot be read", async () => {
    await receiveMessage(deps, message(1), log);
    const sessionId = runtime.onlySessionId();
    runtime.reply(sessionId, "An answer.");
    runtime.failNext.readUsage = new Error("anthropic down");
    await sync(sessionId);

    expect(slack.replies()).toEqual(["An answer."]);
    expect(logged("record.usage_failed")).toHaveLength(1);
    expect(await db.query(`select sync_lease_until from conversations`)).toEqual([
      { sync_lease_until: null },
    ]);
  });
});

describe("backfillRecord", () => {
  /** A thread answered before the record existed: delivered, but nothing stored. */
  async function oldThread(threadId: string) {
    await receiveMessage(deps, message(1, threadId), log);
    const sessionId = [...runtime.sessions.keys()].at(-1) ?? "";
    runtime.reply(sessionId, `Answer in ${threadId}.`);
    await sync(sessionId);
    await db.query(`delete from agent_events`);
    await db.query(
      `update conversations set agent_events_synced_at = null, usage_updated_at = null`,
    );
    return sessionId;
  }

  it("stores the events and usage of a conversation that was never stored, once", async () => {
    const sessionId = await oldThread("100.000001");
    runtime.setUsage(sessionId, { inputTokens: 500, listCostMinor: 2, currency: "USD" });
    const delivered = slack.delivered.length;

    expect(await backfillRecord(deps, log)).toBe(1);
    expect(await storedEvents()).toHaveLength(6);
    expect(await syncedAt(sessionId)).toBeInstanceOf(Date);
    expect(await db.query(`select usage_input_tokens::int as input from conversations`)).toEqual([
      { input: 500 },
    ]);
    // It only records: nothing is sent to anyone again.
    expect(slack.delivered).toHaveLength(delivered);

    expect(await backfillRecord(deps, log)).toBe(0);
  });

  it("does only a few conversations per run", async () => {
    for (let n = 1; n <= BACKFILL_PER_RUN + 2; n++) await oldThread(`${n}00.000001`);

    expect(await backfillRecord(deps, log)).toBe(BACKFILL_PER_RUN);
    expect(await backfillRecord(deps, log)).toBe(2);
    expect(await backfillRecord(deps, log)).toBe(0);
    const rows = await db.query(
      `select count(distinct conversation_id)::int as conversations from agent_events`,
    );
    expect(rows).toEqual([{ conversations: BACKFILL_PER_RUN + 2 }]);
  });

  it("marks a conversation whose session the runtime no longer has, and moves on", async () => {
    const sessionId = await oldThread("100.000001");
    runtime.forget(sessionId);

    expect(await backfillRecord(deps, log)).toBe(1);
    expect(logged("record.backfill_session_gone")).toHaveLength(1);
    expect(await storedEvents()).toEqual([]);
    expect(await backfillRecord(deps, log)).toBe(0);
  });

  it("leaves a conversation for a later run when the runtime fails for another reason", async () => {
    const sessionId = await oldThread("100.000001");
    runtime.failNext.listEvents = new Error("anthropic down");

    expect(await backfillRecord(deps, log)).toBe(0);
    expect(logged("record.backfill_failed")).toHaveLength(1);
    expect(await syncedAt(sessionId)).toBeNull();

    expect(await backfillRecord(deps, log)).toBe(1);
    expect(await storedEvents()).toHaveLength(6);
  });

  it("leaves a conversation for a later run when the event log cannot be written", async () => {
    const sessionId = await oldThread("100.000001");

    expect(await backfillRecord({ ...deps, db: withBrokenEventLog(db) }, log)).toBe(0);
    expect(await syncedAt(sessionId)).toBeNull();
    expect(await backfillRecord(deps, log)).toBe(1);
  });

  it("never throws, even when the database is down", async () => {
    const down: Db = {
      query: () => Promise.reject(new Error("database down")),
      transaction: () => Promise.reject(new Error("database down")),
    };
    expect(await backfillRecord({ ...deps, db: down }, log)).toBe(0);
    expect(logged("record.backfill_failed")).toHaveLength(1);
  });
});
