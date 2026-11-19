import {
  approvalActionSchema,
  approvalSubjectSchema,
  messageSourceSchema,
  projectStageSchema,
  roleSchema,
  type ActorRole,
  type Approval,
  type ApprovalSubject,
  type CreateProjectRequest,
  type MessageSource,
  type Project,
  type ProjectStage,
  type RecordApprovalRequest,
  type Role,
  type SetRoleRequest,
} from "@hippidy/contracts";
import { z } from "zod";
import type { Db, Row } from "./db.ts";

// Projects, roles and approvals (slice 5A, decisions 135 to 152). The API records what it is
// told and checks nothing (decision 146): an approval never moves a stage.

const projectColumns = `
  id, name, stage, created_by_source, created_by_workspace_id, created_by_actor_id,
  main_conversation_id, created_at, updated_at`;

const projectRow = z.object({
  id: z.string(),
  name: z.string(),
  stage: projectStageSchema,
  created_by_source: messageSourceSchema,
  created_by_workspace_id: z.string(),
  created_by_actor_id: z.string(),
  main_conversation_id: z.string().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});

function toProject(row: Row): Project {
  const r = projectRow.parse(row);
  return {
    id: r.id,
    name: r.name,
    stage: r.stage,
    createdBy: {
      source: r.created_by_source,
      workspaceId: r.created_by_workspace_id,
      actorId: r.created_by_actor_id,
    },
    mainConversationId: r.main_conversation_id,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

// `seq` is a bigint, which the production client returns as a string: it is read as float8,
// exact far beyond any number of approvals.
const approvalColumns = `
  id, project_id, subject, subject_ref, subject_version, action, actor_source,
  actor_workspace_id, actor_id, role, conversation_id, recorded_at, seq::float8 as seq`;

const approvalRow = z.object({
  id: z.string(),
  project_id: z.string(),
  subject: approvalSubjectSchema,
  subject_ref: z.string(),
  subject_version: z.string(),
  action: approvalActionSchema,
  actor_source: messageSourceSchema,
  actor_workspace_id: z.string(),
  actor_id: z.string(),
  role: roleSchema.nullable(),
  conversation_id: z.string().nullable(),
  recorded_at: z.date(),
  seq: z.number().int().positive(),
});

function toApproval(row: Row): Approval {
  const r = approvalRow.parse(row);
  return {
    id: r.id,
    projectId: r.project_id,
    subject: r.subject,
    subjectRef: r.subject_ref,
    subjectVersion: r.subject_version,
    action: r.action,
    actor: { source: r.actor_source, workspaceId: r.actor_workspace_id, actorId: r.actor_id },
    role: r.role,
    conversationId: r.conversation_id,
    recordedAt: r.recorded_at.toISOString(),
    seq: r.seq,
  };
}

const roleColumns = "source, workspace_id, actor_id, role, updated_at";

const roleRow = z.object({
  source: messageSourceSchema,
  workspace_id: z.string(),
  actor_id: z.string(),
  role: roleSchema,
  updated_at: z.date(),
});

function toActorRole(row: Row): ActorRole {
  const r = roleRow.parse(row);
  return {
    source: r.source,
    workspaceId: r.workspace_id,
    actorId: r.actor_id,
    role: r.role,
    updatedAt: r.updated_at.toISOString(),
  };
}

function one(rows: Row[]): Row {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

/** Creates a project in the `plan` stage. */
export async function createProject(db: Db, request: CreateProjectRequest): Promise<Project> {
  const rows = await db.query(
    `insert into projects (name, created_by_source, created_by_workspace_id, created_by_actor_id)
     values ($1, $2, $3, $4)
     returning ${projectColumns}`,
    [
      request.name,
      request.createdBy.source,
      request.createdBy.workspaceId,
      request.createdBy.actorId,
    ],
  );
  return toProject(one(rows));
}

/** Every project, newest first. */
export async function listProjects(db: Db): Promise<Project[]> {
  const rows = await db.query(
    `select ${projectColumns} from projects order by created_at desc, id desc`,
  );
  return rows.map(toProject);
}

/** One project with its approvals (oldest first), or undefined if there is none. */
export async function getProject(
  db: Db,
  id: string,
): Promise<{ project: Project; approvals: Approval[] } | undefined> {
  const rows = await db.query(`select ${projectColumns} from projects where id = $1`, [id]);
  if (rows[0] === undefined) return undefined;
  return { project: toProject(rows[0]), approvals: await listApprovals(db, id) };
}

/** A project's approvals and withdrawals, in the order they were recorded. */
export async function listApprovals(db: Db, projectId: string): Promise<Approval[]> {
  const rows = await db.query(
    `select ${approvalColumns} from approvals
     where project_id = $1
     order by seq`,
    [projectId],
  );
  return rows.map(toApproval);
}

/** Moves a project to a stage, in any direction. Undefined if there is no such project. */
export async function setProjectStage(
  db: Db,
  id: string,
  stage: ProjectStage,
): Promise<Project | undefined> {
  const rows = await db.query(
    `update projects set stage = $2, updated_at = now()
     where id = $1
     returning ${projectColumns}`,
    [id, stage],
  );
  return rows[0] === undefined ? undefined : toProject(rows[0]);
}

/** Sets a person's role in a workspace, replacing the one they held. */
export async function setActorRole(db: Db, request: SetRoleRequest): Promise<ActorRole> {
  const rows = await db.query(
    `insert into actor_roles (source, workspace_id, actor_id, role)
     values ($1, $2, $3, $4)
     on conflict (source, workspace_id, actor_id)
       do update set role = excluded.role, updated_at = now()
     returning ${roleColumns}`,
    [request.source, request.workspaceId, request.actorId, request.role],
  );
  return toActorRole(one(rows));
}

/** The whole map from people to roles. */
export async function listActorRoles(db: Db): Promise<ActorRole[]> {
  const rows = await db.query(
    `select ${roleColumns} from actor_roles order by source, workspace_id, actor_id`,
  );
  return rows.map(toActorRole);
}

/** The role a person holds, or undefined if they hold none. */
export async function getActorRole(
  db: Db,
  actor: { source: MessageSource; workspaceId: string; actorId: string },
): Promise<Role | undefined> {
  const rows = await db.query(
    `select ${roleColumns} from actor_roles
     where source = $1 and workspace_id = $2 and actor_id = $3`,
    [actor.source, actor.workspaceId, actor.actorId],
  );
  return rows[0] === undefined ? undefined : toActorRole(rows[0]).role;
}

export type RecordApprovalResult =
  { kind: "recorded"; approval: Approval } | { kind: "no_project" } | { kind: "no_conversation" };

/**
 * Appends an approval or a withdrawal. The actor's role at this moment is copied onto the row
 * (null if they hold none), so a later change of role does not rewrite it.
 */
export async function recordApproval(
  db: Db,
  projectId: string,
  request: RecordApprovalRequest,
): Promise<RecordApprovalResult> {
  const conversationId = request.conversationId ?? null;
  if (conversationId !== null) {
    const found = await db.query(`select id from conversations where id = $1`, [conversationId]);
    if (found.length === 0) return { kind: "no_conversation" };
  }
  // The project is checked in the same statement: no row comes back when it does not exist.
  // The role is the one held by exactly this person: same source, workspace and actor.
  const rows = await db.query(
    `insert into approvals (
       project_id, subject, subject_ref, subject_version, action, actor_source,
       actor_workspace_id, actor_id, role, conversation_id
     )
     select p.id, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text,
       (select r.role from actor_roles r
        where r.source = $6::text and r.workspace_id = $7::text and r.actor_id = $8::text),
       $9::uuid
     from projects p
     where p.id = $1::uuid
     returning ${approvalColumns}`,
    [
      projectId,
      request.subject,
      request.subjectRef,
      request.subjectVersion,
      request.action,
      request.actor.source,
      request.actor.workspaceId,
      request.actor.actorId,
      conversationId,
    ],
  );
  return rows[0] === undefined
    ? { kind: "no_project" }
    : { kind: "recorded", approval: toApproval(rows[0]) };
}

/** The two roles whose approval a subject needs (decision 137). */
const APPROVING_ROLES: readonly Role[] = ["engineering_manager", "product_manager"];

/**
 * Whether a subject is approved now: take each approver's latest row for it; approved when the
 * latest action of at least one engineering manager and at least one product manager is
 * `approve`. The role is the one recorded on that row. For a ticket, only the rows of the same
 * ticket (`subjectRef`) count; the plan, the roadmap and the end are one subject each.
 *
 * An approver is one person: the same source, workspace and actor. `approvals` may be in any
 * order; the latest row is the one with the largest `seq`, never the time recorded.
 */
export function isApproved(
  approvals: readonly Approval[],
  subject: ApprovalSubject,
  subjectRef = "",
): boolean {
  const relevant = approvals
    .filter((a) => a.subject === subject && (subject !== "ticket" || a.subjectRef === subjectRef))
    .sort((x, y) => x.seq - y.seq);
  const latest = new Map<string, Approval>();
  for (const approval of relevant) {
    const { source, workspaceId, actorId } = approval.actor;
    latest.set(JSON.stringify([source, workspaceId, actorId]), approval);
  }
  const approvedBy = new Set<Role>();
  for (const approval of latest.values()) {
    if (approval.action === "approve" && approval.role !== null) approvedBy.add(approval.role);
  }
  return APPROVING_ROLES.every((role) => approvedBy.has(role));
}
