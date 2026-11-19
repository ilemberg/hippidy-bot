import type { Approval, RecordApprovalRequest, Role } from "@hippidy/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findOrCreateConversation, markForwarded, recordInbound } from "./conversations.ts";
import {
  createProject,
  getActorRole,
  getProject,
  hasWrittenInConversation,
  isApproved,
  listActorRoles,
  listProjects,
  readSenderAndProject,
  readToolCallContext,
  readTurnSender,
  recordApproval,
  setActorRole,
  setConversationProject,
  setProjectStage,
} from "./projects.ts";
import { createTestDb } from "./testing.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.close();
});

const creator = { source: "slack" as const, workspaceId: "T1", actorId: "U1" };
const missing = "00000000-0000-4000-8000-000000000000";

async function role(actorId: string, value: Role) {
  return await setActorRole(db, { source: "slack", workspaceId: "T1", actorId, role: value });
}

function approval(
  actorId: string,
  action: "approve" | "withdraw",
  overrides: Partial<RecordApprovalRequest> = {},
): RecordApprovalRequest {
  return {
    subject: "plan",
    subjectRef: "doc-1",
    subjectVersion: "3",
    action,
    actor: { source: "slack", workspaceId: "T1", actorId },
    ...overrides,
  };
}

async function record(projectId: string, request: RecordApprovalRequest): Promise<Approval> {
  const result = await recordApproval(db, projectId, request);
  if (result.kind !== "recorded") throw new Error(`expected a record, got ${result.kind}`);
  return result.approval;
}

async function planApproved(projectId: string): Promise<boolean> {
  const found = await getProject(db, projectId);
  return isApproved(found?.approvals ?? [], "plan");
}

describe("projects", () => {
  it("creates a project in the plan stage and reads it back", async () => {
    const project = await createProject(db, { name: "Search", createdBy: creator });
    expect(project).toMatchObject({
      name: "Search",
      stage: "plan",
      createdBy: creator,
      mainConversationId: null,
    });
    expect(project.createdAt).toBe(project.updatedAt);
    expect(await getProject(db, project.id)).toEqual({ project, approvals: [] });
    expect(await getProject(db, missing)).toBeUndefined();
  });

  it("lists projects newest first", async () => {
    const first = await createProject(db, { name: "One", createdBy: creator });
    const second = await createProject(db, { name: "Two", createdBy: creator });
    await db.query(`update projects set created_at = now() - interval '1 hour' where id = $1`, [
      first.id,
    ]);
    expect((await listProjects(db)).map((p) => p.id)).toEqual([second.id, first.id]);
  });

  it("moves the stage in any direction, and says when there is no such project", async () => {
    const project = await createProject(db, { name: "Search", createdBy: creator });
    expect((await setProjectStage(db, project.id, "ship"))?.stage).toBe("ship");
    const back = await setProjectStage(db, project.id, "plan");
    expect(back?.stage).toBe("plan");
    expect(back !== undefined && back.updatedAt >= project.updatedAt).toBe(true);
    expect(await setProjectStage(db, missing, "end")).toBeUndefined();
  });

  it("cannot be deleted once it has approvals, so the history survives", async () => {
    const project = await createProject(db, { name: "Search", createdBy: creator });
    await record(project.id, approval("EM", "approve"));
    await expect(db.query(`delete from projects where id = $1`, [project.id])).rejects.toThrow();
    expect(await getProject(db, project.id)).toBeDefined();
  });
});

describe("roles", () => {
  it("sets, replaces and reads a person's role", async () => {
    expect(await getActorRole(db, { source: "slack", workspaceId: "T1", actorId: "U1" })).toBe(
      undefined,
    );
    const set = await role("U1", "engineer");
    expect(set).toMatchObject({ source: "slack", workspaceId: "T1", actorId: "U1" });
    await db.query(`update actor_roles set updated_at = now() - interval '1 hour'`);
    const replaced = await role("U1", "tech_lead");
    expect(replaced.role).toBe("tech_lead");
    expect(replaced.updatedAt > set.updatedAt).toBe(true);
    expect(await getActorRole(db, { source: "slack", workspaceId: "T1", actorId: "U1" })).toBe(
      "tech_lead",
    );
    // One role per person per workspace: another workspace is another person.
    expect(await getActorRole(db, { source: "slack", workspaceId: "T2", actorId: "U1" })).toBe(
      undefined,
    );
  });

  it("lists the map", async () => {
    await role("U2", "qa");
    await role("U1", "designer");
    expect((await listActorRoles(db)).map((r) => [r.actorId, r.role])).toEqual([
      ["U1", "designer"],
      ["U2", "qa"],
    ]);
  });
});

