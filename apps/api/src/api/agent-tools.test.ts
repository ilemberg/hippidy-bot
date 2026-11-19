import type { InboundMessage } from "@hippidy/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../agent/fake.ts";
import { getConversation } from "../store/conversations.ts";
import {
  createProject,
  listApprovals,
  listProjects,
  setActorRole,
  setConversationProject,
} from "../store/projects.ts";
import { createTestDb } from "../store/testing.ts";
import { memoryLogger } from "../testing.ts";
import { toolErrors } from "./agent-tools.ts";
import { receiveMessage, syncConversation, type ConversationDeps } from "./conversations.ts";
import { RecordingDeliverer } from "./testing.ts";

// The conversation loop answering custom tool calls (slice 5A, part E2; decision 167), with
// the fake runtime playing the agent.

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

function message(n: number, actorId = "U1"): InboundMessage {
  return {
    source: "slack",
    sourceEventId: `Ev${n}`,
    conversation: {
      workspaceId: "T1",
      channelId: "C1",
      threadId: "100.000001",
      messageId: `100.00000${n}`,
    },
    actor: { id: actorId },
    text: `question ${n}`,
    sentAt: `2026-11-18T00:00:0${n}.000Z`,
  };
}

async function conversationId(): Promise<string> {
  const rows = await db.query(`select id from conversations`);
  expect(rows).toHaveLength(1);
  return String(rows[0]?.id);
}

async function projectIdOfThread(): Promise<string | null> {
  const rows = await db.query(`select project_id from conversations`);
  return (rows[0]?.project_id as string | null | undefined) ?? null;
}

async function sync(): Promise<void> {
  await syncConversation(deps, await getConversation(db, await conversationId()), log);
}

/** A thread with one message handed to the agent, whose turn is running. */
async function threadInTurn(actorId = "U1"): Promise<string> {
  await receiveMessage(deps, message(1, actorId), log);
  const sessionId = runtime.onlySessionId();
  runtime.work(sessionId);
  return sessionId;
}

function answers(sessionId: string) {
  return runtime.sessions.get(sessionId)?.answered ?? [];
}

function parsed(sessionId: string, index = 0): unknown {
  return JSON.parse(answers(sessionId)[index]?.text ?? "null");
}

describe("answering custom tool calls", () => {
  it("answers a call once, however many times the conversation syncs", async () => {
    const sessionId = await threadInTurn();
    const { custom } = runtime.callCustomTools(sessionId, [
      { name: "link_project", input: { name: "Search" } },
    ]);
    await sync();
    await sync();
    await sync();
    expect(answers(sessionId).map((a) => a.customToolUseId)).toEqual(custom);
    expect(runtime.sessions.get(sessionId)?.denied).toEqual([]);
    expect(await listProjects(db)).toHaveLength(1);
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: "conversation.custom_tool_answered",
        customToolUseId: custom[0],
        name: "link_project",
        isError: false,
      }),
    );
  });

  it("answers a call again on the next sync when sending failed, without writing twice", async () => {
    const sessionId = await threadInTurn();
    runtime.callCustomTools(sessionId, [{ name: "link_project", input: { name: "Search" } }]);
    runtime.failNext.answerCustomTool = new Error("anthropic down");
    await sync();
    expect(answers(sessionId)).toEqual([]);
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: "conversation.custom_tool_failed", name: "link_project" }),
    );
    await sync();
    expect(answers(sessionId)).toHaveLength(1);
    expect(await listProjects(db)).toHaveLength(1);
  });

  it("answers an unknown tool with an error", async () => {
    const sessionId = await threadInTurn();
    runtime.callCustomTools(sessionId, [{ name: "drop_tables", input: {} }]);
    await sync();
    expect(answers(sessionId)).toEqual([
      expect.objectContaining({ isError: true, text: toolErrors.unknownTool("drop_tables") }),
    ]);
  });

  it("answers input that fails its contract with an error, and writes nothing", async () => {
    const sessionId = await threadInTurn();
    runtime.callCustomTools(sessionId, [
      { name: "link_project", input: { name: "Search", projectId: "not-a-uuid" } },
      { name: "record_approval", input: { subject: "ticket", action: "approve" } },
    ]);
    await sync();
    const [link, approval] = answers(sessionId);
    expect(link?.isError).toBe(true);
    expect(link?.text).toMatch(/^invalid input for link_project: /);
    expect(approval?.isError).toBe(true);
    expect(approval?.text).toMatch(/^invalid input for record_approval: .*actor/);
    expect(await listProjects(db)).toEqual([]);
  });

  it("still denies every other blocked call, once (decision 119)", async () => {
    const sessionId = await threadInTurn();
    const { custom, approvals } = runtime.callCustomTools(
      sessionId,
      [{ name: "link_project", input: { name: "Search" } }],
      2,
    );
    await sync();
    await sync();
    expect(runtime.sessions.get(sessionId)?.denied).toEqual(approvals);
    expect(answers(sessionId).map((a) => a.customToolUseId)).toEqual(custom);
  });

  it("lets the turn carry on and posts its answer when it ends", async () => {
    const sessionId = await threadInTurn();
    runtime.callCustomTools(sessionId, [{ name: "link_project", input: { name: "Search" } }]);
    await sync();
    expect(slack.delivered).toEqual([]);
    runtime.finish(sessionId, "Linked this thread to Search.");
    await sync();
    expect(slack.replies()).toEqual(["Linked this thread to Search."]);
    expect(slack.statuses()).toEqual([{ messageIds: ["100.000001"], status: "answered" }]);
  });
});

