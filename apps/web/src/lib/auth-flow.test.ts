import { beforeAll, describe, expect, it } from "vitest";
import { finishSignIn, signOut, startSignIn, type AuthDeps } from "./auth-flow.ts";
import { readCookie, SESSION_COOKIE, SIGN_IN_COOKIE } from "./cookies.ts";
import { memoryLogger, type LogFields } from "./log.ts";
import { SLACK_TOKEN_URL, type Fetch } from "./slack-oidc.ts";
import { config, slackIdToken, slackKeys, type IdTokenOptions, type SlackKeys } from "./testing.ts";
import { readSession, signSignInState } from "./tokens.ts";

let slack: SlackKeys;
let impostor: SlackKeys;

beforeAll(async () => {
  slack = await slackKeys();
  // Same key id, different key: what a forged token signed by someone else looks like.
  impostor = await slackKeys(slack.kid);
});

const web = (path: string, cookie?: string) =>
  new Request(
    new URL(path, config.webBaseUrl),
    cookie === undefined ? {} : { headers: { cookie } },
  );

/** A fake of Slack's token endpoint that answers with `idToken`, and records what it got. */
function slackTokenEndpoint(idToken: () => Promise<string>) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, body: new URLSearchParams(typeof init.body === "string" ? init.body : "") });
    return Response.json({ ok: true, access_token: "xoxp-unused", id_token: await idToken() });
  };
  return { fetch, calls };
}

function deps(overrides: Partial<AuthDeps> = {}): AuthDeps & { lines: LogFields[] } {
  const { log, lines } = memoryLogger();
  const refuse: Fetch = () => Promise.reject(new Error("no network in tests"));
  return { config, log, fetch: refuse, keys: slack.keys, lines, ...overrides };
}

/** The first leg: what `/auth/slack` sent the browser to Slack with. */
async function begin() {
  const res = await startSignIn(web("/auth/slack"), deps());
  const location = new URL(res.headers.get("location") ?? "");
  const setCookie = res.headers.getSetCookie()[0] ?? "";
  const cookieValue = readCookie(setCookie.split(";")[0] ?? "", SIGN_IN_COOKIE) ?? "";
  return {
    res,
    location,
    setCookie,
    cookie: `${SIGN_IN_COOKIE}=${cookieValue}`,
    state: location.searchParams.get("state") ?? "",
    nonce: location.searchParams.get("nonce") ?? "",
  };
}

/** The second leg: Slack sends the browser back; its token endpoint answers with a token. */
async function callback(
  options: {
    token?: (nonce: string) => Promise<string>;
    state?: (state: string) => string;
    cookie?: (cookie: string) => string | undefined;
  } = {},
) {
  const started = await begin();
  const token =
    options.token ?? ((nonce: string) => slackIdToken(slack, { nonce } satisfies IdTokenOptions));
  const endpoint = slackTokenEndpoint(() => token(started.nonce));
  const d = deps({ fetch: endpoint.fetch });
  const state = options.state?.(started.state) ?? started.state;
  const cookie = options.cookie === undefined ? started.cookie : options.cookie(started.cookie);
  const res = await finishSignIn(
    web(`/auth/slack/callback?code=the-code&state=${encodeURIComponent(state)}`, cookie),
    d,
  );
  return { res, lines: d.lines, calls: endpoint.calls, started };
}

const sessionCookieOf = (res: Response) =>
  res.headers.getSetCookie().find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));

function expectRejected(res: Response, notice: string) {
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(`${config.webBaseUrl}/?signin=${notice}`);
  expect(sessionCookieOf(res)).toBeUndefined();
  // The sign-in cookie is spent either way.
  expect(res.headers.getSetCookie()).toContainEqual(
    expect.stringMatching(/^hippidy_sign_in=;.*Max-Age=0/),
  );
}

