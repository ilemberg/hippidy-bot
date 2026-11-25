import { describe, expect, it } from "vitest";
import { meResponseSchema, personTokenClaimsSchema } from "./me.ts";

describe("meResponseSchema", () => {
  it("accepts a person and a service", () => {
    const person = { kind: "person", workspaceId: "T1", actorId: "U1", name: "Ilya" };
    expect(meResponseSchema.parse(person)).toEqual(person);
    expect(meResponseSchema.parse({ kind: "service" })).toEqual({ kind: "service" });
  });

  it("refuses a service that names a person, and an unknown kind", () => {
    expect(meResponseSchema.safeParse({ kind: "service", actorId: "U1" }).success).toBe(false);
    expect(meResponseSchema.safeParse({ kind: "robot" }).success).toBe(false);
  });
});

describe("personTokenClaimsSchema", () => {
  it("needs a subject, a workspace and a name", () => {
    const claims = { sub: "U1", team: "T1", name: "A" };
    expect(personTokenClaimsSchema.safeParse(claims).success).toBe(true);
    expect(personTokenClaimsSchema.safeParse({ ...claims, name: undefined }).success).toBe(false);
    expect(personTokenClaimsSchema.safeParse({ ...claims, sub: "" }).success).toBe(false);
  });
});