describe("link_project", () => {
  it("creates a project in plan for the sender, and links the thread to it", async () => {
    const sessionId = await threadInTurn("U7");
    const { custom } = runtime.callCustomTools(sessionId, [
      { name: "link_project", input: { name: " Search " } },
    ]);
    await sync();
    const [project] = await listProjects(db);
    expect(project).toMatchObject({
      name: "Search",
      stage: "plan",
      createdBy: { source: "slack", workspaceId: "T1", actorId: "U7" },
    });
    expect(await projectIdOfThread()).toBe(project?.id);
    expect(answers(sessionId)[0]).toMatchObject({ customToolUseId: custom[0], isError: false });
    expect(parsed(sessionId)).toEqual({ projectId: project?.id, name: "Search", stage: "plan" });
    const rows = await db.query(`select custom_tool_use_id from projects`);
    expect(rows).toEqual([{ custom_tool_use_id: custom[0] }]);
  });

  it("makes the project for the sender the turn answers, not a later one", async () => {
    const sessionId = await threadInTurn("U-alice");
    const { custom } = runtime.callCustomTools(sessionId, [
      { name: "link_project", input: { name: "Search" } },
    ]);
    // Bob writes while the call waits: his message is handed to the agent before the call
    // is answered.
    await receiveMessage(deps, message(2, "U-bob"), log);
    await sync();
    expect(answers(sessionId).map((a) => a.customToolUseId)).toEqual(custom);
    const forwarded = await db.query(
      `select actor_id from inbound_messages where forwarded_at is not null order by created_at`,
    );
    expect(forwarded).toEqual([{ actor_id: "U-alice" }, { actor_id: "U-bob" }]);
    const [project] = await listProjects(db);
    expect(project?.createdBy).toEqual({ source: "slack", workspaceId: "T1", actorId: "U-alice" });
  });

  it("answers an error, and makes nothing, when no message matches the call", async () => {
    const sessionId = await threadInTurn();
    // The hand-over's event id was never recorded: the message cannot be matched to the turn.
    await db.query(`update inbound_messages set agent_event_id = null`);
    runtime.callCustomTools(sessionId, [{ name: "link_project", input: { name: "Search" } }]);
    await sync();
    expect(answers(sessionId)).toEqual([
      expect.objectContaining({ isError: true, text: toolErrors.noSender }),
    ]);
    expect(await listProjects(db)).toEqual([]);
    expect(await projectIdOfThread()).toBeNull();
  });

  it("links the thread to a project that exists", async () => {
    const existing = await createProject(db, {
      name: "Billing",
      createdBy: { source: "slack", workspaceId: "T1", actorId: "U2" },
    });
    const sessionId = await threadInTurn();
    runtime.callCustomTools(sessionId, [
      { name: "link_project", input: { projectId: existing.id } },
    ]);
    await sync();
    expect(await projectIdOfThread()).toBe(existing.id);
    expect(parsed(sessionId)).toEqual({ projectId: existing.id, name: "Billing", stage: "plan" });
    expect(await listProjects(db)).toHaveLength(1);
  });

  it("answers an error for a project that does not exist, and links nothing", async () => {
    const sessionId = await threadInTurn();
    const missing = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
    runtime.callCustomTools(sessionId, [{ name: "link_project", input: { projectId: missing } }]);
    await sync();
    expect(answers(sessionId)).toEqual([
      expect.objectContaining({ isError: true, text: toolErrors.noProject(missing) }),
    ]);
    expect(await projectIdOfThread()).toBeNull();
  });

  it("makes one project when the same call is answered again", async () => {
    const sessionId = await threadInTurn();
    runtime.callCustomTools(sessionId, [{ name: "link_project", input: { name: "Search" } }]);
    // The project is made, but the answer does not reach the agent: the retry finds it.
    runtime.failNext.answerCustomTool = new Error("anthropic down");
    await sync();
    const first = await listProjects(db);
    await sync();
    expect(await listProjects(db)).toEqual(first);
    expect(parsed(sessionId)).toMatchObject({ projectId: first[0]?.id });
  });
});

