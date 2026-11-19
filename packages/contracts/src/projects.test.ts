import { describe, expect, it } from "vitest";
import {
  createProjectRequestSchema,
  recordApprovalRequestSchema,
  setRoleRequestSchema,
  updateProjectRequestSchema,
} from "./projects.ts";

const actor = { source: "slack", workspaceId: "T1", actorId: "U1" };

describe("createProjectRequestSchema", () => {
  it("trims the name and keeps it within bounds", () => {
    const createdBy = actor;
    expect(createProjectRequestSchema.parse({ name: " Search ", createdBy })).toEqual({
      name: "Search",
      createdBy,
    });
    for (const name of ["", "   ", "x".repeat(201)]) {
      expect(createProjectRequestSchema.safeParse({ name, createdBy }).success, name).toBe(false);
    }
  });

  it("does not take a stage: a project starts in plan", () => {
    expect(
      createProjectRequestSchema.safeParse({
        name: "Search",
        createdBy: actor,
        stage: "ship",
      }).success,
    ).toBe(false);
  });

  it("needs the creator's workspace", () => {
    for (const createdBy of [
      { source: "slack", actorId: "U1" },
      { source: "slack", workspaceId: "", actorId: "U1" },
    ]) {
      expect(createProjectRequestSchema.safeParse({ name: "Search", createdBy }).success).toBe(
        false,
      );
    }
  });
});

describe("updateProjectRequestSchema", () => {
  it("takes any of the four stages, and nothing else", () => {
    for (const stage of ["plan", "roadmap", "ship", "end"]) {
      expect(updateProjectRequestSchema.parse({ stage })).toEqual({ stage });
    }
    expect(updateProjectRequestSchema.safeParse({ stage: "done" }).success).toBe(false);
    expect(updateProjectRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("setRoleRequestSchema", () => {
  it("takes one of the six roles", () => {
    for (const role of [
      "engineering_manager",
      "product_manager",
      "tech_lead",
      "engineer",
      "qa",
      "designer",
    ]) {
      expect(setRoleRequestSchema.parse({ ...actor, role }).role).toBe(role);
    }
    expect(setRoleRequestSchema.safeParse({ ...actor, role: "owner" }).success).toBe(false);
    expect(setRoleRequestSchema.safeParse({ ...actor, actorId: "", role: "qa" }).success).toBe(
      false,
    );
  });
});

describe("recordApprovalRequestSchema", () => {
  it("defaults the reference and version to empty", () => {
    expect(
      recordApprovalRequestSchema.parse({ subject: "plan", action: "approve", actor }),
    ).toEqual({ subject: "plan", subjectRef: "", subjectVersion: "", action: "approve", actor });
  });

  it("takes a conversation id, and rejects what it does not know", () => {
    const conversationId = "00000000-0000-0000-0000-000000000001";
    expect(
      recordApprovalRequestSchema.parse({
        subject: "end",
        action: "withdraw",
        actor,
        conversationId,
      }).conversationId,
    ).toBe(conversationId);
    for (const body of [
      { subject: "plan", action: "reject", actor },
      { subject: "design", action: "approve", actor },
      { subject: "plan", action: "approve", actor, conversationId: "thread-1" },
      { subject: "plan", action: "approve", actor: { source: "slack", actorId: "U1" } },
      { subject: "plan", action: "approve", actor, role: "engineering_manager" },
    ]) {
      expect(recordApprovalRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it("needs a ticket approval to name its ticket", () => {
    for (const subjectRef of [undefined, "", "   "]) {
      const parsed = recordApprovalRequestSchema.safeParse({
        subject: "ticket",
        subjectRef,
        action: "approve",
        actor,
      });
      expect(parsed.success, String(subjectRef)).toBe(false);
      expect(parsed.error?.issues.map((i) => i.path.join("."))).toEqual(["subjectRef"]);
    }
    expect(
      recordApprovalRequestSchema.parse({
        subject: "ticket",
        subjectRef: "T-1",
        action: "approve",
        actor,
      }).subjectRef,
    ).toBe("T-1");
  });
});

describe("request text", () => {
  const actor = { source: "slack", workspaceId: "T1", actorId: "U1" } as const;

  it("refuses a null character, so the database never sees one", () => {
    expect(
      createProjectRequestSchema.safeParse({ name: "a\u0000b", createdBy: actor }).success,
    ).toBe(false);
    expect(
      recordApprovalRequestSchema.safeParse({
        subject: "plan",
        subjectRef: "doc\u0000",
        action: "approve",
        actor,
      }).success,
    ).toBe(false);
  });

  it("trims a ticket's ref, so the same ticket is one ticket", () => {
    const parsed = recordApprovalRequestSchema.parse({
      subject: "ticket",
      subjectRef: " T-1 ",
      action: "approve",
      actor,
    });
    expect(parsed.subjectRef).toBe("T-1");
  });
});
