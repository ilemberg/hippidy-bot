import {
  actorRoleListSchema,
  actorRoleSchema,
  approvalResultSchema,
  errorResponseSchema,
  projectDetailSchema,
  projectListSchema,
} from "@hippidy/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../agent/fake.ts";
import { configureApp } from "../compose.ts";
import { findOrCreateConversation } from "../store/conversations.ts";
import { createTestDb } from "../store/testing.ts";
import { memoryLogger } from "../testing.ts";
import type { ConversationDeps } from "./conversations.ts";
import { RecordingDeliverer } from "./testing.ts";
import type { ApiEnv } from "./types.ts";

const token = "t".repeat(48);
const reconcileToken = "r".repeat(48);
const auth = { authorization: `Bearer ${token}` };
const json = { ...auth, "content-type": "application/json" };
const missing = "00000000-0000-4000-8000-000000000000";

let db: Awaited<ReturnType<typeof createTestDb>>;
let deps: ConversationDeps;

beforeEach(async () => {
  db = await createTestDb();
  deps = {
    db,
    runtime: new FakeAgentRuntime(),
    deliverers: { slack: new RecordingDeliverer() },
    sleep: () => Promise.resolve(),
  };
});

afterEach(async () => {
  await db.close();
});

function api(options: { storage: "configured" | "missing" } = { storage: "configured" }) {
  const { log } = memoryLogger();
  return configureApp(new Hono<ApiEnv>(), {
    env: { API_SERVICE_TOKEN: token, RECONCILE_TOKEN: reconcileToken },
    log,
    services: options.storage === "missing" ? {} : { conversations: deps },
  });
}

type App = ReturnType<typeof api>;

const send = (app: App, method: string, path: string, body: unknown) =>
  app.request(path, { method, headers: json, body: JSON.stringify(body) });

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(errorResponseSchema.parse(await res.json()).error.code).toBe(code);
}

const creator = { source: "slack", workspaceId: "T1", actorId: "U1" };

async function create(app: App, name = "Search") {
  const res = await send(app, "POST", "/v1/projects", { name, createdBy: creator });
  expect(res.status).toBe(201);
  return projectDetailSchema.parse(await res.json()).project;
}

async function setRole(app: App, actorId: string, role: string) {
  const res = await send(app, "PUT", "/v1/roles", {
    source: "slack",
    workspaceId: "T1",
    actorId,
    role,
  });
  expect(res.status).toBe(200);
  return actorRoleSchema.parse(await res.json());
}

async function approve(app: App, projectId: string, actorId: string, extra: object = {}) {
  const res = await send(app, "POST", `/v1/projects/${projectId}/approvals`, {
    subject: "plan",
    subjectRef: "doc-1",
    subjectVersion: "1",
    action: "approve",
    actor: { source: "slack", workspaceId: "T1", actorId },
    ...extra,
  });
  expect(res.status).toBe(201);
  return approvalResultSchema.parse(await res.json());
}

