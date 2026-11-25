import {
  conflictDetailSchema,
  conflictListSchema,
  decisionDetailSchema,
  settleConflictResultSchema,
  type InboundMessage,
  type OutboundDelivery,
} from "@hippidy/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../agent/fake.ts";
import { FakeExtractor } from "../agent/extractor.ts";
import { configureApp } from "../compose.ts";
import type { Env } from "../config.ts";
import { createArea } from "../store/areas.ts";
import { getConversation } from "../store/conversations.ts";
import { actOnProposal, recordDecision } from "../store/decisions.ts";
import { recordObservation, setListening } from "../store/listening.ts";
import { createTestDb } from "../store/testing.ts";
import { memoryLogger } from "../testing.ts";
import { runCapture } from "./capture.ts";
import { MAX_OPEN_CONFLICTS_PER_THREAD } from "./conflicts.ts";
import { receiveMessage, syncConversation, type ConversationDeps } from "./conversations.ts";
import { PERSON_SECRET, PERSON_WORKSPACE, RecordingDeliverer, signPersonToken } from "./testing.ts";
import type { ApiEnv } from "./types.ts";

// Slice 3.2 (decision 208): replacing someone else's decision waits for its deciders, the
// teammate raises disagreements instead of picking a side, and a decider settles them.

let db: Awaited<ReturnType<typeof createTestDb>>;
let runtime: FakeAgentRuntime;
let slack: RecordingDeliverer;
let deps: ConversationDeps;
const { log } = memoryLogger();
const ws = PERSON_WORKSPACE;

beforeEach(async () => {
  db = await createTestDb();
  runtime = new FakeAgentRuntime();
  slack = new RecordingDeliverer();
  deps = {
    db,
    runtime,
    deliverers: { slack },
    sleep: () => Promise.resolve(),
    fallback: { actorId: "UOWNER" },
  };
});

afterEach(async () => {
  await db.close();
});

const person = (actorId: string, name: string | null = null) => ({
  source: "slack" as const,
  workspaceId: ws,
  actorId,
  name,
});

function message(n: number, text: string, actorId = "U1", name = "Linus"): InboundMessage {
  return {
    source: "slack",
    sourceEventId: `Ev${String(n)}`,
    conversation: {
      workspaceId: ws,
      channelId: "C1",
      threadId: "100.1",
      messageId: `100.${String(n)}`,
    },
    actor: { id: actorId, displayName: name },
    text,
    sentAt: `2026-11-25T00:00:0${String(n)}.000Z`,
  };
}

async function thread() {
  const rows = await db.query(`select id from conversations`);
  return getConversation(db, String(rows[0]?.id));
}

function replies(): Extract<OutboundDelivery, { kind: "reply" }>[] {
  return slack.delivered.flatMap((d) => (d.kind === "reply" ? [d] : []));
}

async function teammateCalls(name: string, input: unknown): Promise<string> {
  const teammate = runtime.onlySessionId();
  runtime.work(teammate);
  runtime.callCustomTools(teammate, [{ name, input }]);
  await syncConversation(deps, await thread(), log);
  const answer = runtime.sessions.get(teammate)?.answered.at(-1)?.text ?? "";
  runtime.finish(teammate, "Done.");
  await syncConversation(deps, await thread(), log);
  return answer;
}

let calls = 0;
/** An active decision made by someone, in the thread. */
async function activeBy(actorId: string, name: string, statement: string, area?: string) {
  const conversation = await thread();
  const result = await recordDecision(db, {
    customToolUseId: `seed_${String(++calls)}`,
    conversationId: conversation.id,
    messageId: null,
    statement,
    reason: undefined,
    area,
    decidedBy: person(actorId, name),
    status: "active",
    supersedes: undefined,
  });
  if (result.kind === "no_superseded") throw new Error("seed");
  return result.decision;
}

async function decisionRow(number: number) {
  const [row] = await db.query(`select id, status, deciders from decisions where number = $1`, [
    number,
  ]);
  return row;
}

