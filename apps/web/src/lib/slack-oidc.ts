import { errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import type { Person } from "./tokens.ts";

// Sign in with Slack, OpenID Connect (decision 193):
// https://docs.slack.dev/authentication/sign-in-with-slack/

export const SLACK_AUTHORIZE_URL = "https://slack.com/openid/connect/authorize";
export const SLACK_TOKEN_URL = "https://slack.com/api/openid.connect.token";
export const SLACK_JWKS_URL = "https://slack.com/openid/connect/keys";
export const SLACK_ISSUER = "https://slack.com";
export const SLACK_SCOPES = "openid profile email";
/** The claim that names the workspace a person signed in to. */
export const SLACK_TEAM_CLAIM = "https://slack.com/team_id";

/** Where Slack sends a person back to after the consent screen. */
export const callbackUrl = (webBaseUrl: string): string =>
  new URL("/auth/slack/callback", webBaseUrl).toString();

/**
 * Slack's authorize URL. `team` sends the person straight to the configured workspace; the
 * callback still checks the workspace in the id token, since a person can change the URL.
 */
export function authorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  workspaceId: string;
  state: string;
  nonce: string;
}): string {
  const url = new URL(SLACK_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SLACK_SCOPES);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", options.state);
  url.searchParams.set("nonce", options.nonce);
  url.searchParams.set("team", options.workspaceId);
  return url.toString();
}

/** The part of `fetch` the token exchange uses; tests pass a fake. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const tokenResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), id_token: z.string().min(1) }),
  z.object({ ok: z.literal(false), error: z.string().max(200) }),
]);

export class TokenExchangeError extends Error {
  override readonly name = "TokenExchangeError";
}

/** Swaps the code from the callback for Slack's id token. Throws `TokenExchangeError`. */
export async function exchangeCode(options: {
  fetch: Fetch;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<string> {
  let res: Response;
  try {
    res = await options.fetch(SLACK_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        code: options.code,
        redirect_uri: options.redirectUri,
        grant_type: "authorization_code",
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new TokenExchangeError("request_failed", { cause: error });
  }
  if (!res.ok) throw new TokenExchangeError(`http_${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new TokenExchangeError("not_json");
  }
  const parsed = tokenResponseSchema.safeParse(body);
  if (!parsed.success) throw new TokenExchangeError("unexpected_response");
  // Slack's error codes (`invalid_code`, `bad_redirect_uri`, ...) hold no secret.
  if (!parsed.data.ok) throw new TokenExchangeError(parsed.data.error);
  return parsed.data.id_token;
}

const idTokenClaimsSchema = z.object({
  sub: z.string().min(1).max(255),
  nonce: z.string(),
  name: z.string().min(1).max(255),
  [SLACK_TEAM_CLAIM]: z.string().min(1).max(255),
});

export type IdTokenCheck =
  | { kind: "accepted"; person: Person }
  | {
      kind: "rejected";
      reason: "bad_token" | "bad_claims" | "nonce_mismatch" | "wrong_workspace";
      detail?: string;
    };

/**
 * Checks Slack's id token: signed by one of Slack's keys, issued by Slack for this app, not
 * expired, carrying the nonce this browser was given, and for the configured workspace.
 */
export async function verifyIdToken(
  idToken: string,
  options: {
    keys: JWTVerifyGetKey;
    clientId: string;
    nonce: string;
    workspaceId: string;
    now?: Date;
  },
): Promise<IdTokenCheck> {
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(idToken, options.keys, {
      issuer: SLACK_ISSUER,
      audience: options.clientId,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", "iat", "nonce"],
      currentDate: options.now ?? new Date(),
    }));
  } catch (error) {
    return {
      kind: "rejected",
      reason: "bad_token",
      detail: error instanceof errors.JOSEError ? error.code : "invalid_token",
    };
  }
  const claims = idTokenClaimsSchema.safeParse(payload);
  if (!claims.success) return { kind: "rejected", reason: "bad_claims" };
  if (claims.data.nonce !== options.nonce) return { kind: "rejected", reason: "nonce_mismatch" };
  if (claims.data[SLACK_TEAM_CLAIM] !== options.workspaceId) {
    return { kind: "rejected", reason: "wrong_workspace" };
  }
  return {
    kind: "accepted",
    person: {
      actorId: claims.data.sub,
      workspaceId: claims.data[SLACK_TEAM_CLAIM],
      name: claims.data.name,
    },
  };
}
