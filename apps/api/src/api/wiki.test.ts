import { decisionActionResultSchema, decisionDetailSchema } from "@hippidy/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../agent/fake.ts";
import { configureApp } from "../compose.ts";
import type { Env } from "../config.ts";
import { findOrCreateConversation, recordInbound } from "../store/conversations.ts";
import { actOnProposal, decisionHistory, findDecisionByNumber } from "../store/decisions.ts";
import { createTestDb } from "../store/testing.ts";
import { memoryLogger } from "../testing.ts";
import type { ConversationDeps } from "./conversations.ts";
import { PERSON_SECRET, PERSON_WORKSPACE, RecordingDeliverer, signPersonToken } from "./testing.ts";
import type { ApiEnv } from "./types.ts";

// Slice 2.6: who may confirm, reject or reword a proposal, and the history kept (decisions
// 201 and 202).

let db: Awaited<ReturnType<typeof createTestDb>>;
let slack: RecordingDeliverer;
let deps: ConversationDeps;

beforeEach(async () => {
  db = await createTestDb();
  slack = new RecordingDeliverer();
  deps = {
    db,
    runtime: new FakeAgentRuntime(),
    deliverers: { slack },
    sleep: () => Promise.resolve(),
  };
});

afterEach(async () => {
  await db.close();
});

const ws = PERSON_WORKSPACE;
const person = (actorId: string, name: string | null = null) => ({
  source: "slack" as const,
  workspaceId: ws,
  actorId,
  name,
});

/** A proposal from listening, confirmable by the thread's writers. */
async function captured(writers: string[]): Promise<{ id: string; number: number }> {
  const [row] = await db.query(
    `insert into decisions (statement, reason, area, status, decided_by_source,
       decided_by_workspace_id, decided_by_actor_id, decided_by_name, decided_at, origin,
       message_id, channel_id, thread_id, confirmable_by)
     values ('We use Postgres.', null, 'search', 'proposed', 'slack', $1, 'U1', 'Ada', now(),
             'capture', '100.2', 'C1', '100.1', $2::text[])
     returning id, number::float8 as number`,
    [ws, writers],
  );
  return { id: String(row?.id), number: Number(row?.number) };
}

/** A proposal the teammate recorded in a thread where U1 wrote to the bot. */
async function fromThread(): Promise<{ id: string; number: number; conversationId: string }> {
  const conversation = await findOrCreateConversation(db, {
    source: "slack",
    workspaceId: ws,
    channelId: "C1",
    threadId: "200.1",
  });
  await recordInbound(db, conversation.id, {
    source: "slack",
    sourceEventId: "Ev1",
    conversation: { workspaceId: ws, channelId: "C1", threadId: "200.1", messageId: "200.1" },
    actor: { id: "U1", displayName: "Ada" },
    text: "record that",
    sentAt: new Date().toISOString(),
  });
  const [row] = await db.query(
    `insert into decisions (statement, status, decided_by_source, decided_by_workspace_id,
       decided_by_actor_id, decided_at, origin, conversation_id, message_id)
     values ('Ship on Tuesdays.', 'proposed', 'slack', $1, 'U1', now(), 'thread', $2, '200.1')
     returning id, number::float8 as number`,
    [ws, conversation.id],
  );
  return { id: String(row?.id), number: Number(row?.number), conversationId: conversation.id };
}

describe("actOnProposal", () => {
  it("lets someone who wrote in the thread reword, then reject, a proposal from listening", async () => {
    const { id } = await captured(["U1", "U2"]);
    expect(await actOnProposal(db, id, person("U9"), { kind: "confirm" })).toMatchObject({
      status: "not_allowed",
      reason: "not_in_thread",
    });
    expect(
      await actOnProposal(db, id, person("U2", "Grace"), {
        kind: "edit",
        edit: {
          statement: "We use Postgres full-text search.",
          reason: "Small corpus.",
          area: null,
        },
      }),
    ).toMatchObject({ status: "edited", decision: { status: "proposed", area: null } });
    expect(await actOnProposal(db, id, person("U1", "Ada"), { kind: "reject" })).toMatchObject({
      status: "rejected",
      decision: { status: "rejected", rejectedBy: { actorId: "U1", name: "Ada" } },
    });
    expect(await actOnProposal(db, id, person("U2"), { kind: "confirm" })).toMatchObject({
      status: "not_proposed",
    });
    expect(await decisionHistory(db, id)).toMatchObject([
      {
        kind: "edited",
        actor: { actorId: "U2", name: "Grace" },
        before: { statement: "We use Postgres.", reason: null, area: "search" },
        after: {
          statement: "We use Postgres full-text search.",
          reason: "Small corpus.",
          area: null,
        },
      },
      { kind: "rejected", actor: { actorId: "U1" }, before: null, after: null },
    ]);
    // Nothing is posted for a proposal from listening (176).
    expect(slack.replies()).toEqual([]);
  });

  it("does not let an imported decision be changed, and hides one of another workspace", async () => {
    const imported = await findDecisionByNumber(db, 173);
    expect(
      await actOnProposal(db, imported?.id ?? "", person("U1"), { kind: "confirm" }),
    ).toMatchObject({ status: "not_proposed" });
    const { id } = await captured(["U1"]);
    expect(
      await actOnProposal(db, id, { ...person("U1"), workspaceId: "T9" }, { kind: "reject" }),
    ).toEqual({ status: "not_found" });
  });

  it("confirms a thread's proposal for someone who wrote to the bot there, and records it", async () => {
    const { id } = await fromThread();
    expect((await actOnProposal(db, id, person("U2"), { kind: "confirm" })).status).toBe(
      "not_allowed",
    );
    expect(await actOnProposal(db, id, person("U1", "Ada"), { kind: "confirm" })).toMatchObject({
      status: "confirmed",
      decision: { status: "active", confirmedBy: { actorId: "U1" } },
    });
    expect((await decisionHistory(db, id)).map((e) => e.kind)).toEqual(["confirmed"]);
  });
});

