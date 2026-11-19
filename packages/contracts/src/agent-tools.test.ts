import { describe, expect, it } from "vitest";
import { linkProjectInputSchema, recordApprovalInputSchema } from "./agent-tools.ts";

const id = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";

describe("linkProjectInputSchema", () => {
  it("takes a project id or a trimmed name", () => {
    expect(linkProjectInputSchema.parse({ projectId: id })).toEqual({ projectId: id });
    expect(linkProjectInputSchema.parse({ name: " Search " })).toEqual({ name: "Search" });
  });

  it("needs exactly one of the two, and nothing else", () => {
    for (const input of [
      {},
      { projectId: id, name: "Search" },
      { name: "  " },
      { projectId: "not-a-uuid" },
      { name: "Search", stage: "ship" },
      { name: "a\u0000b" },
    ]) {
      expect(linkProjectInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });
});

describe("recordApprovalInputSchema", () => {
  it("fills in an empty ref and version", () => {
    expect(
      recordApprovalInputSchema.parse({
        subject: "plan",
        action: "approve",
        actor: { actorId: "U1" },
      }),
    ).toEqual({
      subject: "plan",
      subjectRef: "",
      subjectVersion: "",
      action: "approve",
      actor: { actorId: "U1" },
    });
  });

  it("refuses a ticket without its ticket, an unknown action, and a full actor", () => {
    for (const input of [
      { subject: "ticket", action: "approve", actor: { actorId: "U1" } },
      { subject: "plan", action: "maybe", actor: { actorId: "U1" } },
      { subject: "plan", action: "approve", actor: { actorId: "" } },
      {
        subject: "plan",
        action: "approve",
        actor: { source: "slack", workspaceId: "T2", actorId: "U1" },
      },
    ]) {
      expect(recordApprovalInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });
});