describe("replacing someone else's decision", () => {
  it("is only proposed, posted with its deciders, and only they may confirm it", async () => {
    await createArea(db, person("UMAKER"), { name: "search", ownerActorId: "UADA" });
    await receiveMessage(deps, message(1, "please record: search moves to a vector index"), log);
    const old = await activeBy("U2", "Grace", "Search uses Postgres full-text search.", "search");

    await teammateCalls("record_decision", {
      statement: "Search uses a vector index.",
      area: "search",
      decidedBy: { actorId: "U1" },
      askedToRecord: true,
      supersedes: old.number,
    });
    const post = slack.delivered.find((d) => d.kind === "decision");
    expect(post).toMatchObject({ needsConfirm: true, mentions: ["UADA", "U2"] });
    const text = post?.kind === "decision" ? post.text : "";
    expect(text).toContain(
      `This would replace decision ${String(old.number)}, which Grace decided.`,
    );
    expect(text).toContain("{@UADA} (owner of **search**)");
    expect(text).toContain(`{@U2} (who made decision ${String(old.number)})`);
    expect(text).toContain("Proposed decision");

    const [proposal] = await db.query(
      `select id, number::int as number, deciders from decisions where supersedes_id = $1`,
      [old.id],
    );
    expect(proposal?.deciders).toEqual(["UADA", "U2"]);
    const id = String(proposal?.id);

    // The asker wrote in the thread, but may not confirm or reword it; they may withdraw it.
    expect(await actOnProposal(db, id, person("U1"), { kind: "confirm" })).toMatchObject({
      status: "not_allowed",
      reason: "not_decider",
    });
    expect(
      await actOnProposal(db, id, person("U1"), {
        kind: "edit",
        edit: { statement: "Something else.", wordingVersion: 1 },
      }),
    ).toMatchObject({ status: "not_allowed", reason: "not_decider" });

    // The owner confirms: the old decision is replaced, and the conflict settled as changed.
    expect(await actOnProposal(db, id, person("UADA", "Ada"), { kind: "confirm" })).toMatchObject({
      status: "confirmed",
      replaced: { number: old.number, stillActive: true },
    });
    expect((await decisionRow(old.number))?.status).toBe("superseded");
    const [conflict] = await db.query(
      `select kind, status, outcome, settled_by_actor_id, deciders from conflicts`,
    );
    expect(conflict).toEqual({
      kind: "replacement",
      status: "settled",
      outcome: "changed",
      settled_by_actor_id: "UADA",
      deciders: ["UADA", "U2"],
    });
  });

  it("lets a thread writer withdraw it, keeping the old decision, and settles as kept", async () => {
    await receiveMessage(deps, message(1, "please record that releases are on Fridays"), log);
    const old = await activeBy("U2", "Grace", "Releases go out on Tuesdays.");
    await teammateCalls("record_decision", {
      statement: "Releases go out on Fridays.",
      decidedBy: { actorId: "U1" },
      askedToRecord: true,
      supersedes: old.number,
    });
    // No area: the fallback decides, with the person who made it.
    const [proposal] = await db.query(
      `select id, deciders from decisions where supersedes_id = $1`,
      [old.id],
    );
    expect(proposal?.deciders).toEqual(["UOWNER", "U2"]);
    expect(
      await actOnProposal(db, String(proposal?.id), person("U1"), {
        kind: "reject",
        wordingVersion: 1,
      }),
    ).toMatchObject({ status: "rejected" });
    expect((await decisionRow(old.number))?.status).toBe("active");
    const [conflict] = await db.query(`select status, outcome from conflicts`);
    expect(conflict).toEqual({ status: "settled", outcome: "kept" });

    // Someone who never wrote in the thread may not withdraw one.
    await receiveMessage(deps, message(2, "please record that releases are on Mondays"), log);
    await teammateCalls("record_decision", {
      statement: "Releases go out on Mondays.",
      decidedBy: { actorId: "U1" },
      askedToRecord: true,
      supersedes: old.number,
    });
    const [second] = await db.query(
      `select id from decisions where supersedes_id = $1 and status = 'proposed'`,
      [old.id],
    );
    expect(
      await actOnProposal(db, String(second?.id), person("USTRANGER"), {
        kind: "reject",
        wordingVersion: 1,
      }),
    ).toMatchObject({ status: "not_allowed", reason: "not_decider" });
  });

  it("follows the rules of 2.2 when you replace your own decision", async () => {
    await receiveMessage(deps, message(1, "please record that we ship on Fridays now"), log);
    const old = await activeBy("U1", "Linus", "We ship on Tuesdays.");
    await teammateCalls("record_decision", {
      statement: "We ship on Fridays.",
      decidedBy: { actorId: "U1" },
      askedToRecord: true,
      supersedes: old.number,
    });
    expect((await decisionRow(old.number))?.status).toBe("superseded");
    expect(await db.query(`select 1 from conflicts`)).toHaveLength(0);
    expect(slack.delivered.find((d) => d.kind === "decision")).toMatchObject({
      needsConfirm: false,
    });
  });

  it("says nobody is set to decide when the area has no owner and there is no fallback", async () => {
    deps = { ...deps, fallback: undefined };
    await receiveMessage(deps, message(1, "please record: imports change"), log);
    // An imported decision names no one, so only an owner or the fallback could decide.
    const [imported] = await db.query(
      `select number::int as number from decisions where origin = 'import' and status = 'active'
       order by number limit 1`,
    );
    await teammateCalls("record_decision", {
      statement: "Something new.",
      decidedBy: { actorId: "U1" },
      askedToRecord: true,
      supersedes: Number(imported?.number),
    });
    const post = slack.delivered.find((d) => d.kind === "decision");
    expect(post?.kind === "decision" ? post.text : "").toContain("Nobody is set to decide it");
    const [proposal] = await db.query(`select deciders from decisions where origin = 'thread'`);
    expect(proposal?.deciders).toEqual([]);
  });
});