describe("record_approval", () => {
  async function linkedThread(): Promise<{ sessionId: string; projectId: string }> {
    const sessionId = await threadInTurn("U1");
    const project = await createProject(db, {
      name: "Search",
      createdBy: { source: "slack", workspaceId: "T1", actorId: "U1" },
    });
    await setConversationProject(db, await conversationId(), project.id);
    return { sessionId, projectId: project.id };
  }

  it("needs the thread to be linked to a project", async () => {
    const sessionId = await threadInTurn();
    runtime.callCustomTools(sessionId, [
      {
        name: "record_approval",
        input: { subject: "plan", action: "approve", actor: { actorId: "U1" } },
      },
    ]);
    await sync();
    expect(answers(sessionId)).toEqual([
      expect.objectContaining({ isError: true, text: toolErrors.notLinked }),
    ]);
    expect(await db.query(`select id from approvals`)).toEqual([]);
  });

  it("records the approval for the person in the thread's workspace, with their role", async () => {
    const { sessionId, projectId } = await linkedThread();
    await setActorRole(db, {
      source: "slack",
      workspaceId: "T1",
      actorId: "U5",
      role: "engineering_manager",
    });
    await setActorRole(db, {
      source: "slack",
      workspaceId: "T1",
      actorId: "U6",
      role: "product_manager",
    });
    await receiveMessage(deps, message(2, "U5"), log);
    await receiveMessage(deps, message(3, "U6"), log);
    const { custom } = runtime.callCustomTools(sessionId, [
      {
        name: "record_approval",
        input: { subject: "plan", action: "approve", actor: { actorId: "U5" } },
      },
      {
        name: "record_approval",
        input: {
          subject: "plan",
          subjectVersion: "v2",
          action: "approve",
          actor: { actorId: "U6" },
        },
      },
    ]);
    await sync();
    const approvals = await listApprovals(db, projectId);
    expect(approvals).toMatchObject([
      {
        subject: "plan",
        action: "approve",
        actor: { source: "slack", workspaceId: "T1", actorId: "U5" },
        role: "engineering_manager",
        conversationId: await conversationId(),
      },
      { subjectVersion: "v2", role: "product_manager" },
    ]);
    expect(parsed(sessionId, 0)).toEqual({ approvalId: approvals[0]?.id, subjectApproved: false });
    expect(parsed(sessionId, 1)).toEqual({ approvalId: approvals[1]?.id, subjectApproved: true });
    const rows = await db.query(`select custom_tool_use_id from approvals order by seq`);
    expect(rows).toEqual(custom.map((id) => ({ custom_tool_use_id: id })));
  });

  it("refuses someone who has not written in the thread", async () => {
    const { sessionId, projectId } = await linkedThread();
    await setActorRole(db, {
      source: "slack",
      workspaceId: "T1",
      actorId: "U5",
      role: "engineering_manager",
    });
    runtime.callCustomTools(sessionId, [
      {
        name: "record_approval",
        input: { subject: "plan", action: "approve", actor: { actorId: "U5" } },
      },
      {
        name: "record_approval",
        input: { subject: "plan", action: "approve", actor: { actorId: "U1" } },
      },
    ]);
    await sync();
    expect(answers(sessionId)).toEqual([
      expect.objectContaining({ isError: true, text: toolErrors.notInThread }),
      expect.objectContaining({ isError: false }),
    ]);
    expect(toolErrors.notInThread).toBe(
      "only people who have written in this thread can be recorded as approving",
    );
    const approvals = await listApprovals(db, projectId);
    expect(approvals.map((a) => a.actor.actorId)).toEqual(["U1"]);
  });

  it("works after link_project in the same wait", async () => {
    const sessionId = await threadInTurn();
    runtime.callCustomTools(sessionId, [
      { name: "link_project", input: { name: "Search" } },
      {
        name: "record_approval",
        input: { subject: "plan", action: "approve", actor: { actorId: "U1" } },
      },
    ]);
    await sync();
    expect(answers(sessionId).map((a) => a.isError)).toEqual([false, false]);
    const projectId = await projectIdOfThread();
    expect(await listApprovals(db, projectId ?? "")).toHaveLength(1);
  });

  it("records one approval when the same call is answered again", async () => {
    const { sessionId, projectId } = await linkedThread();
    runtime.callCustomTools(sessionId, [
      {
        name: "record_approval",
        input: { subject: "plan", action: "approve", actor: { actorId: "U1" } },
      },
    ]);
    runtime.failNext.answerCustomTool = new Error("anthropic down");
    await sync();
    await sync();
    const approvals = await listApprovals(db, projectId);
    expect(approvals).toHaveLength(1);
    expect(answers(sessionId)).toHaveLength(1);
    expect(parsed(sessionId)).toEqual({ approvalId: approvals[0]?.id, subjectApproved: false });
  });
});
