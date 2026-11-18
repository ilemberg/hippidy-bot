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
       order by occurred_at, recorded_at`,
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
