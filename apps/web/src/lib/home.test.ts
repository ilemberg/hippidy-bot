import type { SessionActivity } from "@hippidy/contracts";
import { jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { fetchSessions } from "./api-client.ts";
import { loadHome, SESSIONS_SHOWN, type HomeDeps } from "./home.ts";
import { memoryLogger } from "./log.ts";
import type { Fetch } from "./slack-oidc.ts";
import { config } from "./testing.ts";
import { signSession, type Person } from "./tokens.ts";

const person: Person = { actorId: "U0123456789", workspaceId: "T0123456789", name: "Ilya" };
const session: SessionActivity = {
  kind: "thread",
  conversationId: "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f",
  changeId: null,
  title: "how does search work?",
  agent: "teammate",
  state: "working",
  askedBy: { actorId: "U1", name: "Ada" },
  project: null,
  latestActivity: { at: "2026-11-25T10:00:00.000Z", text: "Looking." },
  cost: { spentMinor: 42, budgetMinor: 500, currency: "USD" },
  startedAt: "2026-11-25T09:59:00.000Z",
  thread: { source: "slack", workspaceId: "T0123456789", channelId: "C1", threadId: "100.1" },
};

/** A fake API that answers `GET /v1/sessions`, and records what it was sent. */
function fakeApi(answer: () => Response = () => Response.json({ sessions: [session] })) {
  const calls: { url: string; headers: Headers }[] = [];
  const fetch: Fetch = (url, init) => {
    calls.push({ url, headers: new Headers(init.headers) });
    return Promise.resolve(answer());
  };
  return { fetch, calls };
}

const now = new Date("2026-11-25T10:05:00.000Z");

function deps(fetch: Fetch): HomeDeps {
  return { config, fetch, log: memoryLogger().log, now: () => now };
}

const base = () => ({
  apiBaseUrl: config.apiBaseUrl,
  apiSecret: config.apiSecret,
  log: memoryLogger().log,
  correlationId: "c",
});

describe("fetchSessions", () => {
  it("calls the API as the person, with a person token and a correlation id", async () => {
    const api = fakeApi();
    const result = await fetchSessions(person, 10, {
      ...base(),
      fetch: api.fetch,
      correlationId: "corr-1",
    });
    expect(result).toEqual({ kind: "ok", value: [session] });
    expect(api.calls[0]?.url).toBe("https://api.example.test/v1/sessions?limit=10");
    expect(api.calls[0]?.headers.get("x-correlation-id")).toBe("corr-1");
    const token = /^Bearer (.+)$/.exec(api.calls[0]?.headers.get("authorization") ?? "")?.[1];
    const { payload } = await jwtVerify(token ?? "", new TextEncoder().encode(config.apiSecret), {
      audience: "hippidy-api",
      issuer: "hippidy-web",
    });
    expect(payload).toMatchObject({ sub: "U0123456789", team: "T0123456789", name: "Ilya" });
  });

  it("reports a refusal, an odd answer and an unreachable API", async () => {
    const refused = fakeApi(() => Response.json({ error: {} }, { status: 401 }));
    expect(await fetchSessions(person, 10, { ...base(), fetch: refused.fetch })).toEqual({
      kind: "failed",
      reason: "status_401",
    });
    const odd = fakeApi(() => Response.json({ sessions: [{ kind: "robot" }] }));
    expect(await fetchSessions(person, 10, { ...base(), fetch: odd.fetch })).toEqual({
      kind: "failed",
      reason: "unexpected_response",
    });
    const notJson = fakeApi(() => new Response("<html>"));
    expect(await fetchSessions(person, 10, { ...base(), fetch: notJson.fetch })).toEqual({
      kind: "failed",
      reason: "unexpected_response",
    });
    const down: Fetch = () => Promise.reject(new Error("connection refused"));
    expect(await fetchSessions(person, 10, { ...base(), fetch: down })).toEqual({
      kind: "failed",
      reason: "unreachable",
    });
  });
});

describe("loadHome", () => {
  it("shows the signed-in person and the latest ten sessions", async () => {
    const api = fakeApi();
    const cookie = await signSession(person, config.sessionSecret);
    expect(await loadHome({ sessionCookie: cookie, signin: undefined }, deps(api.fetch))).toEqual({
      kind: "signed_in",
      person,
      sessions: { kind: "ok", value: [session] },
      readAt: now.toISOString(),
    });
    expect(api.calls[0]?.url).toBe(`https://api.example.test/v1/sessions?limit=${SESSIONS_SHOWN}`);
  });

  it("still shows the page when the API does not answer", async () => {
    const api = fakeApi(() => new Response(null, { status: 503 }));
    const cookie = await signSession(person, config.sessionSecret);
    const view = await loadHome({ sessionCookie: cookie, signin: undefined }, deps(api.fetch));
    expect(view).toMatchObject({
      kind: "signed_in",
      sessions: { kind: "failed", reason: "status_503" },
    });
  });

  it("offers sign-in, with a known notice only, and calls nothing", async () => {
    const api = fakeApi();
    expect(await loadHome({ sessionCookie: undefined, signin: "failed" }, deps(api.fetch))).toEqual(
      { kind: "signed_out", notice: "failed" },
    );
    expect(
      await loadHome({ sessionCookie: "not-a-session", signin: "<b>hi</b>" }, deps(api.fetch)),
    ).toEqual({ kind: "signed_out", notice: undefined });
    expect(api.calls).toEqual([]);
  });

  it("says sign-in is not set up when the configuration is missing", async () => {
    const api = fakeApi();
    expect(
      await loadHome(
        { sessionCookie: undefined, signin: undefined },
        { ...deps(api.fetch), config: undefined },
      ),
    ).toEqual({ kind: "unconfigured" });
  });
});
