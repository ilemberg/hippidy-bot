import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  enqueueDelivery,
  findOrCreateConversation,
  getConversation,
  markDeliverySent,
  recordInbound,
  unsentDeliveries,
  type ConversationKey,
} from "./conversations.ts";
import {
  conversationsToBackfill,
  markAgentEventsSynced,
  recordUsage,
  storeAgentEvents,
  type AgentEventToStore,
  type UsageToStore,
} from "./record.ts";
import { createTestDb } from "./testing.ts";

// The schema of the record (slice 3), before any code writes it: these tests insert rows
// with SQL to pin down what the migration promises.

const key: ConversationKey = {
  source: "slack",
  workspaceId: "T1",
  channelId: "C1",
  threadId: "100.000001",
};

let db: Awaited<ReturnType<typeof createTestDb>>;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.close();
});

async function insertEvent(
  conversationId: string,
  event: { id: string; type: string; kind?: string; text?: string; processedAt?: string },
): Promise<void> {
  await db.query(
    `insert into agent_events
       (conversation_id, agent_session_id, event_id, type, kind, text, processed_at, payload)
     values ($1, 'sesn_1', $2, $3, $4, $5, $6, $7)`,
    [
      conversationId,
      event.id,
      event.type,
      event.kind ?? null,
      event.text ?? null,
      event.processedAt ?? null,
      JSON.stringify({ id: event.id, type: event.type }),
    ],
  );
}

describe("agent_events", () => {
  it("stores an event once per conversation, and lets it change", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await insertEvent(conversation.id, { id: "evt_1", type: "user.message", kind: "user_message" });
    await expect(
      insertEvent(conversation.id, { id: "evt_1", type: "user.message", kind: "user_message" }),
    ).rejects.toThrow(/unique|duplicate/i);

    // A queued user message gains its processed time later: the row is updated in place.
    const rows = await db.query(
      `insert into agent_events
         (conversation_id, agent_session_id, event_id, type, kind, processed_at, payload)
       values ($1, 'sesn_1', 'evt_1', 'user.message', 'user_message', $2, '{}')
       on conflict (conversation_id, event_id)
         do update set processed_at = excluded.processed_at, updated_at = now()
       returning processed_at`,
      [conversation.id, "2026-11-18T00:00:05.000Z"],
    );
    expect(rows).toEqual([{ processed_at: new Date("2026-11-18T00:00:05.000Z") }]);
    expect(await db.query(`select count(*)::int as n from agent_events`)).toEqual([{ n: 1 }]);
  });

  it("keeps events the API does not act on, with the raw payload", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await insertEvent(conversation.id, { id: "evt_9", type: "span.model_request_end" });
    const rows = await db.query(`select type, kind, payload from agent_events`);
    expect(rows).toEqual([
      {
        type: "span.model_request_end",
        kind: null,
        payload: { id: "evt_9", type: "span.model_request_end" },
      },
    ]);
  });

  it("goes when its conversation is deleted", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await insertEvent(conversation.id, { id: "evt_1", type: "agent.message" });
    await db.query(`delete from conversations where id = $1`, [conversation.id]);
    expect(await db.query(`select count(*)::int as n from agent_events`)).toEqual([{ n: 0 }]);
  });
});

describe("conversations", () => {
  it("has usage, budget and backfill columns that start empty, unseen by existing code", async () => {
    const created = await findOrCreateConversation(db, key);
    const rows = await db.query(
      `select usage_input_tokens, usage_output_tokens, usage_cache_read_tokens,
              usage_cache_creation_tokens, usage_active_seconds, usage_list_cost_minor,
              budget_list_cost_minor, cost_currency, usage_updated_at, agent_events_synced_at
       from conversations where id = $1`,
      [created.id],
    );
    expect(Object.values(rows[0] ?? { missing: true })).toEqual(Array(10).fill(null));
    expect(await getConversation(db, created.id)).toEqual(created);
  });
});

