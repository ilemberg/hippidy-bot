import { z } from "zod";
import { messageSourceSchema } from "./messages.ts";

// Projects, the roles people hold, and approvals (slice 5A; `docs/planning/projects.md`).
// hippidy-bot owns a project's stage and approvals; the document and ticket systems hold the
// content. Recording is not checking (decision 146): nothing here stops a stage change.

const timestamp = z.iso.datetime({ offset: true });
/** A project's or conversation's id: any UUID the database accepts, whatever its version. */
const uuid = z.guid();
/**
 * Text Postgres can hold: a null character is refused here with a 400, rather than by the
 * database with a 500.
 */
const noNull = (value: string) => !value.includes("\u0000");
const noNullMessage = { message: "Must not contain a null character" };

/** An id in a source system (Slack: a team or user id). */
const sourceId = z.string().min(1).max(255).refine(noNull, noNullMessage);

/** A person in a source system: one person per (source, workspace, actor). */
const actorSchema = z.strictObject({
  source: messageSourceSchema,
  workspaceId: z.string(),
  actorId: z.string(),
});

/** A person named in a request. */
const actorRequestSchema = z.strictObject({
  source: messageSourceSchema,
  workspaceId: sourceId,
  actorId: sourceId,
});

/** A project's stage (decision 136). Loose: a project may move backwards at any time. */
export const projectStageSchema = z.enum(["plan", "roadmap", "ship", "end"]);
export type ProjectStage = z.infer<typeof projectStageSchema>;

/** The six roles a person can hold (decision 138). */
export const roleSchema = z.enum([
  "engineering_manager",
  "product_manager",
  "tech_lead",
  "engineer",
  "qa",
  "designer",
]);
export type Role = z.infer<typeof roleSchema>;

/** What an approval is about (decision 137). */
export const approvalSubjectSchema = z.enum(["plan", "roadmap", "ticket", "end"]);
export type ApprovalSubject = z.infer<typeof approvalSubjectSchema>;

export const approvalActionSchema = z.enum(["approve", "withdraw"]);
export type ApprovalAction = z.infer<typeof approvalActionSchema>;

