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
  actor_workspace_id, actor_id, role, extra_roles, conversation_id, recorded_at,
  seq::float8 as seq`;

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
  extra_roles: z.array(roleSchema),
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
    extraRoles: r.extra_roles,
    conversationId: r.conversation_id,
    recordedAt: r.recorded_at.toISOString(),
    seq: r.seq,
  };
}

const roleColumns = "source, workspace_id, actor_id, role, extra_roles, updated_at";

const roleRow = z.object({
  source: messageSourceSchema,
  workspace_id: z.string(),
  actor_id: z.string(),
  role: roleSchema,
  extra_roles: z.array(roleSchema),
  updated_at: z.date(),
});

function toActorRole(row: Row): ActorRole {
  const r = roleRow.parse(row);
  return {
    source: r.source,
    workspaceId: r.workspace_id,
    actorId: r.actor_id,
    role: r.role,
    extraRoles: r.extra_roles,
    updatedAt: r.updated_at.toISOString(),
  };
}

function one(rows: Row[]): Row {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

/**
 * Creates a project in the `plan` stage. Made by a custom tool call (decision 167), it is
 * keyed on the call's id: the same call made again returns the project it already made.
 */
export async function createProject(
  db: Db,
  request: CreateProjectRequest,
  customToolUseId?: string,
): Promise<Project> {
  const toolUseId = customToolUseId ?? null;
  const rows = await db.query(
    `insert into projects
       (name, created_by_source, created_by_workspace_id, created_by_actor_id, custom_tool_use_id)
     values ($1, $2, $3, $4, $5::text)
     on conflict (custom_tool_use_id) do nothing
     returning ${projectColumns}`,
    [
      request.name,
      request.createdBy.source,
      request.createdBy.workspaceId,
      request.createdBy.actorId,
      toolUseId,
    ],
  );
  if (rows[0] !== undefined || toolUseId === null) return toProject(one(rows));
  const made = await db.query(
    `select ${projectColumns} from projects where custom_tool_use_id = $1`,
    [toolUseId],
  );
  return toProject(one(made));
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

/** Sets a person's roles in a workspace, replacing the ones they held. */
export async function setActorRole(
  db: Db,
  request: Omit<SetRoleRequest, "extraRoles"> & { extraRoles?: readonly Role[] },
): Promise<ActorRole> {
  const extraRoles = [...new Set(request.extraRoles ?? [])].filter((role) => role !== request.role);
  const rows = await db.query(
    `insert into actor_roles (source, workspace_id, actor_id, role, extra_roles)
     values ($1, $2, $3, $4, $5::text[])
     on conflict (source, workspace_id, actor_id)
       do update set role = excluded.role, extra_roles = excluded.extra_roles, updated_at = now()
     returning ${roleColumns}`,
    [request.source, request.workspaceId, request.actorId, request.role, extraRoles],
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

/** A person's main role, or undefined if they hold none. */
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
 * Appends an approval or a withdrawal. The actor's roles at this moment are copied onto the row
 * (role null if they hold none), so a later change of roles does not rewrite it. Recorded by a
 * custom tool call (decision 167), it is keyed on the call's id: the same call made again
 * returns the row it already recorded.
 */
export async function recordApproval(
  db: Db,
  projectId: string,
  request: RecordApprovalRequest,
  customToolUseId?: string,
): Promise<RecordApprovalResult> {
  const toolUseId = customToolUseId ?? null;
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
       actor_workspace_id, actor_id, role, extra_roles, conversation_id, custom_tool_use_id
     )
     select p.id, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text,
       r.role, coalesce(r.extra_roles, '{}'), $9::uuid, $10::text
     from projects p
     left join actor_roles r
       on r.source = $6::text and r.workspace_id = $7::text and r.actor_id = $8::text
     where p.id = $1::uuid
     on conflict (custom_tool_use_id) do nothing
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
      toolUseId,
    ],
  );
  if (rows[0] !== undefined) return { kind: "recorded", approval: toApproval(rows[0]) };
  if (toolUseId !== null) {
    const recorded = await db.query(
      `select ${approvalColumns} from approvals where custom_tool_use_id = $1`,
      [toolUseId],
    );
    if (recorded[0] !== undefined) return { kind: "recorded", approval: toApproval(recorded[0]) };
  }
  return { kind: "no_project" };
}

/** The two roles whose approval a subject needs (decision 137). */
const APPROVING_ROLES: readonly Role[] = ["engineering_manager", "product_manager"];

/**
 * Whether a subject is approved now: take each approver's latest row for it; approved when the
 * latest action of at least one engineering manager and at least one product manager is
 * `approve`. The roles are the ones recorded on that row: someone who held both when they
 * approved counts for both (decision 170), and their withdrawal withdraws both. For a ticket, only the rows of the same
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
    if (approval.action !== "approve" || approval.role === null) continue;
    approvedBy.add(approval.role);
    for (const role of approval.extraRoles) approvedBy.add(role);
  }
  return APPROVING_ROLES.every((role) => approvedBy.has(role));
}

export type SetConversationProjectResult =
  { kind: "set"; projectId: string | null } | { kind: "no_conversation" } | { kind: "no_project" };

/**
 * Ties a conversation to a project, or unties it with null (decision 153). Only `project_id`
 * changes: not the agent kind, and not `updated_at`, which a session-start claim reads to tell
 * whether it went stale.
 */
export async function setConversationProject(
  db: Db,
  conversationId: string,
  projectId: string | null,
): Promise<SetConversationProjectResult> {
  if (projectId !== null) {
    const found = await db.query(`select id from projects where id = $1`, [projectId]);
    if (found.length === 0) return { kind: "no_project" };
  }
  const rows = await db.query(
    `update conversations set project_id = $2::uuid where id = $1::uuid returning project_id`,
    [conversationId, projectId],
  );
  if (rows[0] === undefined) return { kind: "no_conversation" };
  const r = z.object({ project_id: z.string().nullable() }).parse(rows[0]);
  return { kind: "set", projectId: r.project_id };
}

/** What a custom tool call needs to know about the conversation it was made in. */
export interface ToolCallContext {
  source: MessageSource;
  workspaceId: string;
  /** The conversation's project, if it is linked to one. */
  projectId: string | null;
}

const toolCallContextRow = z.object({
  source: messageSourceSchema,
  workspace_id: z.string(),
  project_id: z.string().nullable(),
});

/**
 * The conversation's source, workspace and project, read fresh for each custom tool call.
 * Undefined if the conversation does not exist.
 */
export async function readToolCallContext(
  db: Db,
  conversationId: string,
): Promise<ToolCallContext | undefined> {
  const rows = await db.query(
    `select c.source, c.workspace_id, c.project_id from conversations c where c.id = $1`,
    [conversationId],
  );
  if (rows[0] === undefined) return undefined;
  const r = toolCallContextRow.parse(rows[0]);
  return { source: r.source, workspaceId: r.workspace_id, projectId: r.project_id };
}

/** A user message the agent session has processed: its event id, and when (runtime's clock). */
export interface ProcessedUserMessage {
  eventId: string;
  processedAt: string;
}

/**
 * Who sent the message a custom tool call's turn is answering: of the conversation's inbound
 * messages, the one whose agent event (`agent_event_id`) the session processed last at or
 * before the call itself. Messages handed over later, even while the call waits, never count.
 * Undefined if no message matches: the caller does not guess.
 *
 * The times are compared in Postgres, as given by the runtime, so no precision is lost.
 */
export async function readTurnSender(
  db: Db,
  conversationId: string,
  callProcessedAt: string,
  messages: readonly ProcessedUserMessage[],
): Promise<string | undefined> {
  if (messages.length === 0) return undefined;
  const rows = await db.query(
    `select m.actor_id
     from unnest($2::text[], $3::text[]) as u(event_id, processed_at)
     join inbound_messages m on m.conversation_id = $1 and m.agent_event_id = u.event_id
     where u.processed_at::timestamptz <= $4::timestamptz
     order by u.processed_at::timestamptz desc, m.created_at desc
     limit 1`,
    [
      conversationId,
      messages.map((m) => m.eventId),
      messages.map((m) => m.processedAt),
      callProcessedAt,
    ],
  );
  return z.object({ actor_id: z.string() }).optional().parse(rows[0])?.actor_id;
}

/**
 * Whether this person has written in the conversation: at least one inbound message from the
 * same source, workspace and actor id.
 */
export async function hasWrittenInConversation(
  db: Db,
  conversationId: string,
  actor: { source: MessageSource; workspaceId: string; actorId: string },
): Promise<boolean> {
  const rows = await db.query(
    `select 1 from inbound_messages
     where conversation_id = $1 and source = $2 and workspace_id = $3 and actor_id = $4
     limit 1`,
    [conversationId, actor.source, actor.workspaceId, actor.actorId],
  );
  return rows.length > 0;
}

/** What the agent is told about a message besides its text (slice 5A, part D). */
export interface SenderAndProject {
  /** The sender's main role, when they hold one in the conversation's source and workspace. */
  role: Role | undefined;
  /** Any other roles the sender holds (decision 170). */
  extraRoles?: readonly Role[];
  /** The conversation's project, when it has one. */
  project: { name: string; stage: ProjectStage } | undefined;
}

const senderAndProjectRow = z.object({
  role: roleSchema.nullable(),
  extra_roles: z.array(roleSchema).nullable(),
  project_name: z.string().nullable(),
  project_stage: projectStageSchema.nullable(),
});

/**
 * The sender's role and the conversation's project, in one query whose every lookup is by
 * primary key. Neither is known when the conversation does not exist.
 */
export async function readSenderAndProject(
  db: Db,
  conversationId: string,
  actorId: string,
): Promise<SenderAndProject> {
  const rows = await db.query(
    `select r.role, r.extra_roles, p.name as project_name, p.stage as project_stage
     from conversations c
     left join actor_roles r
       on r.source = c.source and r.workspace_id = c.workspace_id and r.actor_id = $2
     left join projects p on p.id = c.project_id
     where c.id = $1`,
    [conversationId, actorId],
  );
  if (rows[0] === undefined) return { role: undefined, extraRoles: [], project: undefined };
  const r = senderAndProjectRow.parse(rows[0]);
  return {
    role: r.role ?? undefined,
    extraRoles: r.extra_roles ?? [],
    project:
      r.project_name !== null && r.project_stage !== null
        ? { name: r.project_name, stage: r.project_stage }
        : undefined,
  };
}
