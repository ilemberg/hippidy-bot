import { PERSON_TOKEN_MAX_AGE_SECONDS } from "@hippidy/contracts";
import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { config } from "./testing.ts";
import { mintApiToken, readSession, signSession, type Person } from "./tokens.ts";

const person: Person = { actorId: "U0123456789", workspaceId: "T0123456789", name: "Ilya" };
const now = new Date("2026-11-25T12:00:00.000Z");
const read = (value: string | undefined, at = now) =>
  readSession(value, {
    secret: config.sessionSecret,
    workspaceId: config.slack.workspaceId,
    now: at,
  });

describe("the session", () => {
  it("round-trips the person", async () => {
    expect(await read(await signSession(person, config.sessionSecret, now))).toEqual(person);
  });

  it("is refused when missing, tampered with, signed with another secret, or expired", async () => {
    const session = await signSession(person, config.sessionSecret, now);
    expect(await read(undefined)).toBeUndefined();
    expect(await read("")).toBeUndefined();
    const [header, , signature] = session.split(".");
    const payload = Buffer.from(
      JSON.stringify({ ...decodeJwt(session), name: "Someone else" }),
    ).toString("base64url");
    expect(await read(`${header ?? ""}.${payload}.${signature ?? ""}`)).toBeUndefined();
    expect(await read(await signSession(person, "z".repeat(48), now))).toBeUndefined();
    expect(await read(session, new Date(now.getTime() + 8 * 3600_000 + 1000))).toBeUndefined();
  });

  it("is refused for another workspace than the configured one", async () => {
    const elsewhere = { ...person, workspaceId: "T9999999999" };
    expect(await read(await signSession(elsewhere, config.sessionSecret, now))).toBeUndefined();
  });

  it("cannot pass for a person token, even signed with the API's secret", async () => {
    const session = await signSession(person, config.apiSecret, now);
    await expect(
      jwtVerify(session, new TextEncoder().encode(config.apiSecret), {
        audience: "hippidy-api",
        currentDate: now,
      }),
    ).rejects.toThrow();
  });
});

describe("the person token for the API", () => {
  it("carries the person, for the API, from the web app, for two minutes", async () => {
    const token = await mintApiToken(person, config.apiSecret, now);
    expect(decodeProtectedHeader(token)).toEqual({ alg: "HS256", typ: "JWT" });
    const { payload } = await jwtVerify(token, new TextEncoder().encode(config.apiSecret), {
      algorithms: ["HS256"],
      currentDate: now,
    });
    const iat = Math.floor(now.getTime() / 1000);
    expect(payload).toEqual({
      sub: "U0123456789",
      team: "T0123456789",
      name: "Ilya",
      aud: "hippidy-api",
      iss: "hippidy-web",
      iat,
      exp: iat + 120,
    });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBeLessThanOrEqual(
      PERSON_TOKEN_MAX_AGE_SECONDS,
    );
  });

  it("is signed with the API secret, not the session's", async () => {
    const token = await mintApiToken(person, config.apiSecret, now);
    await expect(
      jwtVerify(token, new TextEncoder().encode(config.sessionSecret), { currentDate: now }),
    ).rejects.toThrow();
  });
});
