import { createHash, timingSafeEqual } from "node:crypto";
import {
  PERSON_TOKEN_AUDIENCE,
  PERSON_TOKEN_ISSUER,
  PERSON_TOKEN_MAX_AGE_SECONDS,
  personTokenClaimsSchema,
} from "@hippidy/contracts";
import type { Context, MiddlewareHandler } from "hono";
import { errors, jwtVerify, type JWTPayload } from "jose";
import type { PersonAuthConfig } from "../config.ts";
import { errorResponse } from "./errors.ts";
import type { ApiEnv, Caller } from "./types.ts";

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/** Compares in constant time. Hashing first hides the length of the expected token. */
export function tokensMatch(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

/** Leeway for the clocks of the web app's server and the API, in seconds. */
const CLOCK_TOLERANCE_SECONDS = 10;

export type PersonTokenCheck =
  | { kind: "accepted"; caller: Extract<Caller, { kind: "person" }> }
  | { kind: "rejected"; reason: string };

/**
 * Checks a person token from the web app's server (decision 194): an HS256 JWT signed with
 * the shared secret, for this API, from the web app, at most five minutes old, for a person
 * of the configured workspace. The reason of a rejection never contains the token.
 */
export async function verifyPersonToken(
  token: string,
  auth: PersonAuthConfig,
  now: Date = new Date(),
): Promise<PersonTokenCheck> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, new TextEncoder().encode(auth.secret), {
      algorithms: ["HS256"],
      audience: PERSON_TOKEN_AUDIENCE,
      issuer: PERSON_TOKEN_ISSUER,
      requiredClaims: ["sub", "iat", "exp"],
      maxTokenAge: PERSON_TOKEN_MAX_AGE_SECONDS,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: now,
    }));
  } catch (error) {
    return {
      kind: "rejected",
      reason: error instanceof errors.JOSEError ? error.code : "invalid_token",
    };
  }
  const claims = personTokenClaimsSchema.safeParse(payload);
  if (!claims.success) return { kind: "rejected", reason: "invalid_claims" };
  if (claims.data.team !== auth.workspaceId) return { kind: "rejected", reason: "wrong_workspace" };
  return {
    kind: "accepted",
    caller: {
      kind: "person",
      workspaceId: claims.data.team,
      actorId: claims.data.sub,
      name: claims.data.name,
    },
  };
}

type Bearer = { kind: "token"; token: string } | { kind: "missing"; reason: string };

function readBearer(c: Context<ApiEnv>): Bearer {
  const header = c.req.header("authorization");
  if (header === undefined) return { kind: "missing", reason: "missing_token" };
  const token = /^Bearer (\S+)$/i.exec(header)?.[1];
  return token === undefined
    ? { kind: "missing", reason: "malformed_header" }
    : { kind: "token", token };
}

/**
 * Requires `Authorization: Bearer <token>`. Fails closed: with no token configured, every
 * request is rejected.
 */
export function requireServiceToken(expected: string | undefined): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (expected === undefined) {
      c.var.log.error("auth.rejected", { reason: "service_token_not_configured" });
      return errorResponse(c, 401, "unauthorized", "Missing or invalid service token");
    }
    const bearer = readBearer(c);
    if (bearer.kind === "missing" || !tokensMatch(bearer.token, expected)) {
      c.var.log.warn("auth.rejected", {
        reason: bearer.kind === "missing" ? bearer.reason : "wrong_token",
      });
      return errorResponse(c, 401, "unauthorized", "Missing or invalid service token");
    }
    c.set("caller", { kind: "service" });
    await next();
    return;
  };
}

/**
 * Accepts the service token or a person token (decision 194). Each fails closed on its own:
 * with no service token configured only person tokens can pass, and with no person auth
 * configured only the service token can. The person is put on the context as `caller`, and
 * every later log line of the request names them.
 */
export function requireServiceOrPerson(
  serviceToken: string | undefined,
  personAuth: PersonAuthConfig | undefined,
): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const reject = (reason: string, fields: Record<string, string> = {}) => {
      c.var.log.warn("auth.rejected", { reason, ...fields });
      return errorResponse(c, 401, "unauthorized", "Missing or invalid token");
    };
    if (serviceToken === undefined && personAuth === undefined) {
      c.var.log.error("auth.rejected", { reason: "auth_not_configured" });
      return errorResponse(c, 401, "unauthorized", "Missing or invalid token");
    }
    const bearer = readBearer(c);
    if (bearer.kind === "missing") return reject(bearer.reason);
    if (serviceToken !== undefined && tokensMatch(bearer.token, serviceToken)) {
      c.set("caller", { kind: "service" });
      await next();
      return;
    }
    if (personAuth === undefined) return reject("wrong_token", { personAuth: "not_configured" });
    const check = await verifyPersonToken(bearer.token, personAuth);
    if (check.kind === "rejected") return reject("invalid_person_token", { detail: check.reason });
    c.set("caller", check.caller);
    c.set("log", c.var.log.child({ actorId: check.caller.actorId }));
    await next();
    return;
  };
}
