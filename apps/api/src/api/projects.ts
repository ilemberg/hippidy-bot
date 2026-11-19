import {
  createProjectRequestSchema,
  recordApprovalRequestSchema,
  setConversationProjectRequestSchema,
  setRoleRequestSchema,
  updateProjectRequestSchema,
  type ActorRoleList,
  type Approval,
  type ApprovalResult,
  type ConversationProject,
  type Project,
  type ProjectDetail,
  type ProjectList,
} from "@hippidy/contracts";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { z } from "zod";
import type { Db } from "../store/db.ts";
import {
  createProject,
  getProject,
  isApproved,
  listActorRoles,
  listApprovals,
  listProjects,
  recordApproval,
  setActorRole,
  setConversationProject,
  setProjectStage,
} from "../store/projects.ts";
import { errorResponse } from "./errors.ts";
import type { ApiEnv } from "./types.ts";

const projectIdSchema = z.guid();
const conversationIdSchema = z.guid();

export interface ProjectRouteDeps {
  /** Storage. Undefined until it is configured: every route then answers 503. */
  db: Db | undefined;
  /** Requires the service token. */
  auth: MiddlewareHandler<ApiEnv>;
  /** Limits the size of a request body. */
  limitBody: MiddlewareHandler<ApiEnv>;
}

type Parsed<T> = { kind: "ok"; data: T } | { kind: "invalid"; response: Response };

/** Reads and checks a JSON body, or builds the error response for it. */
async function readBody<T>(c: Context<ApiEnv>, schema: z.ZodType<T>): Promise<Parsed<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return {
      kind: "invalid",
      response: errorResponse(c, 400, "invalid_request", "Request body must be JSON"),
    };
  }
  const parsed = schema.safeParse(body);
  if (parsed.success) return { kind: "ok", data: parsed.data };
  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
  c.var.log.warn("request.invalid", { path: c.req.path, issues });
  return {
    kind: "invalid",
    response: errorResponse(c, 400, "invalid_request", "Request body is invalid", issues),
  };
}

function detail(project: Project, approvals: Approval[]): ProjectDetail {
  return { project, approvals, planApproved: isApproved(approvals, "plan") };
}

const notConfigured = (c: Context<ApiEnv>) =>
  errorResponse(c, 503, "not_configured", "Projects are not configured");

const noProject = (c: Context<ApiEnv>) => errorResponse(c, 404, "not_found", "No such project");

const noConversation = (c: Context<ApiEnv>) =>
  errorResponse(c, 404, "not_found", "No such conversation");

/**
 * Projects, roles and approvals (slice 5A). Recording only: an approval never moves a stage,
 * and nothing here checks who may do what (decision 146).
 */
export function addProjectRoutes(api: Hono<ApiEnv>, deps: ProjectRouteDeps): void {
  const { auth, limitBody } = deps;

  api.post("/v1/projects", auth, limitBody, async (c) => {
    const body = await readBody(c, createProjectRequestSchema);
    if (body.kind === "invalid") return body.response;
    if (deps.db === undefined) return notConfigured(c);
    const project = await createProject(deps.db, body.data);
    c.var.log.info("project.created", { projectId: project.id, createdBy: project.createdBy });
    return c.json(detail(project, []), 201);
  });

  api.get("/v1/projects", auth, async (c) => {
    if (deps.db === undefined) return notConfigured(c);
    const body: ProjectList = { projects: await listProjects(deps.db) };
    c.var.log.info("projects.listed", { count: body.projects.length });
    return c.json(body);
  });

  api.get("/v1/projects/:id", auth, async (c) => {
    const id = projectIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return noProject(c);
    if (deps.db === undefined) return notConfigured(c);
    const found = await getProject(deps.db, id.data);
    if (found === undefined) return noProject(c);
    c.var.log.info("project.read", { projectId: id.data });
    return c.json(detail(found.project, found.approvals));
  });

  api.patch("/v1/projects/:id", auth, limitBody, async (c) => {
    const id = projectIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return noProject(c);
    const body = await readBody(c, updateProjectRequestSchema);
    if (body.kind === "invalid") return body.response;
    if (deps.db === undefined) return notConfigured(c);
    const project = await setProjectStage(deps.db, id.data, body.data.stage);
    if (project === undefined) return noProject(c);
    c.var.log.info("project.stage_set", { projectId: id.data, stage: project.stage });
    return c.json(detail(project, await listApprovals(deps.db, id.data)));
  });

  api.post("/v1/projects/:id/approvals", auth, limitBody, async (c) => {
    const id = projectIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return noProject(c);
    const body = await readBody(c, recordApprovalRequestSchema);
    if (body.kind === "invalid") return body.response;
    if (deps.db === undefined) return notConfigured(c);
    const result = await recordApproval(deps.db, id.data, body.data);
    switch (result.kind) {
      case "no_project":
        return noProject(c);
      case "no_conversation":
        return errorResponse(c, 400, "invalid_request", "Request body is invalid", [
          { path: "conversationId", message: "No such conversation" },
        ]);
      case "recorded": {
        const { approval } = result;
        const response: ApprovalResult = {
          approval,
          subjectApproved: isApproved(
            await listApprovals(deps.db, id.data),
            approval.subject,
            approval.subjectRef,
          ),
        };
        c.var.log.info("approval.recorded", {
          projectId: id.data,
          approvalId: approval.id,
          subject: approval.subject,
          action: approval.action,
          role: approval.role,
          subjectApproved: response.subjectApproved,
        });
        return c.json(response, 201);
      }
    }
  });

  api.put("/v1/roles", auth, limitBody, async (c) => {
    const body = await readBody(c, setRoleRequestSchema);
    if (body.kind === "invalid") return body.response;
    if (deps.db === undefined) return notConfigured(c);
    const role = await setActorRole(deps.db, body.data);
    c.var.log.info("role.set", {
      source: role.source,
      workspaceId: role.workspaceId,
      actorId: role.actorId,
      role: role.role,
      extraRoles: role.extraRoles,
    });
    return c.json(role);
  });

  // Ties a thread to a project, or unties it (decision 153). The agent kind is left as it is.
  api.put("/v1/conversations/:id/project", auth, limitBody, async (c) => {
    const id = conversationIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return noConversation(c);
    const body = await readBody(c, setConversationProjectRequestSchema);
    if (body.kind === "invalid") return body.response;
    if (deps.db === undefined) return notConfigured(c);
    const result = await setConversationProject(deps.db, id.data, body.data.projectId);
    switch (result.kind) {
      case "no_conversation":
        return noConversation(c);
      case "no_project":
        return noProject(c);
      case "set": {
        const response: ConversationProject = {
          conversationId: id.data,
          projectId: result.projectId,
        };
        c.var.log.info("conversation.project_set", response);
        return c.json(response);
      }
    }
  });

  api.get("/v1/roles", auth, async (c) => {
    if (deps.db === undefined) return notConfigured(c);
    const body: ActorRoleList = { roles: await listActorRoles(deps.db) };
    c.var.log.info("roles.listed", { count: body.roles.length });
    return c.json(body);
  });
}
