import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../agent/fake.ts";
import { receiveMessage, syncConversation } from "../api/conversations.ts";
import { RecordingDeliverer } from "../api/testing.ts";
import { memoryLogger } from "../testing.ts";
import {
  enqueueDelivery,
  findConversationBySession,
  findOrCreateConversation,
  unsentDeliveries,
} from "./conversations.ts";
import { createPostgresDb, type Db } from "./db.ts";
import {
  createProject,
  getProject,
  recordApproval,
  setActorRole,
  setProjectStage,
} from "./projects.ts";
import { listConversations, readAgentEvents, readConversation, readTranscript } from "./reading.ts";
import {
  latestActivity,
  latestStoredEventTime,
  recordUsage,
  storeAgentEvents,
  storedEventsToActOn,
} from "./record.ts";
import { applyMigration, applyMigrations } from "./testing.ts";

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
        processedAt: "2026-11-18T00:00:03.000Z",
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

  it("runs the conversation loop, and keeps a reply Postgres cannot store as it is", async () => {
    const runtime = new FakeAgentRuntime();
    const slack = new RecordingDeliverer();
    const { log, lines } = memoryLogger();
    const deps = { db, runtime, deliverers: { slack }, sleep: () => Promise.resolve() };
    await receiveMessage(
      deps,
      {
        source: "slack",
        sourceEventId: "EvLoop",
        conversation: { workspaceId: "T", channelId: "C", threadId: "5.5", messageId: "5.5" },
        actor: { id: "U1" },
        text: "a question",
        sentAt: "2026-11-18T00:00:01.000Z",
      },
      log,
    );
    const sessionId = runtime.onlySessionId();
    // A null character and half a surrogate pair: valid in JavaScript, not in jsonb.
    runtime.reply(sessionId, "before a\u0000b \ud83d after");
    runtime.setUsage(sessionId, { inputTokens: 1200, listCostMinor: 7, currency: "USD" });
    const conversation = await findConversationBySession(db, sessionId);
    if (conversation === undefined) throw new Error("expected a conversation");

    await syncConversation(deps, conversation, log);

    expect(lines.filter((line) => line.level === "error")).toEqual([]);
    expect(slack.replies()).toEqual(["before ab \ufffd after"]);
    expect(slack.statuses()).toEqual([{ messageIds: ["5.5"], status: "answered" }]);
    expect(
      await db.query(
        `select role, text, message_status, delivery_status from conversation_transcript
         where conversation_id = $1 order by occurred_at, recorded_at, position`,
        [conversation.id],
      ),
    ).toEqual([
      { role: "user", text: "a question", message_status: "answered", delivery_status: null },
      {
        role: "agent",
        text: "before ab \ufffd after",
        message_status: null,
        delivery_status: "sent",
      },
    ]);
    expect(
      await db.query(
        `select usage_input_tokens::int as input, usage_list_cost_minor::int as cost
         from conversations where id = $1`,
        [conversation.id],
      ),
    ).toEqual([{ input: 1200, cost: 7 }]);
  });

  // bigint comes back from this client as a string; the reads must still give numbers.
  it("reads the record back with numbers as numbers and times as ISO strings", async () => {
    const key = { source: "slack" as const, workspaceId: "T", channelId: "C", threadId: "6.6" };
    const conversation = await findOrCreateConversation(db, key);
    await db.query(
      `update conversations set agent_session_id = 'sesn_6', agent_id = 'agent_1',
         agent_version = 3 where id = $1`,
      [conversation.id],
    );
    await recordUsage(db, conversation.id, {
      inputTokens: 5_000_000_000,
      outputTokens: 340,
      cacheReadTokens: null,
      cacheCreationTokens: 0,
      activeSeconds: 12.5,
      listCostMinor: 7,
      budgetMinor: 200,
      currency: "USD",
    });
    await storeAgentEvents(db, conversation.id, "sesn_6", [
      {
        id: "evt_1",
        type: "agent.message",
        kind: "agent_message",
        text: "Hello.",
        processedAt: "2026-11-18T00:00:03.123456Z",
        payload: { id: "evt_1", nested: { n: 1 } },
      },
    ]);
    await enqueueDelivery(db, conversation.id, "note:x", "note", {
      kind: "reply",
      target: key,
      text: "A note.",
    });

    const summary = await readConversation(db, conversation.id);
    expect(summary).toMatchObject({
      id: conversation.id,
      agent: { sessionId: "sesn_6", agentId: "agent_1", version: 3 },
      usage: {
        inputTokens: 5_000_000_000,
        outputTokens: 340,
        cacheReadTokens: null,
        cacheCreationTokens: 0,
        activeSeconds: 12.5,
        listCostMinor: 7,
        budgetMinor: 200,
        currency: "USD",
      },
    });
    expect(summary?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect((await listConversations(db, { limit: 100 })).map((c) => c.id)).toContain(
      conversation.id,
    );
    expect(
      (await listConversations(db, { limit: 100, before: conversation.id })).map((c) => c.id),
    ).not.toContain(conversation.id);

    // Paging with ties on the time: every conversation once, in one fixed order.
    await db.query(`update conversations set created_at = '2026-11-18T00:00:00Z'`);
    const all = (await listConversations(db, { limit: 100 })).map((c) => c.id);
    expect(all).toEqual([...all].sort().reverse());
    expect(all.length).toBeGreaterThan(2);
    const paged: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await listConversations(db, { limit: 2, before: cursor });
      if (page.length === 0) break;
      paged.push(...page.map((c) => c.id));
      cursor = page.at(-1)?.id;
    }
    expect(paged).toEqual(all);

    expect(await readTranscript(db, conversation.id)).toMatchObject([
      { role: "agent", text: "Hello.", eventId: "evt_1", at: "2026-11-18T00:00:03.123Z" },
      { role: "note", text: "A note.", delivery: "pending" },
    ]);

    const events = await readAgentEvents(db, conversation.id, { limit: 10 });
    expect(events).toMatchObject([
      {
        id: "evt_1",
        type: "agent.message",
        kind: "agent_message",
        processedAt: "2026-11-18T00:00:03.123Z",
        payload: { id: "evt_1", nested: { n: 1 } },
      },
    ]);
    expect(typeof events[0]?.position).toBe("number");
    expect(
      await readAgentEvents(db, conversation.id, { limit: 10, after: events[0]?.position }),
    ).toEqual([]);
  });

  it("reads back the latest event time and the payloads the loop acts on (decision 95)", async () => {
    const key = { source: "slack" as const, workspaceId: "T", channelId: "C", threadId: "9.9" };
    const conversation = await findOrCreateConversation(db, key);
    await storeAgentEvents(db, conversation.id, "sesn_9", [
      {
        id: "evt_a",
        type: "agent.message",
        kind: "agent_message",
        text: "Hi.",
        processedAt: "2026-11-18T00:00:05.123456Z",
        payload: {
          id: "evt_a",
          type: "agent.message",
          processed_at: "2026-11-18T00:00:05.123456Z",
        },
      },
      {
        id: "evt_b",
        type: "agent.tool_use",
        kind: null,
        text: null,
        processedAt: "2026-11-18T00:00:06Z",
        payload: { id: "evt_b", type: "agent.tool_use" },
      },
    ]);
    const latest = await latestStoredEventTime(db, conversation.id, "sesn_9");
    expect(latest).toBeInstanceOf(Date);
    expect(latest?.toISOString()).toBe("2026-11-18T00:00:06.000Z");
    expect(await storedEventsToActOn(db, conversation.id, "sesn_9")).toEqual([
      { id: "evt_a", type: "agent.message", processed_at: "2026-11-18T00:00:05.123456Z" },
    ]);
  });

  it("reads the latest activity from JSON payloads, after a time (decision 106)", async () => {
    const key = { source: "slack" as const, workspaceId: "T", channelId: "C", threadId: "8.8" };
    const conversation = await findOrCreateConversation(db, key);
    const at = (second: number) => `2026-11-18T01:00:0${String(second)}Z`;
    await storeAgentEvents(db, conversation.id, "sesn_8", [
      {
        id: "m0",
        type: "agent.message",
        kind: "agent_message",
        text: "Too old.",
        processedAt: at(0),
        payload: {},
      },
      {
        id: "m1",
        type: "agent.message",
        kind: "agent_message",
        text: "Testing.",
        processedAt: at(2),
        payload: {},
      },
      {
        id: "t1",
        type: "agent.tool_use",
        kind: null,
        text: null,
        processedAt: at(3),
        payload: { name: "bash", input: { command: "pnpm test" } },
      },
    ]);
    expect(
      await latestActivity(db, conversation.id, "sesn_8", new Date("2026-11-18T01:00:01Z")),
    ).toEqual({ words: "Testing.", step: { name: "bash", command: "pnpm test" } });
    expect(
      await latestActivity(db, conversation.id, "sesn_8", new Date("2026-11-18T01:00:05Z")),
    ).toEqual({ words: undefined, step: undefined });
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

  // Typed parameters (uuid, null) and timestamps, as this client sends and returns them.
  it("records projects, roles and approvals", async () => {
    const project = await createProject(db, {
      name: "Search",
      createdBy: { source: "slack", workspaceId: "T", actorId: "U1" },
    });
    expect(project.createdBy).toEqual({ source: "slack", workspaceId: "T", actorId: "U1" });
    expect((await setProjectStage(db, project.id, "roadmap"))?.stage).toBe("roadmap");
    await setActorRole(db, { source: "slack", workspaceId: "T", actorId: "EM", role: "qa" });
    await setActorRole(db, {
      source: "slack",
      workspaceId: "T",
      actorId: "EM",
      role: "engineering_manager",
    });
    const conversation = await findOrCreateConversation(db, {
      source: "slack",
      workspaceId: "T",
      channelId: "C",
      threadId: "5.5",
    });
    const actor = { source: "slack" as const, workspaceId: "T", actorId: "EM" };
    const base = { subject: "plan" as const, subjectRef: "", subjectVersion: "2", actor };
    const withConversation = await recordApproval(db, project.id, {
      ...base,
      action: "approve",
      conversationId: conversation.id,
    });
    const without = await recordApproval(db, project.id, { ...base, action: "withdraw" });
    expect(withConversation).toMatchObject({
      kind: "recorded",
      approval: { role: "engineering_manager", conversationId: conversation.id },
    });
    expect(without).toMatchObject({ kind: "recorded", approval: { conversationId: null } });
    const found = await getProject(db, project.id);
    expect(found?.approvals.map((a) => a.action)).toEqual(["approve", "withdraw"]);
    expect(found?.project.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // `seq` is a bigint: this client returns it as a string unless the SQL casts it.
  it("returns an approval's seq as a number, in the order recorded", async () => {
    const project = await createProject(db, {
      name: "Search",
      createdBy: { source: "slack", workspaceId: "T", actorId: "U1" },
    });
    const actor = { source: "slack" as const, workspaceId: "T", actorId: "EM" };
    const base = { subject: "plan" as const, subjectRef: "", subjectVersion: "", actor };
    await recordApproval(db, project.id, { ...base, action: "approve" });
    await recordApproval(db, project.id, { ...base, action: "withdraw" });
    const seqs = (await getProject(db, project.id))?.approvals.map((a) => a.seq) ?? [];
    expect(seqs).toHaveLength(2);
    for (const seq of seqs) expect(typeof seq).toBe("number");
    const [first = 0, second = 0] = seqs;
    expect(second).toBeGreaterThan(first);
  });
});

describe("the migration that repairs delivery payloads", () => {
  it("turns payloads stored as JSON strings into objects, whatever they hold", async () => {
    const old = new PGlite();
    try {
      await applyMigrations(old, { before: "20261118000500" });
      await old.exec(
        `insert into conversations (id, source, workspace_id, channel_id, thread_id)
         values ('00000000-0000-0000-0000-000000000001', 'slack', 'T', 'C', '1.1')`,
      );
      const payloads: Record<string, string> = {
        // As the old code stored them: the JSON text of the payload, kept as a JSON string.
        "note:plain": JSON.stringify({ kind: "reply", text: "Stopped." }),
        // A reply whose text had a null character: the escape is not valid inside jsonb.
        evt_nul: JSON.stringify({ kind: "reply", text: "a\u0000b" }),
        // Half a surrogate pair cannot be repaired by the migration: the row is left as it is.
        evt_half: JSON.stringify({ kind: "reply", text: "half \ud83d" }),
      };
      for (const [key, text] of Object.entries(payloads)) {
        await old.query(
          `insert into deliveries (conversation_id, agent_event_id, kind, payload)
           values ('00000000-0000-0000-0000-000000000001', $1, $2, to_jsonb($3::text))`,
          [key, key.startsWith("note") ? "note" : "reply", text],
        );
      }
      // One stored the new way already.
      await old.query(
        `insert into deliveries (conversation_id, agent_event_id, kind, payload)
         values ('00000000-0000-0000-0000-000000000001', 'evt_new', 'reply', $1::text::jsonb)`,
        [JSON.stringify({ kind: "reply", text: "new" })],
      );

      await applyMigration(old, "20261118000500");

      const rows = await old.query<{ key: string; type: string; text: string | null }>(
        `select agent_event_id as key, jsonb_typeof(payload) as type, payload ->> 'text' as text
         from deliveries order by seq`,
      );
      expect(rows.rows).toEqual([
        { key: "note:plain", type: "object", text: "Stopped." },
        { key: "evt_nul", type: "object", text: "ab" },
        { key: "evt_half", type: "string", text: null },
        { key: "evt_new", type: "object", text: "new" },
      ]);
      const transcript = await old.query(
        `select role, text, position from conversation_transcript`,
      );
      expect(transcript.rows).toEqual([{ role: "note", text: "Stopped.", position: 1 }]);
    } finally {
      await old.close();
    }
  });
});
