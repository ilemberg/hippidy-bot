import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { JWTVerifyGetKey } from "jose";
import type { WebConfig } from "./config.ts";
import {
  deleteCookie,
  readCookie,
  serializeCookie,
  SESSION_COOKIE,
  SIGN_IN_COOKIE,
  SIGN_IN_COOKIE_PATH,
} from "./cookies.ts";
import type { Logger } from "./log.ts";
import {
  authorizeUrl,
  callbackUrl,
  exchangeCode,
  checkMember,
  TokenExchangeError,
  verifyIdToken,
  type Fetch,
} from "./slack-oidc.ts";
import {
  readSignInState,
  SESSION_SECONDS,
  SIGN_IN_SECONDS,
  signSession,
  signSignInState,
} from "./tokens.ts";

// The three sign-in routes, over the web's standard Request and Response so they can be
// tested without Next.js. The route files in `src/app` only pass the real dependencies in.

export interface AuthDeps {
  /** Undefined when a variable is missing or bad: sign-in is off. */
  config: WebConfig | undefined;
  log: Logger;
  /** For the token exchange with Slack. */
  fetch: Fetch;
  /** Slack's signing keys: its JWKS in production, a local set in tests. */
  keys: JWTVerifyGetKey;
  now?: () => Date;
}

/** What the home page says after a sign-in that did not end in a session. */
export const signInNotices = ["unavailable", "cancelled", "failed", "not_in_workspace"] as const;
export type SignInNotice = (typeof signInNotices)[number];

const randomToken = () => randomBytes(32).toString("base64url");

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
const sameText = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

function redirect(location: string, cookies: string[] = [], status = 302): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status, headers });
}

function home(request: Request, config: WebConfig | undefined, notice?: SignInNotice): string {
  const url = new URL("/", config?.webBaseUrl ?? request.url);
  if (notice !== undefined) url.searchParams.set("signin", notice);
  return url.toString();
}

/** `GET /auth/slack`: sends the person to Slack with a fresh state and nonce. */
export async function startSignIn(request: Request, deps: AuthDeps): Promise<Response> {
  const log = deps.log.child({ correlationId: randomUUID() });
  const config = deps.config;
  if (config === undefined) {
    log.warn("signin.unavailable", { reason: "not_configured" });
    return redirect(home(request, config, "unavailable"));
  }
  const state = randomToken();
  const nonce = randomToken();
  const now = deps.now?.() ?? new Date();
  const cookie = await signSignInState({ state, nonce }, config.sessionSecret, now);
  log.info("signin.started", {});
  return redirect(
    authorizeUrl({
      clientId: config.slack.clientId,
      redirectUri: callbackUrl(config.webBaseUrl),
      workspaceId: config.slack.workspaceId,
      state,
      nonce,
    }),
    [
      serializeCookie(SIGN_IN_COOKIE, cookie, {
        path: SIGN_IN_COOKIE_PATH,
        maxAge: SIGN_IN_SECONDS,
      }),
    ],
  );
}

/**
 * `GET /auth/slack/callback`: checks the state against the sign-in cookie, swaps the code
 * for Slack's id token, checks the token (signature, issuer, audience, expiry, nonce,
 * workspace) and starts a session. Every way out clears the sign-in cookie.
 */
export async function finishSignIn(request: Request, deps: AuthDeps): Promise<Response> {
  const log = deps.log.child({ correlationId: randomUUID() });
  const config = deps.config;
  const url = new URL(request.url);
  const clear = deleteCookie(SIGN_IN_COOKIE, SIGN_IN_COOKIE_PATH);
  const fail = (notice: SignInNotice, reason: string, fields: Record<string, string> = {}) => {
    log.warn("signin.rejected", { reason, ...fields });
    return redirect(home(request, config, notice), [clear]);
  };

  if (config === undefined) return fail("unavailable", "not_configured");
  const slackError = url.searchParams.get("error");
  if (slackError !== null) {
    // From the URL, so anyone can put anything there: only a plain code is logged.
    const error = /^[\w.-]{1,64}$/.test(slackError) ? slackError : "other";
    return fail("cancelled", "slack_error", { error });
  }

  const now = deps.now?.() ?? new Date();
  const saved = await readSignInState(
    readCookie(request.headers.get("cookie"), SIGN_IN_COOKIE),
    config.sessionSecret,
    now,
  );
  if (saved === undefined) return fail("failed", "no_sign_in_cookie");
  const state = url.searchParams.get("state");
  if (state === null || !sameText(state, saved.state)) return fail("failed", "state_mismatch");
  const code = url.searchParams.get("code");
  if (code === null || code === "") return fail("failed", "no_code");

  let idToken: string;
  try {
    idToken = await exchangeCode({
      fetch: deps.fetch,
      clientId: config.slack.clientId,
      clientSecret: config.slack.clientSecret,
      code,
      redirectUri: callbackUrl(config.webBaseUrl),
    });
  } catch (error) {
    if (!(error instanceof TokenExchangeError)) throw error;
    return fail("failed", "token_exchange_failed", { detail: error.message });
  }

  const check = await verifyIdToken(idToken, {
    keys: deps.keys,
    clientId: config.slack.clientId,
    nonce: saved.nonce,
    workspaceId: config.slack.workspaceId,
    now,
  });
  if (check.kind === "rejected") {
    return fail(
      check.reason === "wrong_workspace" ? "not_in_workspace" : "failed",
      check.reason,
      check.detail === undefined ? {} : { detail: check.detail },
    );
  }

  // A guest gets the workspace's team id too; only full members may sign in (decision 196).
  const member = await checkMember({
    fetch: deps.fetch,
    botToken: config.slack.botToken,
    userId: check.person.actorId,
  });
  if (member.kind === "not_member") return fail("not_in_workspace", member.reason);
  if (member.kind === "unknown") {
    return fail("unavailable", "member_check_failed", { detail: member.detail });
  }

  const session = await signSession(check.person, config.sessionSecret, now);
  log.info("signin.succeeded", {
    actorId: check.person.actorId,
    workspaceId: check.person.workspaceId,
  });
  return redirect(home(request, config), [
    clear,
    serializeCookie(SESSION_COOKIE, session, { path: "/", maxAge: SESSION_SECONDS }),
  ]);
}

/**
 * `POST /auth/signout`: ends the session in this browser. Only from this app's own pages: a
 * form on another site would otherwise sign people out (the browser's `Origin`, or
 * `Sec-Fetch-Site`, says where the form was).
 */
export function signOut(request: Request, deps: Pick<AuthDeps, "config" | "log">): Response {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  const sameOrigin =
    site === "same-origin" || (origin !== null && origin === deps.config?.webBaseUrl);
  if (!sameOrigin) {
    deps.log.warn("signin.signout_refused", { reason: "cross_origin" });
    return new Response("Sign-out must come from this app.", { status: 403 });
  }
  deps.log.info("signin.signed_out", { correlationId: randomUUID() });
  return redirect(home(request, deps.config), [deleteCookie(SESSION_COOKIE, "/")], 303);
}