/** One project (decision 135). */
export const projectSchema = z.strictObject({
  id: uuid,
  name: z.string(),
  stage: projectStageSchema,
  /** Who asked for it. */
  createdBy: actorSchema,
  /** The project's main thread (decision 155); null until one is set. */
  mainConversationId: uuid.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Project = z.infer<typeof projectSchema>;

/** Request body of `POST /v1/projects`. A new project starts in `plan`. */
export const createProjectRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).refine(noNull, noNullMessage),
  createdBy: actorRequestSchema,
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

/** Request body of `PATCH /v1/projects/:id`: moves the stage, in any direction. */
export const updateProjectRequestSchema = z.strictObject({
  stage: projectStageSchema,
});
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

/** Response of `GET /v1/projects`: newest first. */
export const projectListSchema = z.strictObject({
  projects: z.array(projectSchema),
});
export type ProjectList = z.infer<typeof projectListSchema>;

/** One recorded approval or withdrawal (decision 152). Append-only. */
export const approvalSchema = z.strictObject({
  id: uuid,
  projectId: uuid,
  subject: approvalSubjectSchema,
  /** The document or ticket in the content system; free text until E1 picks the system. */
  subjectRef: z.string(),
  /** The version acted on, so an edit after approval can be noticed. */
  subjectVersion: z.string(),
  action: approvalActionSchema,
  actor: actorSchema,
  /** The role the person held when they acted; null if they had none. */
  role: roleSchema.nullable(),
  /** Any other roles they held when they acted (decision 170); each counts as `role` does. */
  extraRoles: z.array(roleSchema),
  /** The conversation the approval was given in, when there is one. */
  conversationId: uuid.nullable(),
  recordedAt: timestamp,
  /** The order rows were recorded in: a later row has a larger `seq`, even at the same time. */
  seq: z.number().int().positive(),
});
export type Approval = z.infer<typeof approvalSchema>;

/** Response of `GET /v1/projects/:id` (and of `POST` and `PATCH` on projects). */
export const projectDetailSchema = z.strictObject({
  project: projectSchema,
  /** Every approval and withdrawal, oldest first. */
  approvals: z.array(approvalSchema),
  /**
   * Whether the plan is approved now: the latest action of at least one engineering manager
   * and of at least one product manager is `approve`.
   */
  planApproved: z.boolean(),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;

/**
 * Request body of `POST /v1/projects/:id/approvals`. A ticket approval must name its ticket
 * (`subjectRef`), or two tickets' approvals would read as one.
 */
export const recordApprovalRequestSchema = z
  .strictObject({
    subject: approvalSubjectSchema,
    // Trimmed, so "T-1" and "T-1 " are the same ticket.
    subjectRef: z.string().trim().max(2000).refine(noNull, noNullMessage).default(""),
    subjectVersion: z.string().trim().max(255).refine(noNull, noNullMessage).default(""),
    action: approvalActionSchema,
    /** The person who approved or withdrew; their current role is copied onto the record. */
    actor: actorRequestSchema,
    conversationId: uuid.optional(),
  })
  .refine((body) => body.subject !== "ticket" || body.subjectRef !== "", {
    message: "A ticket approval must name its ticket",
    path: ["subjectRef"],
  });
export type RecordApprovalRequest = z.infer<typeof recordApprovalRequestSchema>;

/** Response of `POST /v1/projects/:id/approvals` (status 201). */
export const approvalResultSchema = z.strictObject({
  approval: approvalSchema,
  /**
   * Whether the approval's subject is approved now, after this record. For a ticket, only
   * the approvals of the same ticket (`subjectRef`) count.
   */
  subjectApproved: z.boolean(),
});
export type ApprovalResult = z.infer<typeof approvalResultSchema>;

/**
 * Request body of `PUT /v1/roles`: sets a person's roles, replacing any they held. `role` is
 * their main role, which chooses the agent for threads they start; `extraRoles` are any others
 * they also hold (decision 170). Duplicates, and the main role repeated, are dropped.
 */
export const setRoleRequestSchema = z
  .strictObject({
    source: messageSourceSchema,
    workspaceId: sourceId,
    actorId: sourceId,
    role: roleSchema,
    extraRoles: z.array(roleSchema).max(5).default([]),
  })
  .transform((body) => ({
    ...body,
    extraRoles: [...new Set(body.extraRoles)].filter((role) => role !== body.role),
  }));
export type SetRoleRequest = z.infer<typeof setRoleRequestSchema>;

/** The role a person holds in a workspace. Response of `PUT /v1/roles`. */
export const actorRoleSchema = z.strictObject({
  source: messageSourceSchema,
  workspaceId: z.string(),
  actorId: z.string(),
  role: roleSchema,
  /** Other roles the person also holds (decision 170); empty for most people. */
  extraRoles: z.array(roleSchema),
  updatedAt: timestamp,
});
export type ActorRole = z.infer<typeof actorRoleSchema>;

/** Response of `GET /v1/roles`. */
export const actorRoleListSchema = z.strictObject({
  roles: z.array(actorRoleSchema),
});
export type ActorRoleList = z.infer<typeof actorRoleListSchema>;

/**
 * Request body of `PUT /v1/conversations/:id/project`: ties a thread to a project (decision
 * 153), or unties it with `null`. Only the project changes; which agent the thread has does not.
 */
export const setConversationProjectRequestSchema = z.strictObject({
  projectId: uuid.nullable(),
});
export type SetConversationProjectRequest = z.infer<typeof setConversationProjectRequestSchema>;

/** Response of `PUT /v1/conversations/:id/project`. */
export const conversationProjectSchema = z.strictObject({
  conversationId: uuid,
  projectId: uuid.nullable(),
});
export type ConversationProject = z.infer<typeof conversationProjectSchema>;
