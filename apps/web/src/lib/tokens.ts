import {
  PERSON_TOKEN_AUDIENCE,
  PERSON_TOKEN_ISSUER,
  personTokenClaimsSchema,
} from "@hippidy/contracts";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";

// Three kinds of token, all HS256 JWTs (decision 194). Each has its own audience, so one can
// never pass for another:
// - the session cookie, signed with WEB_SESSION_SECRET, read only by this app;
// - the sign-in cookie, the same secret, holding `state` and `nonce` between the redirect to
//   Slack and the callback;
// - the person token, signed with WEB_API_SECRET, sent by this app's server to the API.

/** Who is signed in, as Slack said at sign-in. */
export interface Person {
  /** Slack user id. */
  actorId: string;
  /** Slack team id. */
  workspaceId: string;
  name: string;
}

const ISSUER = PERSON_TOKEN_ISSUER;
const SESSION_AUDIENCE = "hippidy-web-session";
const SIGN_IN_AUDIENCE = "hippidy-web-sign-in";

/** How long a session lasts. Nothing revokes one sooner, so it is a working day. */
export const SESSION_SECONDS = 8 * 60 * 60;
/** How long a person has to come back from Slack's consent screen. */
export const SIGN_IN_SECONDS = 10 * 60;
/** How long a person token lives; the API refuses any older than five minutes. */
export const API_TOKEN_SECONDS = 2 * 60;

const key = (secret: string) => new TextEncoder().encode(secret);
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

function sign(
  claims: Record<string, string>,
  options: { secret: string; audience: string; subject?: string; lifetime: number; now: Date },
): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(options.audience)
    .setIssuedAt(seconds(options.now))
    .setExpirationTime(seconds(options.now) + options.lifetime);
  return (options.subject === undefined ? jwt : jwt.setSubject(options.subject)).sign(
    key(options.secret),
  );
}

/** The payload of a valid token, or undefined for anything else. */
async function verify(
  token: string,
  options: { secret: string; audience: string; now: Date },
): Promise<Record<string, unknown> | undefined> {
  try {
    const { payload } = await jwtVerify(token, key(options.secret), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: options.audience,
      requiredClaims: ["iat", "exp"],
      currentDate: options.now,
    });
    return payload;
  } catch {
    return undefined;
  }
}

/** The session cookie's value for a person who just signed in. */
export function signSession(person: Person, secret: string, now = new Date()): Promise<string> {
  return sign(
    { team: person.workspaceId, name: person.name },
    { secret, audience: SESSION_AUDIENCE, subject: person.actorId, lifetime: SESSION_SECONDS, now },
  );
}

/**
 * The person of a session cookie, or undefined when it is missing, forged, expired, or for a
 * workspace other than the configured one.
 */
export async function readSession(
  value: string | undefined,
  options: { secret: string; workspaceId: string; now?: Date },
): Promise<Person | undefined> {
  if (value === undefined || value === "") return undefined;
  const payload = await verify(value, {
    secret: options.secret,
    audience: SESSION_AUDIENCE,
    now: options.now ?? new Date(),
  });
  const claims = personTokenClaimsSchema.safeParse(payload);
  if (!claims.success || claims.data.team !== options.workspaceId) return undefined;
  return { actorId: claims.data.sub, workspaceId: claims.data.team, name: claims.data.name };
}

/** What the sign-in cookie carries between `/auth/slack` and the callback. */
export interface SignInState {
  state: string;
  nonce: string;
}

const signInStateSchema = z.object({ state: z.string().min(16), nonce: z.string().min(16) });

export function signSignInState(
  value: SignInState,
  secret: string,
  now = new Date(),
): Promise<string> {
  return sign({ ...value }, { secret, audience: SIGN_IN_AUDIENCE, lifetime: SIGN_IN_SECONDS, now });
}

export async function readSignInState(
  value: string | undefined,
  secret: string,
  now = new Date(),
): Promise<SignInState | undefined> {
  if (value === undefined || value === "") return undefined;
  const parsed = signInStateSchema.safeParse(
    await verify(value, { secret, audience: SIGN_IN_AUDIENCE, now }),
  );
  return parsed.success ? { state: parsed.data.state, nonce: parsed.data.nonce } : undefined;
}

/**
 * A person token for one call to the API: who the person is, for the API only, from this
 * app, for two minutes. The browser never sees it.
 */
export function mintApiToken(person: Person, secret: string, now = new Date()): Promise<string> {
  return sign(
    { team: person.workspaceId, name: person.name },
    {
      secret,
      audience: PERSON_TOKEN_AUDIENCE,
      subject: person.actorId,
      lifetime: API_TOKEN_SECONDS,
      now,
    },
  );
}