describe("projects", () => {
  it("creates a project in plan, lists it and reads it back", async () => {
    const app = api();
    const project = await create(app, "  Search  ");
    expect(project).toMatchObject({
      name: "Search",
      stage: "plan",
      createdBy: creator,
      mainConversationId: null,
    });

    const list = projectListSchema.parse(
      await (await app.request("/v1/projects", { headers: auth })).json(),
    );
    expect(list.projects).toEqual([project]);

    const res = await app.request(`/v1/projects/${project.id}`, { headers: auth });
    expect(res.status).toBe(200);
    expect(projectDetailSchema.parse(await res.json())).toEqual({
      project,
      approvals: [],
      planApproved: false,
    });
  });

  it("moves the stage in any direction", async () => {
    const app = api();
    const project = await create(app);
    for (const stage of ["ship", "roadmap", "end", "plan"]) {
      const res = await send(app, "PATCH", `/v1/projects/${project.id}`, { stage });
      expect(res.status).toBe(200);
      expect(projectDetailSchema.parse(await res.json()).project.stage).toBe(stage);
    }
  });

  it("answers 404 for a project that does not exist, or an id that is not one", async () => {
    const app = api();
    for (const id of [missing, "not-an-id"]) {
      await expectError(
        await app.request(`/v1/projects/${id}`, { headers: auth }),
        404,
        "not_found",
      );
      await expectError(
        await send(app, "PATCH", `/v1/projects/${id}`, { stage: "end" }),
        404,
        "not_found",
      );
      await expectError(
        await send(app, "POST", `/v1/projects/${id}/approvals`, {
          subject: "plan",
          action: "approve",
          actor: { source: "slack", workspaceId: "T1", actorId: "U1" },
        }),
        404,
        "not_found",
      );
    }
  });

  it("rejects a body it does not understand", async () => {
    const app = api();
    const project = await create(app);
    const bad: [string, string, unknown][] = [
      ["POST", "/v1/projects", { name: "", createdBy: creator }],
      ["POST", "/v1/projects", { name: "x".repeat(201), createdBy: creator }],
      ["POST", "/v1/projects", { name: "Search" }],
      ["POST", "/v1/projects", { name: "Search", createdBy: { ...creator, source: "irc" } }],
      ["POST", "/v1/projects", { name: "Search", createdBy: { source: "slack", actorId: "U1" } }],
      ["PATCH", `/v1/projects/${project.id}`, { stage: "done" }],
      ["PATCH", `/v1/projects/${project.id}`, { stage: "end", name: "Renamed" }],
      ["PUT", "/v1/roles", { source: "slack", workspaceId: "T1", actorId: "U1", role: "owner" }],
      ["PUT", "/v1/roles", { source: "slack", actorId: "U1", role: "qa" }],
      [
        "POST",
        `/v1/projects/${project.id}/approvals`,
        {
          subject: "plan",
          action: "reject",
          actor: { source: "slack", workspaceId: "T1", actorId: "U1" },
        },
      ],
      [
        "POST",
        `/v1/projects/${project.id}/approvals`,
        {
          subject: "design",
          action: "approve",
          actor: { source: "slack", workspaceId: "T1", actorId: "U1" },
        },
      ],
      ["POST", `/v1/projects/${project.id}/approvals`, { subject: "plan", action: "approve" }],
      [
        "POST",
        `/v1/projects/${project.id}/approvals`,
        {
          subject: "ticket",
          action: "approve",
          actor: { source: "slack", workspaceId: "T1", actorId: "U1" },
        },
      ],
      [
        "POST",
        `/v1/projects/${project.id}/approvals`,
        {
          subject: "ticket",
          subjectRef: "",
          action: "approve",
          actor: { source: "slack", workspaceId: "T1", actorId: "U1" },
        },
      ],
    ];
    for (const [method, path, body] of bad) {
      await expectError(await send(app, method, path, body), 400, "invalid_request");
    }
    await expectError(
      await app.request("/v1/projects", { method: "POST", headers: json, body: "{not json" }),
      400,
      "invalid_request",
    );
  });
});

describe("roles", () => {
  it("sets a role, replaces it, and lists the map", async () => {
    const app = api();
    await setRole(app, "U2", "qa");
    await setRole(app, "U1", "engineer");
    const replaced = await setRole(app, "U1", "product_manager");
    expect(replaced).toMatchObject({
      source: "slack",
      workspaceId: "T1",
      actorId: "U1",
      role: "product_manager",
    });
    const list = actorRoleListSchema.parse(
      await (await app.request("/v1/roles", { headers: auth })).json(),
    );
    expect(list.roles.map((r) => [r.actorId, r.role])).toEqual([
      ["U1", "product_manager"],
      ["U2", "qa"],
    ]);
  });
});

