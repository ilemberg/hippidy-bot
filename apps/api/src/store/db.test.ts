import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enqueueDelivery, findOrCreateConversation, unsentDeliveries } from "./conversations.ts";
import { createPostgresDb, type Db } from "./db.ts";
import { recordUsage, storeAgentEvents } from "./record.ts";
import { applyMigrations } from "./testing.ts";

// The production client (postgres.js) over a real Postgres connection, served by PGlite.
let pg: PGlite;
let server: PGLiteSocketServer;
let db: Db;

beforeAll(async () => {
  pg = new PGlite();
  await applyMigrations(pg);
  server = new PGLiteSocketServer({ db: pg, port: 0, host: "127.0.0.1" });
  await server.start();
  db = createPostgresDb(`postgres://postgres@${server.getServerConn()}/postgres`);
  // Note: PGlite is single-threaded, so these tests check correctness, not concurrency.
});

afterAll(async () => {
  await server.stop();
  await pg.close();
});

describe("createPostgresDb", () => {
  it("runs parameterized queries", async () => {
    expect(await db.query("select $1::int + $2::int as sum", [2, 3])).toEqual([{ sum: 5 }]);
  });

  it("works with the store", async () => {
    const key = { source: "slack" as const, workspaceId: "T", channelId: "C", threadId: "1.1" };
    const conversation = await findOrCreateConversation(db, key);
    expect(conversation.key).toEqual(key);
    expect(conversation.waitingSince).toBeNull();
  });

  // This client sends a string bound to a jsonb parameter as a JSON string, not as the JSON
  // it holds. PGlite on its own does not, so these run through the real client.
  it("stores a delivery's payload as an object, and the transcript shows a note's text", async () => {
    const key = { source: "slack" as const, workspaceId: "T", channelId: "C", threadId: "2.2" };
    const conversation = await findOrCreateConversation(db, key);
    const note = { kind: "reply" as const, target: key, text: "Stopped." };
    await enqueueDelivery(db, conversation.id, "note:stop", "note", note);

    expect(await db.query(`select jsonb_typeof(payload) as type from deliveries`)).toEqual([
      { type: "object" },
    ]);
    expect((await unsentDeliveries(db, conversation.id)).map((d) => d.payload)).toEqual([note]);
    expect(
      await db.query(`select role, text from conversation_transcript where conversation_id = $1`, [
        conversation.id,
      ]),
    ).toEqual([{ role: "note", text: "Stopped." }]);
  });

  it("still reads, and shows, a payload stored the old way as a JSON string", async () => {
    const key = { source: "slack" as const, workspaceId: "T", channelId: "C", threadId: "3.3" };
    const conversation = await findOrCreateConversation(db, key);
    const note = { kind: "reply" as const, target: key, text: "An old note." };
    await db.query(
      `insert into deliveries (conversation_id, agent_event_id, kind, payload)
       values ($1, 'note:old', 'note', to_jsonb($2::text))`,
      [conversation.id, JSON.stringify(note)],
    );
    expect(
      await db.query(
        `select jsonb_typeof(payload) as type from deliveries where conversation_id = $1`,
        [conversation.id],
      ),
    ).toEqual([{ type: "string" }]);

    expect((await unsentDeliveries(db, conversation.id)).map((d) => d.payload)).toEqual([note]);
    expect(
      await db.query(`select text from conversation_transcript where conversation_id = $1`, [
        conversation.id,
      ]),
    ).toEqual([{ text: "An old note." }]);
  });

  it("stores agent events and usage", async () => {
    const key = { source: "slack" as const, workspaceId: "T", channelId: "C", threadId: "4.4" };
    const conversation = await findOrCreateConversation(db, key);
    const events = [
      {
        id: "evt_1",
        type: "agent.message",
        kind: "agent_message",
        text: "Hello.",
        processedAt: new Date("2026-11-18T00:00:03.000Z"),
        payload: { id: "evt_1", content: [{ type: "text", text: "Hello." }] },
      },
      {
        id: "evt_2",
        type: "user.message",
        kind: "user_message",
        text: null,
        processedAt: null,
        payload: { id: "evt_2" },
      },
    ];
    expect(await storeAgentEvents(db, conversation.id, "sesn_1", events)).toBe(2);
    expect(await storeAgentEvents(db, conversation.id, "sesn_1", events)).toBe(0);
    expect(
      await db.query(
        `select event_id, text, processed_at, payload, jsonb_typeof(payload) as type
         from agent_events order by seq`,
      ),
    ).toEqual([
      {
        event_id: "evt_1",
        text: "Hello.",
        processed_at: new Date("2026-11-18T00:00:03.000Z"),
        payload: { id: "evt_1", content: [{ type: "text", text: "Hello." }] },
        type: "object",
      },
      {
        event_id: "evt_2",
        text: null,
        processed_at: null,
        payload: { id: "evt_2" },
        type: "object",
      },
    ]);

    await recordUsage(db, conversation.id, {
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: null,
      cacheCreationTokens: 0,
      activeSeconds: 12.5,
      listCostMinor: 7,
      budgetMinor: 200,
      currency: "USD",
    });
    expect(
      await db.query(
        `select usage_input_tokens::int as input, usage_cache_read_tokens as cache_read,
                usage_cache_creation_tokens::int as cache_creation,
                usage_active_seconds as active, usage_list_cost_minor::int as cost,
                budget_list_cost_minor::int as budget, cost_currency as currency
         from conversations where id = $1`,
        [conversation.id],
      ),
    ).toEqual([
      {
        input: 1200,
        cache_read: null,
        cache_creation: 0,
        active: 12.5,
        cost: 7,
        budget: 200,
        currency: "USD",
      },
    ]);
  });

  it("commits a transaction, and rolls back when the work throws", async () => {
    await db.transaction((tx) => tx.query("create table t (n int)"));
    await db.transaction((tx) => tx.query("insert into t values (1)"));
    await expect(
      db.transaction(async (tx) => {
        await tx.query("insert into t values (2)");
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await db.query("select n from t")).toEqual([{ n: 1 }]);
  });
});