describe("GET /auth/slack", () => {
  it("sends the person to Slack's OpenID Connect page for the one workspace", async () => {
    const { res, location, state, nonce } = await begin();
    expect(res.status).toBe(302);
    expect(`${location.origin}${location.pathname}`).toBe(
      "https://slack.com/openid/connect/authorize",
    );
    expect(Object.fromEntries(location.searchParams)).toEqual({
      response_type: "code",
      scope: "openid profile email",
      client_id: config.slack.clientId,
      redirect_uri: "https://web.example.test/auth/slack/callback",
      state,
      nonce,
      team: config.slack.workspaceId,
    });
    expect(state).toMatch(/^[\w-]{43}$/);
    expect(nonce).toMatch(/^[\w-]{43}$/);
    expect(nonce).not.toBe(state);
  });

  it("keeps state and nonce in a short-lived HttpOnly, SameSite=Lax cookie for the callback only", async () => {
    const { setCookie, location } = await begin();
    expect(setCookie).toMatch(
      /^hippidy_sign_in=[\w.-]+; Path=\/auth\/slack\/callback; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/,
    );
    // The cookie is signed, not the bare values, so a page cannot plant its own.
    expect(setCookie).not.toContain(location.searchParams.get("state") ?? "");
  });

  it("says sign-in is unavailable when not configured", async () => {
    const res = await startSignIn(web("/auth/slack"), deps({ config: undefined }));
    expect(res.headers.get("location")).toBe(`${config.webBaseUrl}/?signin=unavailable`);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe("GET /auth/slack/callback", () => {
  it("swaps the code, checks the token and starts a session", async () => {
    const { res, calls } = await callback();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${config.webBaseUrl}/`);
    const session = sessionCookieOf(res) ?? "";
    expect(session).toMatch(
      /^hippidy_session=[\w.-]+; Path=\/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(SLACK_TOKEN_URL);
    expect(Object.fromEntries(calls[0]?.body ?? [])).toEqual({
      client_id: config.slack.clientId,
      client_secret: config.slack.clientSecret,
      code: "the-code",
      redirect_uri: "https://web.example.test/auth/slack/callback",
      grant_type: "authorization_code",
    });

    // The round trip: the cookie the browser got back names the person.
    const value = readCookie(session.split(";")[0] ?? "", SESSION_COOKIE);
    expect(
      await readSession(value, {
        secret: config.sessionSecret,
        workspaceId: config.slack.workspaceId,
      }),
    ).toEqual({ actorId: "U0123456789", workspaceId: "T0123456789", name: "Ilya" });
  });

  it("refuses a state that is not the one it sent", async () => {
    const { res, calls, lines } = await callback({ state: () => "x".repeat(43) });
    expectRejected(res, "failed");
    expect(calls).toEqual([]);
    expect(lines).toContainEqual(expect.objectContaining({ reason: "state_mismatch" }));
  });

  it("refuses a callback with no sign-in cookie, or a forged one", async () => {
    expectRejected((await callback({ cookie: () => undefined })).res, "failed");
    const forged = await signSignInState(
      { state: "s".repeat(43), nonce: "n".repeat(43) },
      "f".repeat(48),
    );
    const { res, lines } = await callback({
      state: () => "s".repeat(43),
      cookie: () => `${SIGN_IN_COOKIE}=${forged}`,
    });
    expectRejected(res, "failed");
    expect(lines).toContainEqual(expect.objectContaining({ reason: "no_sign_in_cookie" }));
  });

  it("refuses a sign-in cookie older than ten minutes", async () => {
    const started = await begin();
    const d = deps({ now: () => new Date(Date.now() + 11 * 60_000) });
    const res = await finishSignIn(
      web(`/auth/slack/callback?code=c&state=${started.state}`, started.cookie),
      d,
    );
    expectRejected(res, "failed");
  });

  it("refuses a token whose nonce is not this browser's", async () => {
    const { res, lines } = await callback({
      token: () => slackIdToken(slack, { nonce: "n".repeat(43) }),
    });
    expectRejected(res, "failed");
    expect(lines).toContainEqual(expect.objectContaining({ reason: "nonce_mismatch" }));
  });

  it("refuses a person from another workspace", async () => {
    const { res, lines } = await callback({
      token: (nonce) => slackIdToken(slack, { nonce, team: "T9999999999" }),
    });
    expectRejected(res, "not_in_workspace");
    expect(lines).toContainEqual(expect.objectContaining({ reason: "wrong_workspace" }));
  });

  it.each([
    [
      "signed with a key that is not Slack's",
      { key: "impostor" },
      "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
    ],
    ["for another app", { audience: "999.999" }, "ERR_JWT_CLAIM_VALIDATION_FAILED"],
    ["from another issuer", { issuer: "https://evil.example" }, "ERR_JWT_CLAIM_VALIDATION_FAILED"],
    [
      "expired",
      { issuedAt: new Date(Date.now() - 2 * 3600_000), lifetimeSeconds: 3600 },
      "ERR_JWT_EXPIRED",
    ],
  ])(
    "refuses a token %s",
    async (_case, options: Partial<IdTokenOptions> & { key?: string }, detail) => {
      const { key, ...claims } = options;
      const { res, lines } = await callback({
        token: (nonce) => slackIdToken(key === "impostor" ? impostor : slack, { nonce, ...claims }),
      });
      expectRejected(res, "failed");
      expect(lines).toContainEqual(expect.objectContaining({ reason: "bad_token", detail }));
    },
  );

  it("refuses a token that is not a token at all", async () => {
    const { res } = await callback({ token: () => Promise.resolve("garbage") });
    expectRejected(res, "failed");
  });

  it("says so when the person cancelled at Slack, logging only a plain error code", async () => {
    const started = await begin();
    const d = deps();
    const res = await finishSignIn(
      web(`/auth/slack/callback?error=access_denied&state=${started.state}`, started.cookie),
      d,
    );
    expectRejected(res, "cancelled");
    const odd = await finishSignIn(web("/auth/slack/callback?error=%3Cscript%3E"), d);
    expectRejected(odd, "cancelled");
    expect(d.lines).toContainEqual(expect.objectContaining({ error: "access_denied" }));
    expect(d.lines).toContainEqual(expect.objectContaining({ error: "other" }));
  });

  it("fails when Slack refuses the code, without logging the client secret", async () => {
    const started = await begin();
    const fetch: Fetch = () => Promise.resolve(Response.json({ ok: false, error: "invalid_code" }));
    const d = deps({ fetch });
    const res = await finishSignIn(
      web(`/auth/slack/callback?code=c&state=${started.state}`, started.cookie),
      d,
    );
    expectRejected(res, "failed");
    expect(d.lines).toContainEqual(
      expect.objectContaining({ reason: "token_exchange_failed", detail: "invalid_code" }),
    );
    expect(JSON.stringify(d.lines)).not.toContain(config.slack.clientSecret);
  });

  it("says sign-in is unavailable when not configured", async () => {
    const res = await finishSignIn(
      web("/auth/slack/callback?code=c&state=s"),
      deps({ config: undefined }),
    );
    expectRejected(res, "unavailable");
  });
});

describe("POST /auth/signout", () => {
  it("deletes the session cookie and goes home", () => {
    const res = signOut(web("/auth/signout"), deps());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${config.webBaseUrl}/`);
    expect(res.headers.getSetCookie()).toEqual([
      "hippidy_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    ]);
  });
});
