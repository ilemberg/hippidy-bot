import type { SessionActivity } from "@hippidy/contracts";
import { jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { fetchScorecard, fetchSessions } from "./api-client.ts";
import {
  differenceText,
  loadHome,
  scorecardHref,
  SESSIONS_SHOWN,
  weeksText,
  type HomeDeps,
} from "./home.ts";
import { memoryLogger } from "./log.ts";
import type { Fetch } from "./slack-oidc.ts";
import { briefsJob, config, job, myBrief, scorecard } from "./testing.ts";
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

/** What the fake API answers for each route the home page reads. */
const answers: Record<string, () => Response> = {
  "/v1/briefs/me": () => Response.json(myBrief),
  "/v1/jobs": () => Response.json({ jobs: [briefsJob, job] }),
  "/v1/scorecard": () => Response.json(scorecard),
  "/v1/sessions": () => Response.json({ sessions: [session] }),
};

/** A fake API that answers the home page's routes, each as given, and records what it was sent. */
function fakeApi(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const calls: { url: string; headers: Headers }[] = [];
  const fetch: Fetch = (url, init) => {
    calls.push({ url, headers: new Headers(init.headers) });
    const path = new URL(url).pathname;
    const answer = overrides[path] ?? answers[path];
    return Promise.resolve(answer === undefined ? new Response(null, { status: 404 }) : answer());
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
    const refused = fakeApi({
      "/v1/sessions": () => Response.json({ error: {} }, { status: 401 }),
    });
    expect(await fetchSessions(person, 10, { ...base(), fetch: refused.fetch })).toEqual({
      kind: "failed",
      reason: "status_401",
    });
    const odd = fakeApi({ "/v1/sessions": () => Response.json({ sessions: [{ kind: "robot" }] }) });
    expect(await fetchSessions(person, 10, { ...base(), fetch: odd.fetch })).toEqual({
      kind: "failed",
      reason: "unexpected_response",
    });
    const notJson = fakeApi({ "/v1/sessions": () => new Response("<html>") });
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

describe("fetchScorecard", () => {
  it("reads the team's scorecard as the person, checked against the contract", async () => {
    const api = fakeApi();
    expect(await fetchScorecard(person, { ...base(), fetch: api.fetch })).toEqual({
      kind: "ok",
      value: scorecard,
    });
    expect(api.calls[0]?.url).toBe("https://api.example.test/v1/scorecard");
    const odd = fakeApi({
      "/v1/scorecard": () => Response.json({ ...scorecard, counts: [{ kind: "people_ranked" }] }),
    });
    expect(await fetchScorecard(person, { ...base(), fetch: odd.fetch })).toEqual({
      kind: "failed",
      reason: "unexpected_response",
    });
  });
});

describe("loadHome", () => {
  it("shows a signed-in person their brief, the jobs, the scorecard and the agents at work", async () => {
    const api = fakeApi();
    const cookie = await signSession(person, config.sessionSecret);
    expect(await loadHome({ sessionCookie: cookie, signin: undefined }, deps(api.fetch))).toEqual({
      kind: "signed_in",
      person,
      brief: { kind: "ok", value: myBrief },
      jobs: { kind: "ok", value: { jobs: [briefsJob, job] } },
      scorecard: { kind: "ok", value: scorecard },
      sessions: { kind: "ok", value: [session] },
      webBaseUrl: config.webBaseUrl,
      readAt: now.toISOString(),
    });
    expect(api.calls.map((call) => call.url).sort()).toEqual([
      "https://api.example.test/v1/briefs/me",
      "https://api.example.test/v1/jobs",
      "https://api.example.test/v1/scorecard",
      `https://api.example.test/v1/sessions?limit=${SESSIONS_SHOWN}`,
    ]);
    // One correlation id for the page's calls, so its log lines read together.
    expect(new Set(api.calls.map((call) => call.headers.get("x-correlation-id"))).size).toBe(1);
  });

  it("still shows the rest when one route fails, and each part says why it is missing", async () => {
    const cookie = await signSession(person, config.sessionSecret);
    for (const [route, part] of [
      ["/v1/briefs/me", "brief"],
      ["/v1/jobs", "jobs"],
      ["/v1/scorecard", "scorecard"],
      ["/v1/sessions", "sessions"],
    ] as const) {
      const api = fakeApi({ [route]: () => new Response(null, { status: 503 }) });
      const view = await loadHome({ sessionCookie: cookie, signin: undefined }, deps(api.fetch));
      if (view.kind !== "signed_in") throw new Error("expected the signed-in page");
      expect(view[part]).toEqual({ kind: "failed", reason: "status_503" });
      const others = (["brief", "jobs", "scorecard", "sessions"] as const).filter(
        (p) => p !== part,
      );
      for (const other of others) expect(view[other].kind).toBe("ok");
    }
  });

  it("shows a part as failed when its call throws or never reaches the API", async () => {
    const cookie = await signSession(person, config.sessionSecret);
    const api = fakeApi({
      "/v1/scorecard": () => Promise.reject(new Error("connection reset")),
    });
    const view = await loadHome({ sessionCookie: cookie, signin: undefined }, deps(api.fetch));
    expect(view).toMatchObject({
      kind: "signed_in",
      scorecard: { kind: "failed", reason: "unreachable" },
      brief: { kind: "ok" },
      jobs: { kind: "ok" },
      sessions: { kind: "ok" },
    });
  });

  it("still shows the page when the API does not answer at all", async () => {
    const down: Fetch = () => Promise.reject(new Error("connection refused"));
    const cookie = await signSession(person, config.sessionSecret);
    const view = await loadHome({ sessionCookie: cookie, signin: undefined }, deps(down));
    const failed = { kind: "failed", reason: "unreachable" };
    expect(view).toMatchObject({
      kind: "signed_in",
      person,
      brief: failed,
      jobs: failed,
      scorecard: failed,
      sessions: failed,
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

describe("the scorecard's words", () => {
  it("says the difference with a sign, or that it is the same", () => {
    expect(differenceText(4, 2)).toBe("+2");
    expect(differenceText(0, 3)).toBe("−3");
    expect(differenceText(1, 1)).toBe("same");
  });

  it("says the weeks run Monday to Sunday in UTC, and from which Monday", () => {
    expect(weeksText(scorecard)).toBe(
      "This week is from Monday 23 November, 00:00 UTC, to now; last week is the seven days from Monday 16 November. Weeks run Monday to Sunday in UTC.",
    );
  });

  it("links each count to the page it comes from, where there is one", () => {
    expect(scorecardHref).toEqual({
      decisions_made: "/decisions",
      conflicts_settled: "/conflicts",
      waits_ended: "/waits",
      changes_started: undefined,
      pull_requests_reviewed: "/jobs/checker",
      tickets_merged: "/jobs",
    });
  });
});