describe("recordApproval", () => {
  it("copies the actor's current role, or null when they hold none", async () => {
    const project = await createProject(db, { name: "Search", createdBy: creator });
    await role("EM", "engineering_manager");
    const withRole = await record(project.id, approval("EM", "approve"));
    expect(withRole).toMatchObject({
      projectId: project.id,
      subject: "plan",
      subjectRef: "doc-1",
      subjectVersion: "3",
      action: "approve",
      actor: { source: "slack", workspaceId: "T1", actorId: "EM" },
      role: "engineering_manager",
      conversationId: null,
    });
    expect((await record(project.id, approval("nobody", "approve"))).role).toBeNull();
  });

  it("takes the role of exactly this person: the same actor in another workspace has none", async () => {
    const project = await createProject(db, { name: "Search", createdBy: creator });
    await role("EM", "engineering_manager");
    const elsewhere = await record(
      project.id,
      approval("EM", "approve", { actor: { source: "slack", workspaceId: "T2", actorId: "EM" } }),
    );
    expect(elsewhere).toMatchObject({
      actor: { source: "slack", workspaceId: "T2", actorId: "EM" },
      role: null,
    });
  });

  it("numbers rows in the order recorded, even within one transaction", async () => {
    const project = await createProject(db, { name: "Search", createdBy: creator });
    await db.transaction(async (tx) => {
      for (const action of ["approve", "withdraw", "approve"] as const) {
        const result = await recordApproval(tx, project.id, approval("EM", action));
        expect(result.kind).toBe("recorded");
      }
    });
    const rows = (await getProject(db, project.id))?.approvals ?? [];
    expect(rows.map((a) => a.action)).toEqual(["approve", "withdraw", "approve"]);
    expect(new Set(rows.map((a) => a.recordedAt)).size).toBe(1);
    const seqs = rows.map((a) => a.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(3);
  });

  it("is refused by the database for a ticket without a reference, or an unknown role", async () => {
    const project = await createProject(db, { name: "Search", createdBy: creator });
    await expect(
      recordApproval(
        db,
        project.id,
        approval("EM", "approve", { subject: "ticket", subjectRef: "" }),
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `insert into approvals (project_id, subject, action, actor_source, actor_workspace_id,
           actor_id, role)
         values ($1, 'plan', 'approve', 'slack', 'T1', 'EM', 'owner')`,
        [project.id],
      ),
    ).rejects.toThrow();
  });

  it("does not rewrite the recorded role when the role changes later", async () => {
    const project = await createProject(db, { name: "Search", createdBy: creator });
    await role("EM", "engineering_manager");
    await role("PM", "product_manager");
    await record(project.id, approval("EM", "approve"));
    await record(project.id, approval("PM", "approve"));
    await role("EM", "engineer");
    const found = await getProject(db, project.id);
    expect(found?.approvals.map((a) => a.role)).toEqual(["engineering_manager", "product_manager"]);
    expect(await planApproved(project.id)).toBe(true);
  });

  it("keeps the conversation it was given in, and refuses one that does not exist", async () => {
    const project = await createProject(db, { name: "Search", createdBy: creator });
    const conversation = await findOrCreateConversation(db, {
      source: "slack",
      workspaceId: "T1",
      channelId: "C1",
      threadId: "1.1",
    });
    const recorded = await record(
      project.id,
      approval("EM", "approve", { conversationId: conversation.id }),
    );
    expect(recorded.conversationId).toBe(conversation.id);
    expect(
      await recordApproval(db, project.id, approval("EM", "approve", { conversationId: missing })),
    ).toEqual({ kind: "no_conversation" });
  });

  it("says when there is no such project", async () => {
    expect(await recordApproval(db, missing, approval("EM", "approve"))).toEqual({
      kind: "no_project",
    });
    expect(await recordApproval(db, missing, approval("EM", "approve"), "sevt_1")).toEqual({
      kind: "no_project",
    });
  });
});

describe("writes made by a custom tool call (decision 167)", () => {
  it("makes one project per call, returning the same one when called again", async () => {
    const first = await createProject(db, { name: "Search", createdBy: creator }, "sevt_1");
    const again = await createProject(db, { name: "Other", createdBy: creator }, "sevt_1");
    expect(again).toEqual(first);
    const other = await createProject(db, { name: "Search", createdBy: creator }, "sevt_2");
    expect(other.id).not.toBe(first.id);
    // Without a call's id, nothing is keyed: two projects of one name are two projects.
    await createProject(db, { name: "Search", createdBy: creator });
    await createProject(db, { name: "Search", createdBy: creator });
    expect(await listProjects(db)).toHaveLength(4);
    const rows = await db.query(
      `select custom_tool_use_id from projects order by custom_tool_use_id nulls last`,
    );
    expect(rows.map((row) => row.custom_tool_use_id)).toEqual(["sevt_1", "sevt_2", null, null]);
  });

  it("records one approval per call, returning the same row when called again", async () => {
    const project = await createProject(db, { name: "Search", createdBy: creator });
    const first = await recordApproval(db, project.id, approval("EM", "approve"), "sevt_1");
    const again = await recordApproval(db, project.id, approval("EM", "withdraw"), "sevt_1");
    expect(first.kind).toBe("recorded");
    expect(again).toEqual(first);
    await recordApproval(db, project.id, approval("EM", "withdraw"), "sevt_2");
    await recordApproval(db, project.id, approval("EM", "approve"));
    const found = await getProject(db, project.id);
    expect(found?.approvals.map((a) => a.action)).toEqual(["approve", "withdraw", "approve"]);
  });
});

describe("readToolCallContext", () => {
  it("reads the thread's place and its project", async () => {
    const conversation = await thread();
    expect(await readToolCallContext(db, conversation.id)).toEqual({
      source: "slack",
      workspaceId: "T1",
      projectId: null,
    });
    const project = await createProject(db, { name: "Search", createdBy: creator });
    await setConversationProject(db, conversation.id, project.id);
    expect(await readToolCallContext(db, conversation.id)).toEqual({
      source: "slack",
      workspaceId: "T1",
      projectId: project.id,
    });
    expect(await readToolCallContext(db, missing)).toBeUndefined();
  });
});

async function thread() {
  return await findOrCreateConversation(db, {
    source: "slack",
    workspaceId: "T1",
    channelId: "C1",
    threadId: "100.1",
  });
}

function inbound(n: number, actorId: string, workspaceId = "T1") {
  return {
    source: "slack" as const,
    sourceEventId: `Ev${n}`,
    conversation: { workspaceId, channelId: "C1", threadId: "100.1", messageId: `${n}` },
    actor: { id: actorId },
    text: "hi",
    sentAt: "2026-11-18T00:00:00.000Z",
  };
}

describe("readTurnSender", () => {
  it("is the sender of the latest message processed at or before the call", async () => {
    const conversation = await thread();
    const forward = async (n: number, actorId: string, eventId: string | undefined) => {
      const message = await recordInbound(db, conversation.id, inbound(n, actorId));
      await markForwarded(db, message.id, eventId);
    };
    await forward(1, "U1", "sevt_1");
    await forward(2, "U2", "sevt_2");
    // Handed over but given no event id: it cannot be matched.
    await forward(3, "U3", undefined);
    const messages = [
      { eventId: "sevt_1", processedAt: "2026-11-18T00:00:01.000001Z" },
      { eventId: "sevt_2", processedAt: "2026-11-18T00:00:03.000000Z" },
      { eventId: "sevt_other", processedAt: "2026-11-18T00:00:02.000000Z" },
    ];
    const at = (time: string) => readTurnSender(db, conversation.id, time, messages);
    expect(await at("2026-11-18T00:00:01.000000Z")).toBeUndefined();
    // Compared at the runtime's precision, finer than a JavaScript Date.
    expect(await at("2026-11-18T00:00:01.000001Z")).toBe("U1");
    expect(await at("2026-11-18T00:00:02.500000Z")).toBe("U1");
    expect(await at("2026-11-18T00:00:03.000000Z")).toBe("U2");
    expect(await readTurnSender(db, conversation.id, "2026-11-18T00:00:09Z", [])).toBeUndefined();
  });
});

describe("hasWrittenInConversation", () => {
  it("is true only for a sender of the thread, in its source and workspace", async () => {
    const conversation = await thread();
    await recordInbound(db, conversation.id, inbound(1, "U1"));
    const other = await findOrCreateConversation(db, {
      source: "slack",
      workspaceId: "T1",
      channelId: "C1",
      threadId: "200.1",
    });
    await recordInbound(db, other.id, {
      ...inbound(2, "U2"),
      conversation: { workspaceId: "T1", channelId: "C1", threadId: "200.1", messageId: "2" },
    });
    const wrote = (actorId: string, workspaceId = "T1") =>
      hasWrittenInConversation(db, conversation.id, { source: "slack", workspaceId, actorId });
    expect(await wrote("U1")).toBe(true);
    expect(await wrote("U1", "T2")).toBe(false);
    // Wrote in another thread only.
    expect(await wrote("U2")).toBe(false);
    expect(await wrote("U9")).toBe(false);
  });
});

describe("the approval rule", () => {
  let projectId: string;

  beforeEach(async () => {
    projectId = (await createProject(db, { name: "Search", createdBy: creator })).id;
    await role("EM", "engineering_manager");
    await role("EM2", "engineering_manager");
    await role("PM", "product_manager");
    await role("TL", "tech_lead");
  });

  it("needs an engineering manager and a product manager", async () => {
    expect(await planApproved(projectId)).toBe(false);
    await record(projectId, approval("EM", "approve"));
    expect(await planApproved(projectId)).toBe(false);
    await record(projectId, approval("PM", "approve"));
    expect(await planApproved(projectId)).toBe(true);
  });

  it("is not met by two approvals from the same role", async () => {
    await record(projectId, approval("EM", "approve"));
    await record(projectId, approval("EM2", "approve"));
    await record(projectId, approval("TL", "approve"));
    expect(await planApproved(projectId)).toBe(false);
  });

  it("is undone by a withdrawal after the approval, and met again by a new approval", async () => {
    await record(projectId, approval("EM", "approve"));
    await record(projectId, approval("PM", "approve"));
    await record(projectId, approval("PM", "withdraw"));
    expect(await planApproved(projectId)).toBe(false);
    await record(projectId, approval("PM", "approve"));
    expect(await planApproved(projectId)).toBe(true);
  });

  it("still holds when one of two engineering managers withdraws", async () => {
    await record(projectId, approval("EM", "approve"));
    await record(projectId, approval("EM2", "approve"));
    await record(projectId, approval("PM", "approve"));
    await record(projectId, approval("EM", "withdraw"));
    expect(await planApproved(projectId)).toBe(true);
  });

  it("is not undone by the same actor id withdrawing in another workspace", async () => {
    await record(projectId, approval("EM", "approve"));
    await record(projectId, approval("PM", "approve"));
    await setActorRole(db, {
      source: "slack",
      workspaceId: "T2",
      actorId: "PM",
      role: "product_manager",
    });
    await record(
      projectId,
      approval("PM", "withdraw", { actor: { source: "slack", workspaceId: "T2", actorId: "PM" } }),
    );
    expect(await planApproved(projectId)).toBe(true);
  });

  it("does not count someone who had no role when they approved", async () => {
    await record(projectId, approval("EM", "approve"));
    await record(projectId, approval("newcomer", "approve"));
    await role("newcomer", "product_manager");
    expect(await planApproved(projectId)).toBe(false);
  });

  it("keeps subjects apart, and tickets apart by their reference", async () => {
    await record(projectId, approval("EM", "approve", { subject: "roadmap" }));
    await record(projectId, approval("PM", "approve", { subject: "plan" }));
    const found = await getProject(db, projectId);
    const all = found?.approvals ?? [];
    expect(isApproved(all, "plan")).toBe(false);
    expect(isApproved(all, "roadmap")).toBe(false);

    await record(projectId, approval("EM", "approve", { subject: "end" }));
    await record(projectId, approval("PM", "approve", { subject: "end" }));
    await record(projectId, approval("EM", "approve", { subject: "ticket", subjectRef: "T-1" }));
    await record(projectId, approval("PM", "approve", { subject: "ticket", subjectRef: "T-2" }));
    const after = (await getProject(db, projectId))?.approvals ?? [];
    expect(isApproved(after, "end")).toBe(true);
    expect(isApproved(after, "ticket", "T-1")).toBe(false);
    await record(projectId, approval("PM", "approve", { subject: "ticket", subjectRef: "T-1" }));
    expect(isApproved((await getProject(db, projectId))?.approvals ?? [], "ticket", "T-1")).toBe(
      true,
    );
  });
});

describe("a thread's project and its sender's role", () => {
  async function thread(workspaceId = "T1") {
    return await findOrCreateConversation(db, {
      source: "slack",
      workspaceId,
      channelId: "C1",
      threadId: "100.1",
    });
  }

  it("links a thread to a project and unlinks it", async () => {
    const project = await createProject(db, { name: "Search", createdBy: creator });
    const conversation = await thread();
    expect(await setConversationProject(db, conversation.id, project.id)).toEqual({
      kind: "set",
      projectId: project.id,
    });
    expect(await setConversationProject(db, conversation.id, null)).toEqual({
      kind: "set",
      projectId: null,
    });
    const rows = await db.query(`select project_id, agent_kind from conversations`);
    expect(rows).toEqual([{ project_id: null, agent_kind: null }]);
  });

  it("refuses an unknown conversation or project", async () => {
    const project = await createProject(db, { name: "Search", createdBy: creator });
    const conversation = await thread();
    expect(await setConversationProject(db, missing, project.id)).toEqual({
      kind: "no_conversation",
    });
    expect(await setConversationProject(db, missing, null)).toEqual({ kind: "no_conversation" });
    expect(await setConversationProject(db, conversation.id, missing)).toEqual({
      kind: "no_project",
    });
  });

  it("reads neither for a thread with no project and a sender with no role", async () => {
    const conversation = await thread();
    expect(await readSenderAndProject(db, conversation.id, "U1")).toEqual({
      role: undefined,
      extraRoles: [],
      project: undefined,
    });
    expect(await readSenderAndProject(db, missing, "U1")).toEqual({
      role: undefined,
      extraRoles: [],
      project: undefined,
    });
  });

  it("reads the role held in the thread's workspace, and the project's current stage", async () => {
    const project = await createProject(db, { name: "Search", createdBy: creator });
    const conversation = await thread();
    await setConversationProject(db, conversation.id, project.id);
    await role("U1", "product_manager");
    await setActorRole(db, { source: "slack", workspaceId: "T2", actorId: "U2", role: "qa" });
    await setProjectStage(db, project.id, "ship");

    expect(await readSenderAndProject(db, conversation.id, "U1")).toEqual({
      role: "product_manager",
      extraRoles: [],
      project: { name: "Search", stage: "ship" },
    });
    // U2 holds a role, but in another workspace.
    expect(await readSenderAndProject(db, conversation.id, "U2")).toEqual({
      role: undefined,
      extraRoles: [],
      project: { name: "Search", stage: "ship" },
    });
    const elsewhere = await thread("T2");
    expect(await readSenderAndProject(db, elsewhere.id, "U2")).toEqual({
      role: "qa",
      extraRoles: [],
      project: undefined,
    });
  });
});

describe("isApproved", () => {
  // Every row has the same time: only `seq` orders them.
  const row = (actorId: string, role: Role | null, action: "approve" | "withdraw", seq: number) =>
    ({
      id: `00000000-0000-4000-8000-00000000000${seq}`,
      projectId: missing,
      subject: "plan",
      subjectRef: "",
      subjectVersion: "",
      action,
      actor: { source: "slack", workspaceId: "T1", actorId },
      role,
      extraRoles: [] as Role[],
      conversationId: null,
      recordedAt: "2026-11-19T00:00:00.000Z",
      seq,
    }) satisfies Approval;

  it("takes each approver's latest row by seq, whatever order it is given in", () => {
    const rows = [
      row("PM", "product_manager", "withdraw", 3),
      row("EM", "engineering_manager", "approve", 1),
      row("PM", "product_manager", "approve", 2),
    ];
    expect(isApproved(rows, "plan")).toBe(false);
    expect(isApproved([row("PM", "product_manager", "approve", 4), ...rows], "plan")).toBe(true);
  });

  it("counts one approval for every role recorded on it (decision 170)", () => {
    const both = {
      ...row("PO", "product_manager", "approve", 1),
      extraRoles: ["engineering_manager"] as Role[],
    };
    expect(isApproved([both], "plan")).toBe(true);
    // Their withdrawal withdraws both.
    expect(isApproved([both, row("PO", "product_manager", "withdraw", 2)], "plan")).toBe(false);
    // An approval from before they held both counts for one role only.
    expect(isApproved([row("PO", "product_manager", "approve", 1)], "plan")).toBe(false);
  });
});

describe("a person with more than one role (decision 170)", () => {
  it("sets, replaces and lists extra roles, dropping duplicates and the main role", async () => {
    const set = await setActorRole(db, {
      ...creator,
      role: "product_manager",
      extraRoles: ["engineering_manager", "product_manager", "engineering_manager"],
    });
    expect(set).toMatchObject({ role: "product_manager", extraRoles: ["engineering_manager"] });
    expect((await listActorRoles(db))[0]?.extraRoles).toEqual(["engineering_manager"]);
    expect((await role("U1", "engineer")).extraRoles).toEqual([]);
  });

  it("refuses an extra role that is not a role, or repeats the main one", async () => {
    await expect(
      db.query(
        `insert into actor_roles (source, workspace_id, actor_id, role, extra_roles)
         values ('slack', 'T1', 'U9', 'qa', '{owner}')`,
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `insert into actor_roles (source, workspace_id, actor_id, role, extra_roles)
         values ('slack', 'T1', 'U9', 'qa', '{qa}')`,
      ),
    ).rejects.toThrow();
  });

  it("approves the plan alone, and the approval keeps the roles held at the time", async () => {
    const project = await createProject(db, { name: "Search", createdBy: creator });
    await role("PO", "product_manager");
    const before = await record(project.id, approval("PO", "approve"));
    expect(before).toMatchObject({ role: "product_manager", extraRoles: [] });
    expect(await planApproved(project.id)).toBe(false);

    await setActorRole(db, {
      source: "slack",
      workspaceId: "T1",
      actorId: "PO",
      role: "product_manager",
      extraRoles: ["engineering_manager"],
    });
    const after = await record(project.id, approval("PO", "approve"));
    expect(after).toMatchObject({ role: "product_manager", extraRoles: ["engineering_manager"] });
    expect(await planApproved(project.id)).toBe(true);

    await role("PO", "product_manager");
    expect((await getProject(db, project.id))?.approvals[1]?.extraRoles).toEqual([
      "engineering_manager",
    ]);
    await record(project.id, approval("PO", "withdraw"));
    expect(await planApproved(project.id)).toBe(false);
  });

  it("tells the agent every role the sender holds", async () => {
    const conversation = await findOrCreateConversation(db, {
      source: "slack",
      workspaceId: "T1",
      channelId: "C",
      threadId: "9.9",
    });
    await setActorRole(db, {
      ...creator,
      role: "product_manager",
      extraRoles: ["engineering_manager"],
    });
    expect(await readSenderAndProject(db, conversation.id, "U1")).toEqual({
      role: "product_manager",
      extraRoles: ["engineering_manager"],
      project: undefined,
    });
  });
});