describe("raise_conflict", () => {
  it("posts a conflict once, with its positions and deciders, and checks who and what", async () => {
    await createArea(db, person("UMAKER"), { name: "search", ownerActorId: "UADA" });
    await receiveMessage(deps, message(1, "I want vectors"), log);
    await receiveMessage(deps, message(2, "No, full-text", "U2", "Grace"), log);
    const old = await activeBy("U2", "Grace", "Search uses Postgres full-text search.", "search");

    const answer = await teammateCalls("raise_conflict", {
      summary: "Linus wants a vector index; Grace wants to keep full-text search.",
      decisions: [old.number],
      positions: [
        { actorId: "U1", says: "Move search to a vector index." },
        { actorId: "U2", says: "Keep full-text search." },
      ],
    });
    expect(answer).toContain('"deciders":["UADA"]');
    const posted = replies().filter((r) => r.text.startsWith("**Conflict"));
    expect(posted).toHaveLength(1);
    expect(posted[0]?.mentions).toEqual(["UADA"]);
    expect(posted[0]?.text).toContain("- Linus: Move search to a vector index.");
    expect(posted[0]?.text).toContain("- Grace: Keep full-text search.");
    expect(posted[0]?.text).toContain("{@UADA} (owner of **search**)");
    expect(posted[0]?.text).toContain(`Until then, decision ${String(old.number)} stands.`);
    const [row] = await db.query(`select kind, area, status from conflicts`);
    expect(row).toEqual({ kind: "raised", area: "search", status: "open" });

    // Someone who is not in the thread, an inactive decision, and an unknown area are refused.
    const stranger = await teammateCalls("raise_conflict", {
      summary: "x",
      positions: [
        { actorId: "U1", says: "a" },
        { actorId: "USTRANGER", says: "b" },
      ],
    });
    expect(stranger).toContain("has not written in this thread");
    const inactive = await teammateCalls("raise_conflict", { summary: "x", decisions: [999999] });
    expect(inactive).toContain("is not active");
    const noArea = await teammateCalls("raise_conflict", {
      summary: "x",
      decisions: [old.number],
      area: "nowhere",
    });
    expect(noArea).toContain('no area named "nowhere"');
    expect(await db.query(`select 1 from conflicts`)).toHaveLength(1);
  });

  it(`allows at most ${String(MAX_OPEN_CONFLICTS_PER_THREAD)} open conflicts in a thread`, async () => {
    await receiveMessage(deps, message(1, "a"), log);
    await receiveMessage(deps, message(2, "b", "U2", "Grace"), log);
    const positions = [
      { actorId: "U1", says: "this" },
      { actorId: "U2", says: "that" },
    ];
    for (let i = 0; i < MAX_OPEN_CONFLICTS_PER_THREAD; i++) {
      await teammateCalls("raise_conflict", { summary: `conflict ${String(i)}`, positions });
    }
    const refused = await teammateCalls("raise_conflict", { summary: "one more", positions });
    expect(refused).toContain("already has 3 open conflicts");
    // Nobody owns anything: the fallback decides.
    const [row] = await db.query(`select deciders from conflicts limit 1`);
    expect(row?.deciders).toEqual(["UOWNER"]);
  });
});

const serviceToken = "t".repeat(48);
const env: Env = {
  API_SERVICE_TOKEN: serviceToken,
  WEB_API_SECRET: PERSON_SECRET,
  SLACK_WORKSPACE_ID: PERSON_WORKSPACE,
};

