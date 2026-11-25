import { describe, expect, it } from "vitest";
import { tokensMatch, verifyPersonToken } from "./auth.ts";
import {
  PERSON_SECRET,
  PERSON_WORKSPACE,
  signPersonToken,
  type PersonTokenOptions,
} from "./testing.ts";

describe("tokensMatch", () => {
  it("matches identical tokens", () => {
    expect(tokensMatch("x".repeat(40), "x".repeat(40))).toBe(true);
  });

  it("rejects different tokens of the same length", () => {
    expect(tokensMatch("x".repeat(40), "y".repeat(40))).toBe(false);
  });

  it("rejects tokens of different lengths without throwing", () => {
    expect(tokensMatch("x", "x".repeat(40))).toBe(false);
  });
});

const auth = { secret: PERSON_SECRET, workspaceId: PERSON_WORKSPACE };
const now = new Date("2026-11-25T12:00:00.000Z");
const personToken = (options: PersonTokenOptions = {}) =>
  signPersonToken({ issuedAt: now, ...options });

describe("verifyPersonToken", () => {
  it("accepts a token from the web app for a person of the workspace", async () => {
    expect(await verifyPersonToken(await personToken(), auth, now)).toEqual({
      kind: "accepted",
      caller: { kind: "person", workspaceId: "T0123456789", actorId: "U0123456789", name: "Ilya" },
    });
  });

  it.each([
    ["a bad signature", { secret: "x".repeat(48) }, "ERR_JWS_SIGNATURE_VERIFICATION_FAILED"],
    ["another workspace", { team: "T9999999999" }, "wrong_workspace"],
    ["another audience", { audience: "hippidy-web-session" }, "ERR_JWT_CLAIM_VALIDATION_FAILED"],
    ["another issuer", { issuer: "someone" }, "ERR_JWT_CLAIM_VALIDATION_FAILED"],
    ["another algorithm", { algorithm: "HS512" as const }, "ERR_JOSE_ALG_NOT_ALLOWED"],
    ["no name", { name: undefined }, "invalid_claims"],
  ])("rejects %s", async (_case, options: PersonTokenOptions, reason) => {
    expect(await verifyPersonToken(await personToken(options), auth, now)).toEqual({
      kind: "rejected",
      reason,
    });
  });

  it("rejects an expired token", async () => {
    const issuedAt = new Date(now.getTime() - 3 * 60_000);
    const check = await verifyPersonToken(await personToken({ issuedAt }), auth, now);
    expect(check).toEqual({ kind: "rejected", reason: "ERR_JWT_EXPIRED" });
  });

  it("rejects a token older than five minutes, whatever its expiry says", async () => {
    const issuedAt = new Date(now.getTime() - 6 * 60_000);
    const token = await personToken({ issuedAt, lifetimeSeconds: 3600 });
    expect(await verifyPersonToken(token, auth, now)).toEqual({
      kind: "rejected",
      reason: "ERR_JWT_EXPIRED",
    });
  });

  it("rejects what is not a token at all", async () => {
    expect(await verifyPersonToken("not-a-jwt", auth, now)).toEqual({
      kind: "rejected",
      reason: "ERR_JWS_INVALID",
    });
  });
});