describe("approvals", () => {
  it("records approvals and says when the plan is approved, without moving the stage", async () => {
    const app = api();
    const project = await create(app);
    await setRole(app, "EM", "engineering_manager");
    await setRole(app, "PM", "product_manager");

    const first = await approve(app, project.id, "EM");
    expect(first.subjectApproved).toBe(false);
    expect(first.approval).toMatchObject({
      projectId: project.id,
      subject: "plan",
      subjectRef: "doc-1",
      subjectVersion: "1",
      action: "approve",
      actor: { source: "slack", workspaceId: "T1", actorId: "EM" },
      role: "engineering_manager",
      conversationId: null,
    });

    const second = await approve(app, project.id, "PM");
    expect(second.subjectApproved).toBe(true);

    const detail = projectDetailSchema.parse(
      await (await app.request(`/v1/projects/${project.id}`, { headers: auth })).json(),
    );
    expect(detail.planApproved).toBe(true);
    expect(detail.project.stage).toBe("plan");
    expect(detail.approvals.map((a) => a.id)).toEqual([first.approval.id, second.approval.id]);

    const withdrawn = await approve(app, project.id, "PM", { action: "withdraw" });
    expect(withdrawn.subjectApproved).toBe(false);
    expect(withdrawn.approval.action).toBe("withdraw");
  });

  it("answers 400, not a database error, for a ticket approval with no ticket", async () => {
    const app = api();
    const project = await create(app);
    const res = await send(app, "POST", `/v1/projects/${project.id}/approvals`, {
      subject: "ticket",
      action: "approve",
      actor: { source: "slack", workspaceId: "T1", actorId: "EM" },
    });
    expect(res.status).toBe(400);
    const body = errorResponseSchema.parse(await res.json());
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.issues?.map((i) => i.path)).toEqual(["subjectRef"]);
    const ticket = await approve(app, project.id, "EM", { subject: "ticket", subjectRef: "T-1" });
    expect(ticket.approval).toMatchObject({ subject: "ticket", subjectRef: "T-1" });
  });

  it("tells apart the same actor id in two workspaces", async () => {
    const app = api();
    const project = await create(app);
    await setRole(app, "EM", "engineering_manager");
    await setRole(app, "PM", "product_manager");
    await approve(app, project.id, "EM");
    await approve(app, project.id, "PM");
    const elsewhere = await approve(app, project.id, "PM", {
      action: "withdraw",
      actor: { source: "slack", workspaceId: "T2", actorId: "PM" },
    });
    expect(elsewhere.approval).toMatchObject({
      actor: { source: "slack", workspaceId: "T2", actorId: "PM" },
      role: null,
    });
    expect(elsewhere.subjectApproved).toBe(true);
  });

  it("records someone without a role, with no role", async () => {
    const app = api();
    const project = await create(app);
    const result = await approve(app, project.id, "U9", { subjectRef: undefined });
    expect(result.approval).toMatchObject({ role: null, subjectRef: "" });
    expect(result.subjectApproved).toBe(false);
  });

  it("keeps the conversation it was given in, and refuses one that does not exist", async () => {
    const app = api();
    const project = await create(app);
    const conversation = await findOrCreateConversation(db, {
      source: "slack",
      workspaceId: "T1",
      channelId: "C1",
      threadId: "1.1",
    });
    const result = await approve(app, project.id, "EM", { conversationId: conversation.id });
    expect(result.approval.conversationId).toBe(conversation.id);
    await expectError(
      await send(app, "POST", `/v1/projects/${project.id}/approvals`, {
        subject: "plan",
        action: "approve",
        actor: { source: "slack", workspaceId: "T1", actorId: "EM" },
        conversationId: missing,
      }),
      400,
      "invalid_request",
    );
  });
});

describe("who may use the project routes", () => {
  const routes: [string, string][] = [
    ["POST", "/v1/projects"],
    ["GET", "/v1/projects"],
    ["GET", `/v1/projects/${missing}`],
    ["PATCH", `/v1/projects/${missing}`],
    ["POST", `/v1/projects/${missing}/approvals`],
    ["PUT", "/v1/roles"],
    ["GET", "/v1/roles"],
  ];

  it("needs the service token; the reconcile token does not do", async () => {
    const app = api();
    for (const [method, route] of routes) {
      await expectError(await app.request(route, { method }), 401, "unauthorized");
      await expectError(
        await app.request(route, {
          method,
          headers: { authorization: `Bearer ${reconcileToken}` },
        }),
        401,
        "unauthorized",
      );
    }
  });

  it("answers 503 while storage is not configured", async () => {
    const app = api({ storage: "missing" });
    const bodies: Record<string, unknown> = {
      "/v1/projects": { name: "Search", createdBy: creator },
      [`/v1/projects/${missing}`]: { stage: "end" },
      [`/v1/projects/${missing}/approvals`]: {
        subject: "plan",
        action: "approve",
        actor: { source: "slack", workspaceId: "T1", actorId: "U1" },
      },
      "/v1/roles": { source: "slack", workspaceId: "T1", actorId: "U1", role: "qa" },
    };
    for (const [method, route] of routes) {
      const res =
        method === "GET"
          ? await app.request(route, { headers: auth })
          : await send(app, method, route, bodies[route]);
      await expectError(res, 503, "not_configured");
    }
  });
});