const serviceToken = "t".repeat(48);
const env: Env = {
  API_SERVICE_TOKEN: serviceToken,
  WEB_API_SECRET: PERSON_SECRET,
  SLACK_WORKSPACE_ID: PERSON_WORKSPACE,
};

function app() {
  const { log } = memoryLogger();
  return configureApp(new Hono<ApiEnv>(), {
    env,
    log,
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

describe("the wiki's routes", () => {
  it("shows a decision with its history and whether the person may act", async () => {
    const { number } = await captured(["U1"]);
    const read = async (actorId: string) =>
      decisionDetailSchema.parse(
        await (
          await app().request(`/v1/decisions/${String(number)}`, { headers: await as(actorId) })
        ).json(),
      );
    expect((await read("U1")).youMay).toEqual({ act: true, reason: null });
    expect((await read("U9")).youMay).toEqual({ act: false, reason: "not_in_thread" });
    const imported = decisionDetailSchema.parse(
      await (await app().request("/v1/decisions/173", { headers: await as("U1") })).json(),
    );
    expect(imported.youMay).toEqual({ act: false, reason: "read_only" });
    expect((await app().request("/v1/decisions/999999", { headers: await as("U1") })).status).toBe(
      404,
    );
  });

  it("lets a person reword, confirm and reject as themselves, never as someone else", async () => {
    const { id } = await captured(["U1"]);
    const patch = await app().request(`/v1/decisions/${id}`, {
      method: "PATCH",
      headers: await as("U1"),
      body: JSON.stringify({ statement: "Postgres it is." }),
    });
    expect(decisionActionResultSchema.parse(await patch.json())).toEqual({ status: "edited" });

    // A body naming someone else is refused: who acts is the token.
    const forged = await app().request(`/v1/decisions/${id}/confirm`, {
      method: "POST",
      headers: await as("U9"),
      body: JSON.stringify({ source: "slack", workspaceId: ws, actor: { id: "U1" } }),
    });
    expect(forged.status).toBe(400);

    const refused = await app().request(`/v1/decisions/${id}/confirm`, {
      method: "POST",
      headers: await as("U9"),
      body: "{}",
    });
    expect(await refused.json()).toEqual({ status: "not_allowed", reason: "not_in_thread" });
    const confirmed = await app().request(`/v1/decisions/${id}/confirm`, {
      method: "POST",
      headers: await as("U1"),
      body: "{}",
    });
    expect(confirmed.status).toBe(202);
    expect(await confirmed.json()).toEqual({ status: "confirmed" });
  });

  it("notes a rejection in the thread of a teammate's proposal", async () => {
    const { id, number } = await fromThread();
    const res = await app().request(`/v1/decisions/${id}/reject`, {
      method: "POST",
      headers: await as("U1"),
      body: "{}",
    });
    expect(await res.json()).toEqual({ status: "rejected" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(slack.replies()).toContain(
      `Decision ${String(number)} rejected by Someone. It is not on record.`,
    );
  });

  it("does not let the service token edit, and still lets Slack confirm for a writer", async () => {
    const { id } = await fromThread();
    const service = { authorization: `Bearer ${serviceToken}`, "content-type": "application/json" };
    const patch = await app().request(`/v1/decisions/${id}`, {
      method: "PATCH",
      headers: service,
      body: JSON.stringify({ statement: "x" }),
    });
    expect(patch.status).toBe(400);
    const confirm = await app().request(`/v1/decisions/${id}/confirm`, {
      method: "POST",
      headers: service,
      body: JSON.stringify({ source: "slack", workspaceId: ws, actor: { id: "U1" } }),
    });
    expect(await confirm.json()).toEqual({ status: "confirmed" });
  });
});