describe("conversation_transcript", () => {
  it("lists what people wrote, what the agent answered and the API's notes, in order", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const other = await findOrCreateConversation(db, { ...key, threadId: "200.000001" });

    await recordInbound(db, conversation.id, {
      source: "slack",
      sourceEventId: "Ev1",
      conversation: { ...key, messageId: "100.000001" },
      actor: { id: "U1", displayName: "Ilya" },
      text: "what is agile?",
      sentAt: "2026-11-18T00:00:01.000Z",
    });
    // The agent's own copy of the question, and a span: neither is a transcript line.
    await insertEvent(conversation.id, {
      id: "evt_user",
      type: "user.message",
      kind: "user_message",
      processedAt: "2026-11-18T00:00:02.000Z",
    });
    await insertEvent(conversation.id, { id: "evt_span", type: "span.model_request_end" });
    await insertEvent(conversation.id, {
      id: "evt_answer",
      type: "agent.message",
      kind: "agent_message",
      text: "A way of working in short cycles.",
      processedAt: "2026-11-18T00:00:03.000Z",
    });
    await insertEvent(conversation.id, {
      id: "evt_undelivered",
      type: "agent.message",
      kind: "agent_message",
      text: "One more thing.",
      processedAt: "2026-11-18T00:00:04.000Z",
    });
    await enqueueDelivery(db, conversation.id, "evt_answer", "reply", {
      kind: "reply",
      target: key,
      text: "A way of working in short cycles.",
    });
    await enqueueDelivery(db, conversation.id, "note:evt_idle", "note", {
      kind: "reply",
      target: key,
      text: "I've reached this conversation's spending limit.",
    });
    // A status delivery (reactions) is not a transcript line either.
    await enqueueDelivery(db, conversation.id, "status:evt_idle:1", "status", {
      kind: "status",
      target: key,
      messageIds: ["100.000001"],
      status: "failed",
    });
    const [answer] = await unsentDeliveries(db, conversation.id);
    if (answer === undefined) throw new Error("expected a queued delivery");
    await markDeliverySent(db, answer.id);
    await db.query(
      `update deliveries set created_at = '2026-11-18T00:00:05.000Z' where kind = 'note'`,
    );

    // Another thread's lines stay out.
    await insertEvent(other.id, {
      id: "evt_other",
      type: "agent.message",
      kind: "agent_message",
      text: "elsewhere",
      processedAt: "2026-11-18T00:00:03.000Z",
    });

    const rows = await db.query(
      `select role, text, actor_id, actor_name, ref, message_status, delivery_status, occurred_at
       from conversation_transcript
       where conversation_id = $1
       order by occurred_at, recorded_at, position`,
      [conversation.id],
    );
    expect(rows).toEqual([
      {
        role: "user",
        text: "what is agile?",
        actor_id: "U1",
        actor_name: "Ilya",
        ref: "100.000001",
        message_status: "received",
        delivery_status: null,
        occurred_at: new Date("2026-11-18T00:00:01.000Z"),
      },
      {
        role: "agent",
        text: "A way of working in short cycles.",
        actor_id: null,
        actor_name: null,
        ref: "evt_answer",
        message_status: null,
        delivery_status: "sent",
        occurred_at: new Date("2026-11-18T00:00:03.000Z"),
      },
      {
        role: "agent",
        text: "One more thing.",
        actor_id: null,
        actor_name: null,
        ref: "evt_undelivered",
        message_status: null,
        delivery_status: null,
        occurred_at: new Date("2026-11-18T00:00:04.000Z"),
      },
      {
        role: "note",
        text: "I've reached this conversation's spending limit.",
        actor_id: null,
        actor_name: null,
        ref: "note:evt_idle",
        message_status: null,
        delivery_status: "pending",
        occurred_at: new Date("2026-11-18T00:00:05.000Z"),
      },
    ]);
  });
});

function event(id: string, overrides: Partial<AgentEventToStore> = {}): AgentEventToStore {
  return {
    id,
    type: "agent.message",
    kind: "agent_message",
    text: `text of ${id}`,
    processedAt: "2026-11-18T00:00:03.000Z",
    payload: { id, type: "agent.message", content: [{ type: "text", text: `text of ${id}` }] },
    ...overrides,
  };
}

