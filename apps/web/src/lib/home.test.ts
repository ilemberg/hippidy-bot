import { jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { fetchMe } from "./api-client.ts";
import { loadHome, type HomeDeps } from "./home.ts";
import { memoryLogger } from "./log.ts";
import type { Fetch } from "./slack-oidc.ts";
import { config } from "./testing.ts";
import { signSession, type Person } from "./tokens.ts";

const person: Person = { actorId: "U0123456789", workspaceId: "T0123456789", name: "Ilya" };
const me = { kind: "person", workspaceId: "T0123456789", actorId: "U0123456789", name: "Ilya" };

/** A fake API that answers `GET /v1/me`, and records what it was sent. */
function fakeApi(answer: () => Response = () => Response.json(me)) {
  const calls: { url: string; headers: Headers }[] = [];
  const fetch: Fetch = (url, init) => {
    calls.push({ url, headers: new Headers(init.headers) });
    return Promise.resolve(answer());
  };
  return { fetch, calls };
}

function deps(fetch: Fetch): HomeDeps {
  return { config, fetch, log: memoryLogger().log };
}

describe("fetchMe", () => {
  it("calls the API as the person, with a person token and a correlation id", async () => {
    const api = fakeApi();
    const { log } = memoryLogger();
    const result = await fetchMe(person, {
      fetch: api.fetch,
      apiBaseUrl: config.apiBaseUrl,
      apiSecret: config.apiSecret,
      log,
      correlationId: "corr-1",
    });
    expect(result).toEqual({ kind: "ok", me });
    expect(api.calls[0]?.url).toBe("https://api.example.test/v1/me");
    expect(api.calls[0]?.headers.get("x-correlation-id")).toBe("corr-1");
    const token = /^Bearer (.+)$/.exec(api.calls[0]?.headers.get("authorization") ?? "")?.[1];
    const { payload } = await jwtVerify(token ?? "", new TextEncoder().encode(config.apiSecret), {
      audience: "hippidy-api",
      issuer: "hippidy-web",
    });
    expect(payload).toMatchObject({ sub: "U0123456789", team: "T0123456789", name: "Ilya" });
  });

  it("reports a refusal, an odd answer and an unreachable API", async () => {
    const base = {
      apiBaseUrl: config.apiBaseUrl,
      apiSecret: config.apiSecret,
      log: memoryLogger().log,
      correlationId: "c",
    };
    const refused = fakeApi(() => Response.json({ error: {} }, { status: 401 }));
    expect(await fetchMe(person, { ...base, fetch: refused.fetch })).toEqual({
      kind: "failed",
      reason: "status_401",
    });
    const odd = fakeApi(() => Response.json({ kind: "robot" }));
    expect(await fetchMe(person, { ...base, fetch: odd.fetch })).toEqual({
      kind: "failed",
      reason: "unexpected_response",
    });
    const down: Fetch = () => Promise.reject(new Error("connection refused"));
    expect(await fetchMe(person, { ...base, fetch: down })).toEqual({
      kind: "failed",
      reason: "unreachable",
    });
  });
});

describe("loadHome", () => {
  it("shows the signed-in person and what the API says about them", async () => {
    const api = fakeApi();
    const session = await signSession(person, config.sessionSecret);
    expect(await loadHome({ sessionCookie: session, signin: undefined }, deps(api.fetch))).toEqual({
      kind: "signed_in",
      person,
      me: { kind: "ok", me },
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