function app() {
  return configureApp(new Hono<ApiEnv>(), {
    env,
    log: memoryLogger().log,
    services: {
      conversations: deps,
      status: { db, configured: { agent: true, slack: true, github: true } },
    },
  });
}

async function as(actorId: string) {
  return {
    authorization: `Bearer ${await signPersonToken({ subject: actorId, name: "Someone" })}`,
    "content-type": "application/json",
  };
}

describe("the conflicts routes", () => {
  it("lists, reads and lets a decider settle a conflict, noting it in the thread", async () => {
    await receiveMessage(deps, message(1, "a"), log);
    await receiveMessage(deps, message(2, "b", "U2", "Grace"), log);
    const old = await activeBy("U2", "Grace", "Search uses Postgres full-text search.");
    await teammateCalls("raise_conflict", {
      summary: "Vectors or full-text?",
      decisions: [old.number],
      positions: [
        { actorId: "U1", says: "vectors" },
        { actorId: "U2", says: "full-text" },
      ],
    });
    const api = app();
    const list = conflictListSchema.parse(
      await (await api.request("/v1/conflicts", { headers: await as("U1") })).json(),
    );
    expect(list.conflicts.map((c) => [c.summary, c.status, c.decisions[0]?.number])).toEqual([
      ["Vectors or full-text?", "open", old.number],
    ]);
    const byDecision = conflictListSchema.parse(
      await (
        await api.request(`/v1/conflicts?decision=${String(old.number)}`, {
          headers: { authorization: `Bearer ${serviceToken}` },
        })
      ).json(),
    );
    expect(byDecision.conflicts).toHaveLength(1);
    const number = list.conflicts[0]?.number ?? 0;
    const id = list.conflicts[0]?.id ?? "";

    // Not a decider: may read, not settle.
    const asLinus = conflictDetailSchema.parse(
      await (
        await api.request(`/v1/conflicts/${String(number)}`, { headers: await as("U1") })
      ).json(),
    );
    expect(asLinus.youMay).toEqual({ settle: false, reason: "not_decider" });
    const refused = await api.request(`/v1/conflicts/${id}/settle`, {
      method: "POST",
      headers: await as("U1"),
      body: JSON.stringify({ outcome: "changed" }),
    });
    expect(settleConflictResultSchema.parse(await refused.json())).toMatchObject({
      status: "not_allowed",
      reason: "not_decider",
    });
    // The service token never settles one.
    const service = await api.request(`/v1/conflicts/${id}/settle`, {
      method: "POST",
      headers: { authorization: `Bearer ${serviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ outcome: "kept" }),
    });
    expect(service.status).toBe(400);

    const asOwner = conflictDetailSchema.parse(
      await (
        await api.request(`/v1/conflicts/${String(number)}`, { headers: await as("UOWNER") })
      ).json(),
    );
    expect(asOwner.youMay).toEqual({ settle: true, reason: null });
    const settled = await api.request(`/v1/conflicts/${id}/settle`, {
      method: "POST",
      headers: await as("UOWNER"),
      body: JSON.stringify({ outcome: "kept", note: "Full-text stays for now." }),
    });
    expect(settleConflictResultSchema.parse(await settled.json())).toMatchObject({
      status: "settled",
      conflict: { status: "settled", outcome: "kept", note: "Full-text stays for now." },
    });
    await syncConversation(deps, await thread(), log);
    expect(replies().at(-1)?.text).toBe(
      'Conflict 1 settled by Someone: things stay as they are. "Full-text stays for now."',
    );
    const again = await api.request(`/v1/conflicts/${id}/settle`, {
      method: "POST",
      headers: await as("UOWNER"),
      body: JSON.stringify({ outcome: "changed" }),
    });
    expect(settleConflictResultSchema.parse(await again.json())).toMatchObject({
      status: "not_allowed",
      reason: "settled",
    });
    const open = conflictListSchema.parse(
      await (await api.request("/v1/conflicts", { headers: await as("U1") })).json(),
    );
    expect(open.conflicts).toHaveLength(0);
  });

  it("sends a guarded proposal's conflict to its proposal, and offers a writer only withdrawal", async () => {
    await receiveMessage(deps, message(1, "please record: releases on Fridays"), log);
    const old = await activeBy("U2", "Grace", "Releases go out on Tuesdays.");
    await teammateCalls("record_decision", {
      statement: "Releases go out on Fridays.",
      decidedBy: { actorId: "U1" },
      askedToRecord: true,
      supersedes: old.number,
    });
    const api = app();
    const [row] = await db.query(`select number::int as number from conflicts`);
    const detail = conflictDetailSchema.parse(
      await (
        await api.request(`/v1/conflicts/${String(row?.number)}`, { headers: await as("UOWNER") })
      ).json(),
    );
    expect(detail.youMay).toEqual({ settle: false, reason: "has_proposal" });
    expect(detail.conflict.proposal?.statement).toBe("Releases go out on Fridays.");
    const [proposal] = await db.query(
      `select number::int as number from decisions where supersedes_id = $1`,
      [old.id],
    );
    const decision = decisionDetailSchema.parse(
      await (
        await api.request(`/v1/decisions/${String(proposal?.number)}`, { headers: await as("U1") })
      ).json(),
    );
    expect(decision.youMay).toEqual({ act: false, reason: "not_decider", withdraw: true });
  });
});

describe("capture", () => {
  it("guards a captured proposal that replaces someone else's decision, posting nothing", async () => {
    const extractor = new FakeExtractor();
    const now = new Date("2026-11-25T12:00:00.000Z");
    const channel = { source: "slack" as const, workspaceId: ws, channelId: "C9" };
    await setListening(db, { ...channel, listening: true, actor: { id: "U1" } });
    await receiveMessage(deps, message(1, "hello"), log);
    const old = await activeBy("U2", "Grace", "Search uses Postgres full-text search ranking.");
    for (const [messageId, actor, text] of [
      ["200.1", "U3", "Should search ranking stay on Postgres full-text?"],
      ["200.2", "U4", "No: we move search ranking to a vector index. Agreed."],
    ] as const) {
      await recordObservation(db, {
        kind: "posted",
        ...channel,
        messageId,
        threadId: "200.1",
        actor: { id: actor, displayName: actor },
        text,
        sentAt: new Date(now.getTime() - 40 * 60_000).toISOString(),
      });
    }
    extractor.answer({
      kind: "ok",
      usage: { inputTokens: 100, outputTokens: 10 },
      decisions: [
        {
          statement: "Search ranking moves to a vector index.",
          reason: null,
          area: null,
          decidedBy: "U4",
          messageId: "200.2",
          replaces: old.number,
        },
      ],
    });
    const delivered = slack.delivered.length;
    await runCapture(
      { db, extractor, dailyBudgetCents: 100, now: () => now, fallback: { actorId: "UOWNER" } },
      log,
    );
    expect(extractor.calls[0]?.active?.map((d) => d.number)).toContain(old.number);
    const [proposal] = await db.query(
      `select id, supersedes_id, deciders from decisions where origin = 'capture'`,
    );
    expect(proposal).toMatchObject({ supersedes_id: old.id, deciders: ["UOWNER", "U2"] });
    const [conflict] = await db.query(
      `select kind, channel_id, thread_id, proposal_id, status from conflicts`,
    );
    expect(conflict).toEqual({
      kind: "capture",
      channel_id: "C9",
      thread_id: "200.1",
      proposal_id: proposal?.id,
      status: "open",
    });
    expect(slack.delivered.length).toBe(delivered);
  });

  it("ignores a decision number the model was not shown", async () => {
    const extractor = new FakeExtractor();
    const now = new Date("2026-11-25T12:00:00.000Z");
    const channel = { source: "slack" as const, workspaceId: ws, channelId: "C9" };
    await setListening(db, { ...channel, listening: true, actor: { id: "U1" } });
    for (const [messageId, actor] of [
      ["200.1", "U3"],
      ["200.2", "U4"],
    ] as const) {
      await recordObservation(db, {
        kind: "posted",
        ...channel,
        messageId,
        threadId: "200.1",
        actor: { id: actor, displayName: actor },
        text: "we agreed on tea",
        sentAt: new Date(now.getTime() - 40 * 60_000).toISOString(),
      });
    }
    extractor.answer({
      kind: "ok",
      usage: { inputTokens: 100, outputTokens: 10 },
      decisions: [
        {
          statement: "Tea, not coffee.",
          reason: null,
          area: null,
          decidedBy: "U4",
          messageId: "200.2",
          replaces: 1,
        },
      ],
    });
    await runCapture({ db, extractor, dailyBudgetCents: 100, now: () => now }, log);
    const [proposal] = await db.query(
      `select supersedes_id, deciders from decisions where origin = 'capture'`,
    );
    expect(proposal).toEqual({ supersedes_id: null, deciders: null });
    expect(await db.query(`select 1 from conflicts`)).toHaveLength(0);
  });
});