const noUsage: UsageToStore = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  activeSeconds: null,
  listCostMinor: null,
  budgetMinor: null,
  currency: null,
};

describe("storeAgentEvents", () => {
  it("stores events in the order given, with their payload as JSON", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const written = await storeAgentEvents(db, conversation.id, "sesn_1", [
      event("evt_2", { type: "span.model_request_end", kind: null, text: null, payload: { n: 1 } }),
      event("evt_1"),
    ]);
    expect(written).toBe(2);
    const rows = await db.query(
      `select agent_session_id, event_id, type, kind, text, processed_at, payload,
              jsonb_typeof(payload) as payload_type
       from agent_events order by seq`,
    );
    expect(rows).toEqual([
      {
        agent_session_id: "sesn_1",
        event_id: "evt_2",
        type: "span.model_request_end",
        kind: null,
        text: null,
        processed_at: new Date("2026-11-18T00:00:03.000Z"),
        payload: { n: 1 },
        payload_type: "object",
      },
      {
        agent_session_id: "sesn_1",
        event_id: "evt_1",
        type: "agent.message",
        kind: "agent_message",
        text: "text of evt_1",
        processed_at: new Date("2026-11-18T00:00:03.000Z"),
        payload: {
          id: "evt_1",
          type: "agent.message",
          content: [{ type: "text", text: "text of evt_1" }],
        },
        payload_type: "object",
      },
    ]);
  });

  it("changes nothing when the same events are stored again", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await storeAgentEvents(db, conversation.id, "sesn_1", [event("evt_1"), event("evt_2")]);
    await db.query(`update agent_events set updated_at = '2026-01-01T00:00:00Z'`);

    expect(
      await storeAgentEvents(db, conversation.id, "sesn_1", [event("evt_1"), event("evt_2")]),
    ).toBe(0);
    const rows = await db.query(`select distinct updated_at from agent_events`);
    expect(rows).toEqual([{ updated_at: new Date("2026-01-01T00:00:00Z") }]);

    // Not even attempted: a new event gets the next place in line, with no gap before it.
    await storeAgentEvents(db, conversation.id, "sesn_1", [event("evt_1"), event("evt_3")]);
    expect(await db.query(`select seq::int as seq from agent_events order by seq`)).toEqual([
      { seq: 1 },
      { seq: 2 },
      { seq: 3 },
    ]);
  });

  it("updates an event the runtime now reports differently, and only that one", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const queued = event("evt_user", {
      type: "user.message",
      kind: "user_message",
      text: null,
      processedAt: null,
      payload: { id: "evt_user", type: "user.message" },
    });
    await storeAgentEvents(db, conversation.id, "sesn_1", [event("evt_1"), queued]);

    const processedAt = "2026-11-18T00:00:09.000Z";
    const processed = {
      ...queued,
      processedAt,
      payload: { id: "evt_user", type: "user.message", processed_at: processedAt },
    };
    const written = await storeAgentEvents(db, conversation.id, "sesn_1", [
      event("evt_1"),
      processed,
    ]);
    expect(written).toBe(1);
    const stored = () =>
      db.query(`select event_id, processed_at, payload from agent_events order by seq`);
    const after = {
      event_id: "evt_user",
      processed_at: new Date(processedAt),
      payload: { id: "evt_user", type: "user.message", processed_at: processedAt },
    };
    expect((await stored())[1]).toEqual(after);
    expect(await stored()).toHaveLength(2);

    // A list read before the agent processed the message, but stored after: it changes
    // nothing. A processed time is never taken away.
    expect(await storeAgentEvents(db, conversation.id, "sesn_1", [queued])).toBe(0);
    expect((await stored())[1]).toEqual(after);
  });

  it("keeps the runtime's time to the microsecond", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await storeAgentEvents(db, conversation.id, "sesn_1", [
      event("evt_b", { processedAt: "2026-11-18T00:00:03.123457Z" }),
      event("evt_a", { processedAt: "2026-11-18T00:00:03.123456Z" }),
    ]);
    const rows = await db.query(
      `select event_id, to_char(processed_at at time zone 'UTC', 'SS.US') as second
       from agent_events order by processed_at`,
    );
    expect(rows).toEqual([
      { event_id: "evt_a", second: "03.123456" },
      { event_id: "evt_b", second: "03.123457" },
    ]);
  });

  it("keeps the last report when a list names an event twice", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const written = await storeAgentEvents(db, conversation.id, "sesn_1", [
      event("evt_1", { text: "first" }),
      event("evt_1", { text: "second" }),
    ]);
    expect(written).toBe(1);
    expect(await db.query(`select text from agent_events`)).toEqual([{ text: "second" }]);
  });

  it("stores more events than fit in one statement", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const many = Array.from({ length: 450 }, (_, n) => event(`evt_${n}`));
    expect(await storeAgentEvents(db, conversation.id, "sesn_1", many)).toBe(450);
    const rows = await db.query(
      `select event_id from agent_events order by seq offset 448 limit 2`,
    );
    expect(rows).toEqual([{ event_id: "evt_448" }, { event_id: "evt_449" }]);
  });

  it("stores what Postgres cannot hold as it is: null characters and lone surrogates", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const written = await storeAgentEvents(db, conversation.id, "sesn_1", [
      event("evt_1", {
        text: "a\u0000b \ud83d",
        payload: { output: "x\u0000y", "ke\u0000y": "half \ude00", path: "C:\\u0000", ok: "😀" },
      }),
      event("evt_2"),
    ]);
    expect(written).toBe(2);
    expect(await db.query(`select text, payload from agent_events order by seq limit 1`)).toEqual([
      {
        text: "ab \ufffd",
        payload: { output: "xy", key: "half \ufffd", path: "C:\\u0000", ok: "😀" },
      },
    ]);
  });

  it("does nothing for an empty list", async () => {
    const conversation = await findOrCreateConversation(db, key);
    expect(await storeAgentEvents(db, conversation.id, "sesn_1", [])).toBe(0);
  });
});

