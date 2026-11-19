import type { Approval, RecordApprovalRequest, Role } from "@hippidy/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findOrCreateConversation } from "./conversations.ts";
import {
  createProject,
  getActorRole,
  getProject,
  isApproved,
  listActorRoles,
  listProjects,
  readSenderAndProject,
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
      project: undefined,
    });
    expect(await readSenderAndProject(db, missing, "U1")).toEqual({
      role: undefined,
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
      project: { name: "Search", stage: "ship" },
    });
    // U2 holds a role, but in another workspace.
    expect(await readSenderAndProject(db, conversation.id, "U2")).toEqual({
      role: undefined,
      project: { name: "Search", stage: "ship" },
    });
    const elsewhere = await thread("T2");
    expect(await readSenderAndProject(db, elsewhere.id, "U2")).toEqual({
      role: "qa",
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
});
