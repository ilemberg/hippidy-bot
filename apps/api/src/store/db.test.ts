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
  markForwarded,
  recordInbound,
  unsentDeliveries,
} from "./conversations.ts";
import { createPostgresDb, type Db } from "./db.ts";
import {
  createProject,
  getProject,
  readTurnSender,
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
import { createBrief, unsentBriefs, workerReportsSince } from "./changes.ts";
import { listSessions } from "./sessions.ts";
import { FakeExtractor } from "../agent/extractor.ts";
import { runCapture } from "../api/capture.ts";
import { captureSpentSince } from "./capture.ts";
import { areaHistory, createArea, editArea, nameAreasForChange } from "./areas.ts";
import { actOnProposal, decisionHistory, recordDecision } from "./decisions.ts";
import { createTask, editTask, listBuiltinTasks, taskHistory } from "./tasks.ts";
import { runBriefs } from "../api/briefs.ts";
import { runJobs } from "../api/jobs.ts";
import { editJob, jobHistory, jobWakes, listJobs } from "./jobs.ts";
import { endWait, listWaits, recordWait } from "./waits.ts";
import { conflictDetail, listConflicts, recordConflict, settleConflict } from "./conflicts.ts";
import { recordObservation, setListening } from "./listening.ts";
import { searchDecisions } from "./decisions.ts";
import {
  abandonReview,
  changeOfPullRequest,
  claimReview,
  markReviewFailed,
  markReviewPosted,
  saveWrittenReview,
  settledHeads,
} from "./reviews.ts";
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

  // A JS array bound to `$5::text[]`, and text[] columns read back as arrays (decision 170).
  it("stores and reads a person's extra roles, and copies them onto an approval", async () => {
    const actor = { source: "slack" as const, workspaceId: "T", actorId: "BOTH" };
    const set = await setActorRole(db, {
      ...actor,
      role: "product_manager",
      extraRoles: ["engineering_manager"],
    });
    expect(set.extraRoles).toEqual(["engineering_manager"]);
    expect((await setActorRole(db, { ...actor, role: "product_manager" })).extraRoles).toEqual([]);
    await setActorRole(db, {
      ...actor,
      role: "product_manager",
      extraRoles: ["engineering_manager"],
    });
    const project = await createProject(db, { name: "Both", createdBy: actor });
    const recorded = await recordApproval(db, project.id, {
      subject: "plan",
      subjectRef: "",
      subjectVersion: "1",
      action: "approve",
      actor,
    });
    expect(recorded).toMatchObject({
      kind: "recorded",
      approval: { role: "product_manager", extraRoles: ["engineering_manager"] },
    });
    expect((await getProject(db, project.id))?.approvals[0]?.extraRoles).toEqual([
      "engineering_manager",
    ]);
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

  // The rows a custom tool call already made are read back by a second query (decision 167):
  // the same shape, `seq` as a number, through this client.
  it("returns the same project and approval when a custom tool call is answered again", async () => {
    const createdBy = { source: "slack" as const, workspaceId: "T", actorId: "U1" };
    const project = await createProject(db, { name: "Tool", createdBy }, "sevt_db_1");
    expect(await createProject(db, { name: "Tool", createdBy }, "sevt_db_1")).toEqual(project);
    const request = {
      subject: "plan" as const,
      subjectRef: "",
      subjectVersion: "",
      action: "approve" as const,
      actor: { source: "slack" as const, workspaceId: "T", actorId: "EM" },
    };
    const recorded = await recordApproval(db, project.id, request, "sevt_db_2");
    const again = await recordApproval(db, project.id, request, "sevt_db_2");
    expect(again).toEqual(recorded);
    expect(again.kind === "recorded" ? typeof again.approval.seq : undefined).toBe("number");
  });

  // Two text arrays bound and unnested together, times compared at microsecond precision.
  it("finds whose message a custom tool call's turn answers", async () => {
    const conversation = await findOrCreateConversation(db, {
      source: "slack",
      workspaceId: "T",
      channelId: "C",
      threadId: "turn.1",
    });
    for (const [n, actorId] of [
      [1, "U1"],
      [2, "U2"],
    ] as const) {
      const message = await recordInbound(db, conversation.id, {
        source: "slack",
        sourceEventId: `EvTurn${n}`,
        conversation: { workspaceId: "T", channelId: "C", threadId: "turn.1", messageId: `t${n}` },
        actor: { id: actorId },
        text: "hi",
        sentAt: "2026-11-18T00:00:00.000Z",
      });
      await markForwarded(db, message.id, `sevt_turn_${n}`);
    }
    const messages = [
      { eventId: "sevt_turn_1", processedAt: "2026-11-18T00:00:01.000001Z" },
      { eventId: "sevt_turn_2", processedAt: "2026-11-18T00:00:01.000003Z" },
    ];
    const at = (time: string) => readTurnSender(db, conversation.id, time, messages);
    expect(await at("2026-11-18T00:00:01.000002Z")).toBe("U1");
    expect(await at("2026-11-18T00:00:01.000003Z")).toBe("U2");
    expect(await at("2026-11-18T00:00:01Z")).toBeUndefined();
  });
});

describe("changes and briefs through postgres.js (slice 2.1)", () => {
  it("writes a brief's links as a JSON array and reads them back, and a worker's usage as numbers", async () => {
    const conversation = await findOrCreateConversation(db, {
      source: "slack",
      workspaceId: "T",
      channelId: "C",
      threadId: "brief.1",
    });
    const links = ["SCRUM-12", 'a \u0000 null and "quotes"'];
    const created = await createBrief(db, {
      conversationId: conversation.id,
      customToolUseId: "sevt_brief_pg",
      changeId: undefined,
      requestedBy: { source: "slack", workspaceId: "T", actorId: "U1", name: null },
      brief: { title: "T", what: "W", why: "Y", doneWhen: "D", links },
      startReason: undefined,
      turnEventIds: [],
    });
    expect(created).toMatchObject({ kind: "created", started: true });
    expect(await db.query(`select jsonb_typeof(links) as type from change_briefs`)).toEqual([
      { type: "array" },
    ]);
    const [brief] = await unsentBriefs(db, created.kind === "created" ? created.changeId : "");
    // toJsonText drops what Postgres cannot hold (the null character), and nothing else.
    expect(brief?.links).toEqual(["SCRUM-12", 'a  null and "quotes"']);

    await recordUsage(
      db,
      created.kind === "created" ? created.changeId : "",
      {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        activeSeconds: 1.5,
        listCostMinor: 123,
        budgetMinor: 500,
        currency: "USD",
      },
      "changes",
    );
    expect(
      await db.query(
        `select usage_list_cost_minor::int as cost, usage_active_seconds as seconds from changes`,
      ),
    ).toEqual([{ cost: 123, seconds: 1.5 }]);
    expect(await workerReportsSince(db, conversation.id)).toEqual([]);
  });
});

describe("the sessions list through postgres.js (slice 2.4)", () => {
  it("reads costs as numbers and times as ISO strings", async () => {
    // The thread from the conversation loop test (cost 7) and the change above (cost 123).
    const sessions = await listSessions(db, 50);
    const thread = sessions.find((s) => s.kind === "thread" && s.thread.threadId === "5.5");
    const worker = sessions.find((s) => s.kind === "worker" && s.thread.threadId === "brief.1");
    expect(thread?.cost).toEqual({ spentMinor: 7, budgetMinor: null, currency: "USD" });
    expect(thread?.latestActivity?.text).toBe("before ab \ufffd after");
    expect(worker?.cost).toEqual({ spentMinor: 123, budgetMinor: 500, currency: "USD" });
    expect(worker?.startedAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
  });
});

describe("decisions through postgres.js (slice 2.2)", () => {
  it("returns numbers as numbers and times as ISO strings, and searches by words", async () => {
    const found = await searchDecisions(db, { query: "a person merges, https://x.y/z", limit: 3 });
    expect(found.length).toBeGreaterThan(0);
    expect(typeof found[0]?.number).toBe("number");
    expect(found[0]?.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await searchDecisions(db, { query: "the and of", limit: 3 })).toEqual([]);
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

describe("listening and capture through postgres.js (slice 2.5)", () => {
  it("keeps messages, claims a quiet thread, and writes proposals with their writers and cost", async () => {
    const channel = { source: "slack" as const, workspaceId: "T", channelId: "Clisten" };
    await setListening(db, { ...channel, listening: true, actor: { id: "U1" } });
    const now = new Date();
    for (const [messageId, actor] of [
      ["7.1", "U1"],
      ["7.2", "U2"],
    ] as const) {
      expect(
        await recordObservation(db, {
          kind: "posted",
          ...channel,
          messageId,
          threadId: "7.1",
          actor: { id: actor },
          text: `said ${messageId}`,
          sentAt: new Date(now.getTime() - 45 * 60_000).toISOString(),
        }),
      ).toBe("kept");
    }
    const extractor = new FakeExtractor();
    extractor.answer({
      kind: "ok",
      usage: { inputTokens: 3000, outputTokens: 200 },
      decisions: [
        {
          statement: "Use X.",
          reason: "Because.",
          area: "infra",
          decidedBy: "U2",
          messageId: "7.2",
        },
      ],
    });
    const result = await runCapture(
      { db, extractor, dailyBudgetCents: 100, now: () => now },
      memoryLogger().log,
    );
    expect(result).toMatchObject({ read: 1, proposed: 1 });
    expect(
      await db.query(
        `select confirmable_by, number::float8 > 0 as numbered from decisions
         where origin = 'capture' and channel_id = 'Clisten'`,
      ),
    ).toEqual([{ confirmable_by: ["U1", "U2"], numbered: true }]);
    expect(await captureSpentSince(db, new Date(now.getTime() - 60_000))).toBe(400);
  });
});

describe("decision history through postgres.js (slice 2.6)", () => {
  it("keeps an edit's before and after as JSON objects, with what Postgres cannot hold removed", async () => {
    const [row] = await db.query(
      `insert into decisions (statement, area, status, decided_by_source, decided_by_workspace_id,
         decided_by_actor_id, decided_at, origin, message_id, channel_id, thread_id, confirmable_by)
       values ('Old.', 'x', 'proposed', 'slack', 'T', 'U1', now(), 'capture', '1.1', 'Cwiki',
               '1.0', $1::text[])
       returning id`,
      [["U1"]],
    );
    const id = String(row?.id);
    const outcome = await actOnProposal(
      db,
      id,
      { source: "slack", workspaceId: "T", actorId: "U1", name: null },
      {
        kind: "edit",
        edit: { statement: 'New \u0000 "quoted".', reason: null, wordingVersion: 1 },
      },
    );
    expect(outcome.status).toBe("edited");
    expect(await db.query(`select jsonb_typeof(after) as type from decision_events`)).toEqual([
      { type: "object" },
    ]);
    expect(await decisionHistory(db, id)).toMatchObject([
      {
        before: { statement: "Old.", reason: null, area: "x" },
        after: { statement: 'New  "quoted".', reason: null, area: "x" },
      },
    ]);
  });
});

describe("areas through postgres.js (slice 3.1)", () => {
  it("keeps paths and words as arrays, history as JSON, and names a change's areas once", async () => {
    const who = { source: "slack" as const, workspaceId: "Tareas", actorId: "U1", name: null };
    const made = await createArea(db, who, {
      name: "search",
      paths: ["apps/api/**", 'odd "quoted" \u0000 path'],
      words: ["Full-Text"],
    });
    expect(made).toMatchObject({
      status: "created",
      area: { paths: ["apps/api/**", 'odd "quoted"  path'], words: ["full-text"], version: 1 },
    });
    const id = made.area?.id ?? "";
    const edited = await editArea(db, who, id, { version: 1, words: ["recall"] });
    expect(edited).toMatchObject({ status: "edited", area: { words: ["recall"], version: 2 } });
    expect(
      await db.query(`select jsonb_typeof(after) as type from area_events where area_id = $1`, [
        id,
      ]),
    ).toEqual([{ type: "object" }, { type: "object" }]);
    expect((await areaHistory(db, id)).at(-1)?.before?.words).toEqual(["full-text"]);

    const conversation = await findOrCreateConversation(db, {
      source: "slack",
      workspaceId: "Tareas",
      channelId: "C",
      threadId: "areas.1",
    });
    const created = await createBrief(db, {
      conversationId: conversation.id,
      customToolUseId: "sevt_area_pg",
      changeId: undefined,
      requestedBy: { source: "slack", workspaceId: "Tareas", actorId: "U1", name: null },
      brief: { title: "T", what: "W", why: "Y", doneWhen: "D", links: [] },
      startReason: undefined,
      turnEventIds: [],
    });
    const changeId = created.kind === "created" ? created.changeId : "";
    expect(await nameAreasForChange(db, changeId, [id], "brief")).toEqual([id]);
    expect(await nameAreasForChange(db, changeId, [id], "pull_request")).toEqual([]);
  });
});

describe("conflicts through postgres.js (slice 3.2)", () => {
  it("keeps positions as JSON, decisions and deciders as arrays, and numbers as numbers", async () => {
    const place = { source: "slack" as const, workspaceId: "Tconflicts" };
    const conversation = await findOrCreateConversation(db, {
      ...place,
      channelId: "C",
      threadId: "conflicts.1",
    });
    const recorded = await recordDecision(db, {
      customToolUseId: "sevt_conflict_pg",
      conversationId: conversation.id,
      messageId: null,
      statement: "Search uses full-text.",
      reason: undefined,
      area: "search",
      decidedBy: { ...place, actorId: "U2", name: "Grace" },
      status: "active",
      supersedes: undefined,
    });
    if (recorded.kind === "no_superseded") throw new Error("seed");
    const guarded = await recordDecision(db, {
      customToolUseId: "sevt_conflict_pg_2",
      conversationId: conversation.id,
      messageId: null,
      statement: "Search uses vectors.",
      reason: undefined,
      area: "search",
      decidedBy: { ...place, actorId: "U1", name: "Linus" },
      status: "proposed",
      supersedes: recorded.decision.number,
      guard: {
        deciders: ["UOWNER", "U2"],
        area: "search",
        summary: "Replace it",
        positions: [{ actorId: "U1", name: "Linus", says: 'say "vectors" \u0000 now' }],
      },
    });
    if (guarded.kind === "no_superseded") throw new Error("guard");
    const raised = await recordConflict(db, {
      place,
      kind: "raised",
      summary: "Which?",
      conversationId: conversation.id,
      channelId: null,
      threadId: null,
      area: null,
      decisionIds: [recorded.decision.id],
      proposalId: null,
      positions: [
        { actorId: "U1", name: null, says: "a" },
        { actorId: "U2", name: "Grace", says: "b" },
      ],
      deciders: ["UOWNER"],
      customToolUseId: "sevt_conflict_raised",
    });
    expect(raised).toMatchObject({ created: true });
    expect(typeof raised.number).toBe("number");
    expect(
      await recordConflict(db, {
        place,
        kind: "raised",
        summary: "Which?",
        conversationId: conversation.id,
        channelId: null,
        threadId: null,
        area: null,
        decisionIds: [],
        proposalId: null,
        positions: [],
        deciders: [],
        customToolUseId: "sevt_conflict_raised",
      }),
    ).toEqual({ ...raised, created: false });
    expect(
      await db.query(`select jsonb_typeof(positions) as type from conflicts where id = $1`, [
        raised.id,
      ]),
    ).toEqual([{ type: "array" }]);

    const listed = await listConflicts(db, place, {
      status: "open",
      decision: recorded.decision.number,
      limit: 10,
    });
    expect(listed.map((c) => c.kind).sort()).toEqual(["raised", "replacement"]);
    const replacement = listed.find((c) => c.kind === "replacement");
    expect(replacement).toMatchObject({
      decisions: [{ number: recorded.decision.number, status: "active" }],
      proposal: { number: guarded.decision.number, status: "proposed" },
      positions: [{ actorId: "U1", name: "Linus", says: 'say "vectors"  now' }],
      deciders: [
        { actorId: "UOWNER", name: null },
        { actorId: "U2", name: "Grace" },
      ],
    });
    expect((await conflictDetail(db, place, raised.number, "UOWNER"))?.youMay).toEqual({
      settle: true,
      reason: null,
    });
    const settled = await settleConflict(
      db,
      { ...place, actorId: "UOWNER", name: null },
      raised.id,
      {
        outcome: "dismissed",
      },
    );
    expect(settled).toMatchObject({
      status: "settled",
      conflict: { status: "settled", outcome: "dismissed", note: null },
    });
    expect(typeof settled.conflict?.settledAt).toBe("string");

    // A guarded proposal: only its deciders confirm, and its conflict settles with it.
    const proposalId = guarded.decision.id;
    expect(
      await actOnProposal(
        db,
        proposalId,
        { ...place, actorId: "U1", name: null },
        { kind: "confirm" },
      ),
    ).toMatchObject({ status: "not_allowed", reason: "not_decider" });
    expect(
      await actOnProposal(
        db,
        proposalId,
        { ...place, actorId: "U2", name: "Grace" },
        { kind: "confirm" },
      ),
    ).toMatchObject({ status: "confirmed", replaced: { stillActive: true } });
    const after = await listConflicts(db, place, { status: "all", limit: 10 });
    expect(after.find((c) => c.kind === "replacement")).toMatchObject({
      status: "settled",
      outcome: "changed",
      settledBy: { actorId: "U2", name: "Grace" },
    });
  });
});

describe("tasks and waits through postgres.js (slice 3.3)", () => {
  it("keeps a task's history as JSON, numbers as numbers, and a wait's times as ISO strings", async () => {
    const place = { source: "slack" as const, workspaceId: "Ttasks" };
    const who = { ...place, actorId: "U1", name: "Grace" };
    const created = await createTask(db, who, { title: 'Rank "results" \u0000 well' });
    expect(created.row?.title).toBe('Rank "results"  well');
    expect(typeof created.row?.number).toBe("number");
    const id = created.row?.id ?? "";
    expect(await editTask(db, who, id, { version: 1, status: "done" })).toMatchObject({
      status: "edited",
      row: { status: "done", version: 2 },
    });
    expect((await taskHistory(db, id)).map((e) => e.after.status)).toEqual(["todo", "done"]);
    expect(
      (await listBuiltinTasks(db, place, { q: "rank", status: "all", limit: 5 })).map((t) => t.id),
    ).toEqual([id]);

    const { wait } = await recordWait(db, {
      place,
      waiter: { actorId: "U1", name: "Grace" },
      waitingOn: { actorId: "U2", name: null },
      what: "a review",
      taskKey: "T-1",
      conversationId: null,
      recordedBy: { actorId: "U1", name: "Grace" },
      customToolUseId: "sevt_wait_pg",
    });
    expect(typeof wait.number).toBe("number");
    expect(typeof wait.since).toBe("string");
    expect((await listWaits(db, place, { person: "U2", limit: 5 })).map((w) => w.id)).toEqual([
      wait.id,
    ]);
    const ended = await endWait(db, { ...place, actorId: "U2", name: null }, { id: wait.id });
    expect(ended).toMatchObject({ status: "ended", wait: { status: "ended" } });
    expect(typeof ended.wait?.endedAt).toBe("string");
  });
});

describe("briefs through postgres.js (slice 3.4)", () => {
  it("builds and sends a brief, reading JSON history and dates, once per local day", async () => {
    const place = { source: "slack" as const, workspaceId: "Tbriefs" };
    const who = { ...place, actorId: "U1", name: "Grace" };
    const made = await createArea(db, who, { name: "brief area", ownerActorId: "U2" });
    await editArea(db, who, made.area?.id ?? "", { version: 1, ownerActorId: "U3" });
    await recordWait(db, {
      place,
      waiter: { actorId: "U1", name: "Grace" },
      waitingOn: { actorId: "U3", name: null },
      what: "a review",
      taskKey: null,
      conversationId: null,
      recordedBy: { actorId: "U1", name: "Grace" },
    });
    const sent: string[] = [];
    const deliverer = {
      deliver: () => Promise.resolve(),
      direct: (m: { userId: string }) => {
        sent.push(m.userId);
        return Promise.resolve();
      },
      timeZone: () => Promise.resolve("Europe/London"),
    };
    // Monday 10:30 in London: brief time. Only U3 qualifies (owns the area, is waited on).
    const now = () => new Date("2026-11-23T10:30:00.000Z");
    const log = memoryLogger().log;
    expect(await runBriefs({ db, deliverer, place, webBaseUrl: undefined, now }, log)).toEqual({
      sent: 1,
      empty: 0,
      failed: 0,
    });
    expect((await runBriefs({ db, deliverer, place, webBaseUrl: undefined, now }, log)).sent).toBe(
      0,
    );
    expect(sent).toEqual(["U3"]);
    const rows = await db.query(`select local_date::text as d, status from briefs`);
    expect(rows).toEqual([{ d: "2026-11-23", status: "sent" }]);
  });
});

describe("jobs through postgres.js (slice 4.1)", () => {
  it("makes, takes and logs jobs, with spend as a number and intervals in minutes", async () => {
    const place = { source: "slack" as const, workspaceId: "Tjobs" };
    const log = memoryLogger().log;
    expect(await runJobs({ db, place }, log)).toMatchObject({ woke: 3 });
    expect(await runJobs({ db, place }, log)).toMatchObject({ woke: 0 });
    const jobs = await listJobs(db, place);
    expect(jobs.map((j) => [j.name, typeof j.spentMicrosThisMonth, typeof j.lastWakeAt])).toEqual([
      ["briefs", "number", "string"],
      ["capture", "number", "string"],
      ["checker", "number", "string"],
    ]);
    const capture = jobs.find((j) => j.name === "capture");
    const wakes = await jobWakes(db, capture?.id ?? "");
    expect(wakes).toEqual([expect.objectContaining({ outcome: "silent", costMicros: 0 })]);
    // A person's change, kept as JSON (slice 4.2).
    const edited = await editJob(db, { ...place, actorId: "U1", name: "Ada" }, capture?.id ?? "", {
      version: 1,
      state: "paused",
      goal: 'say "hi" \u0000',
    });
    expect(edited).toMatchObject({ status: "edited", job: { state: "paused", goal: 'say "hi"' } });
    expect((await jobHistory(db, capture?.id ?? ""))[0]?.after).toMatchObject({ state: "paused" });
  });
});

describe("pull request reviews through postgres.js (slice 4.3)", () => {
  it("claims a head once, keeps cost as a number, and finds the change and its brief", async () => {
    const repository = "ilemberg/pg-reviews";
    const conversation = await findOrCreateConversation(db, {
      source: "slack",
      workspaceId: "Treviews",
      channelId: "C",
      threadId: "reviews.1",
    });
    const created = await createBrief(db, {
      conversationId: conversation.id,
      customToolUseId: "sevt_review_pg",
      changeId: undefined,
      requestedBy: { source: "slack", workspaceId: "Treviews", actorId: "U1", name: null },
      brief: { title: "T", what: "W", why: "Y", doneWhen: "D", links: [] },
      startReason: undefined,
      turnEventIds: [],
    });
    const changeId = created.kind === "created" ? created.changeId : "";
    const url = `https://github.com/${repository}/pull/3`;
    await db.query(`update changes set pull_request_url = $2 where id = $1`, [changeId, url]);
    expect(await changeOfPullRequest(db, `${url}/`)).toEqual({
      changeId,
      conversationId: conversation.id,
      brief: { title: "T", what: "W", why: "Y", doneWhen: "D" },
    });

    const head = { repository, number: 3, headSha: "abcdef1", changeId };
    const claim = await claimReview(db, head);
    expect(claim).toEqual({
      id: expect.any(String) as string,
      attempts: 1,
      body: null,
      concerns: null,
    });
    expect(await claimReview(db, head)).toBeUndefined();
    expect([...(await settledHeads(db, [head]))]).toEqual(["3@abcdef1"]);
    await saveWrittenReview(db, claim?.id ?? "", {
      body: "Body \u0000",
      concerns: 2,
      costMicros: 1_234_567_890_123,
    });
    expect(
      await markReviewFailed(db, claim?.id ?? "", { error: "no \u0000 post", costMicros: 7 }),
    ).toBe("failed");
    expect(await claimReview(db, head)).toEqual({
      id: claim?.id,
      attempts: 2,
      body: "Body ",
      concerns: 2,
    });
    await markReviewPosted(db, claim?.id ?? "", `${url}#r`);
    const [row] = await db.query(
      `select status, cost_micros::float8 as cost, concerns, error, review_url
       from pull_request_reviews where id = $1`,
      [claim?.id],
    );
    expect(row).toEqual({
      status: "posted",
      cost: 1_234_567_890_130,
      concerns: 2,
      error: null,
      review_url: `${url}#r`,
    });
    // Given up at once, with its cost (a refusal, a cut-off, a diff too large).
    const other = await claimReview(db, { ...head, headSha: "abcdef2" });
    await abandonReview(db, other?.id ?? "", { error: "too large to review", costMicros: 5 });
    expect(await claimReview(db, { ...head, headSha: "abcdef2" })).toBeUndefined();
    const [abandoned] = await db.query(
      `select status, cost_micros::float8 as cost, error from pull_request_reviews where id = $1`,
      [other?.id],
    );
    expect(abandoned).toEqual({ status: "abandoned", cost: 5, error: "too large to review" });
  });
});