describe("recordUsage", () => {
  async function usageOf(conversationId: string) {
    const rows = await db.query(
      `select usage_input_tokens::int as input, usage_output_tokens::int as output,
              usage_cache_read_tokens::int as cache_read,
              usage_cache_creation_tokens::int as cache_creation,
              usage_active_seconds as active, usage_list_cost_minor::int as cost,
              budget_list_cost_minor::int as budget, cost_currency as currency,
              usage_updated_at is not null as stamped
       from conversations where id = $1`,
      [conversationId],
    );
    return rows[0];
  }

  it("stores what the runtime reports", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const stored = await recordUsage(db, conversation.id, {
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 900,
      cacheCreationTokens: 50,
      activeSeconds: 12.5,
      listCostMinor: 7,
      budgetMinor: 200,
      currency: "USD",
    });
    expect(stored).toBe(true);
    expect(await usageOf(conversation.id)).toEqual({
      input: 1200,
      output: 340,
      cache_read: 900,
      cache_creation: 50,
      active: 12.5,
      cost: 7,
      budget: 200,
      currency: "USD",
      stamped: true,
    });
  });

  it("keeps an earlier value for a number the runtime did not report this time", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await recordUsage(db, conversation.id, { ...noUsage, inputTokens: 10, listCostMinor: 3 });
    await recordUsage(db, conversation.id, { ...noUsage, inputTokens: 25 });
    expect(await usageOf(conversation.id)).toMatchObject({ input: 25, cost: 3 });
  });

  it("never puts an older reading back: usage only grows", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const later = { ...noUsage, inputTokens: 900, activeSeconds: 30.5, listCostMinor: 12 };
    const earlier = { ...noUsage, inputTokens: 400, activeSeconds: 9.25, listCostMinor: 5 };
    await recordUsage(db, conversation.id, later);
    await recordUsage(db, conversation.id, earlier);
    expect(await usageOf(conversation.id)).toMatchObject({ input: 900, active: 30.5, cost: 12 });
  });

  it("writes nothing when the runtime reported nothing", async () => {
    const conversation = await findOrCreateConversation(db, key);
    expect(await recordUsage(db, conversation.id, { ...noUsage, currency: "USD" })).toBe(false);
    expect(await usageOf(conversation.id)).toMatchObject({ currency: null, stamped: false });
  });

  it("leaves the conversation's place in the reconcile order alone", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await db.query(`update conversations set updated_at = '2026-01-01T00:00:00Z'`);
    await recordUsage(db, conversation.id, { ...noUsage, inputTokens: 1 });
    await markAgentEventsSynced(db, conversation.id);
    expect(await db.query(`select updated_at from conversations`)).toEqual([
      { updated_at: new Date("2026-01-01T00:00:00Z") },
    ]);
  });
});

describe("conversationsToBackfill", () => {
  const anyAge = { olderThanSeconds: 0, limit: 10 };

  it("finds conversations with a session whose events were never stored", async () => {
    const stored = await findOrCreateConversation(db, key);
    const never = await findOrCreateConversation(db, { ...key, threadId: "200.000001" });
    const noSession = await findOrCreateConversation(db, { ...key, threadId: "300.000001" });
    const starting = await findOrCreateConversation(db, { ...key, threadId: "400.000001" });
    const busy = await findOrCreateConversation(db, { ...key, threadId: "500.000001" });
    await db.query(`update conversations set agent_session_id = 'sesn_' || thread_id`);
    await db.query(`update conversations set agent_session_id = null where id = $1`, [
      noSession.id,
    ]);
    await db.query(`update conversations set agent_session_id = 'starting:abc' where id = $1`, [
      starting.id,
    ]);
    await db.query(
      `update conversations set sync_lease_until = now() + interval '1 minute' where id = $1`,
      [busy.id],
    );
    await markAgentEventsSynced(db, stored.id);

    expect(await conversationsToBackfill(db, anyAge)).toEqual([
      { id: never.id, sessionId: "sesn_200.000001" },
    ]);

    await markAgentEventsSynced(db, never.id);
    expect(await conversationsToBackfill(db, anyAge)).toEqual([]);
  });

  it("leaves a young conversation to its own first sync", async () => {
    const young = await findOrCreateConversation(db, key);
    const old = await findOrCreateConversation(db, { ...key, threadId: "200.000001" });
    await db.query(`update conversations set agent_session_id = 'sesn_' || thread_id`);
    await db.query(
      `update conversations set created_at = now() - interval '11 minutes' where id = $1`,
      [old.id],
    );

    const found = await conversationsToBackfill(db, { olderThanSeconds: 600, limit: 10 });
    expect(found.map((conversation) => conversation.id)).toEqual([old.id]);
    expect(young.id).not.toBe(old.id);
  });

  it("returns no more than the limit", async () => {
    for (const threadId of ["1.1", "2.2", "3.3"]) {
      await findOrCreateConversation(db, { ...key, threadId });
    }
    await db.query(`update conversations set agent_session_id = 'sesn_' || thread_id`);
    expect(await conversationsToBackfill(db, { olderThanSeconds: 0, limit: 2 })).toHaveLength(2);
  });
});

describe("schema", () => {
  it("keeps Supabase's Data API roles off the event log and the transcript", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const relation of ["agent_events", "conversation_transcript"]) {
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          const rows = await db.query(`select has_table_privilege($1, $2, $3) as allowed`, [
            role,
            `public.${relation}`,
            privilege,
          ]);
          expect(rows, `${role} ${privilege} ${relation}`).toEqual([{ allowed: false }]);
        }
      }
    }
  });

  it("makes the transcript obey the row level security of the tables under it", async () => {
    const rows = await db.query(
      `select reloptions from pg_class where oid = 'public.conversation_transcript'::regclass`,
    );
    expect(rows).toEqual([{ reloptions: ["security_invoker=true"] }]);
  });
});
