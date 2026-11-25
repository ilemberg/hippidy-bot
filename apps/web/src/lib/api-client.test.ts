import { decisionActionResultSchema } from "@hippidy/contracts";
import { jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import {
  apiSend,
  confirmDecision,
  createArea,
  editArea,
  fetchArea,
  fetchAreas,
  fetchPeople,
  editDecision,
  fetchConflict,
  fetchConflicts,
  fetchDecision,
  fetchDecisions,
  rejectDecision,
  settleConflict,
} from "./api-client.ts";
import { memoryLogger } from "./log.ts";
import type { Fetch } from "./slack-oidc.ts";
import {
  area,
  areaDetail,
  config,
  conflict,
  conflictDetail,
  proposal as decision,
  proposalDetail as detail,
} from "./testing.ts";
import type { Person } from "./tokens.ts";

const person: Person = { actorId: "U0123456789", workspaceId: "T0123456789", name: "Ilya" };

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/** A fake API that answers each call with `answer`, and records what it was sent. */
function fakeApi(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch: Fetch = (url, init) => {
    const call = {
      url,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    return Promise.resolve(answer(call));
  };
  return { fetch, calls };
}

const deps = (fetch: Fetch) => ({
  fetch,
  apiBaseUrl: config.apiBaseUrl,
  apiSecret: config.apiSecret,
  log: memoryLogger().log,
  correlationId: "corr-1",
});

async function tokenSubject(headers: Headers): Promise<unknown> {
  const token = /^Bearer (.+)$/.exec(headers.get("authorization") ?? "")?.[1];
  const { payload } = await jwtVerify(token ?? "", new TextEncoder().encode(config.apiSecret), {
    audience: "hippidy-api",
    issuer: "hippidy-web",
  });
  return payload.sub;
}

describe("fetchDecisions", () => {
  it("asks for the words, status, origin and limit given, and only those", async () => {
    const api = fakeApi(() => Response.json({ decisions: [decision] }));
    expect(
      await fetchDecisions(
        person,
        { q: "search & sort", status: "active", origin: "thread", limit: 100 },
        deps(api.fetch),
      ),
    ).toEqual({ kind: "ok", value: [decision] });
    await fetchDecisions(person, {}, deps(api.fetch));
    expect(api.calls.map((call) => call.url)).toEqual([
      "https://api.example.test/v1/decisions?q=search+%26+sort&status=active&origin=thread&limit=100",
      "https://api.example.test/v1/decisions",
    ]);
    expect(api.calls[0]?.method).toBe("GET");
  });
});

describe("fetchDecision", () => {
  it("reads one decision by its number, as the person", async () => {
    const api = fakeApi(() => Response.json(detail));
    expect(await fetchDecision(person, 7, deps(api.fetch))).toEqual({ kind: "ok", value: detail });
    expect(api.calls[0]?.url).toBe("https://api.example.test/v1/decisions/7");
    expect(await tokenSubject(api.calls[0]?.headers ?? new Headers())).toBe("U0123456789");
  });

  it("tells a decision not on record from an API that did not answer", async () => {
    const missing = fakeApi(() =>
      Response.json({ error: { code: "not_found", message: "No such decision" } }, { status: 404 }),
    );
    expect(await fetchDecision(person, 7, deps(missing.fetch))).toEqual({ kind: "not_found" });
    const down = fakeApi(() => new Response(null, { status: 503 }));
    expect(await fetchDecision(person, 7, deps(down.fetch))).toEqual({
      kind: "failed",
      reason: "status_503",
    });
    const odd = fakeApi(() => Response.json({ decision: { number: 7 } }));
    expect(await fetchDecision(person, 7, deps(odd.fetch))).toEqual({
      kind: "failed",
      reason: "unexpected_response",
    });
  });
});

describe("confirm, reject and edit", () => {
  it("post to the decision's id as the person, with no one else named in the body", async () => {
    const api = fakeApi((call) =>
      Response.json(
        { status: call.url.endsWith("/confirm") ? "confirmed" : "rejected" },
        { status: call.url.endsWith("/confirm") ? 202 : 200 },
      ),
    );
    expect(await confirmDecision(person, decision.id, 1, deps(api.fetch))).toEqual({
      kind: "ok",
      value: { status: "confirmed" },
    });
    expect(await rejectDecision(person, decision.id, 1, deps(api.fetch))).toEqual({
      kind: "ok",
      value: { status: "rejected" },
    });
    expect(api.calls.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
      {
        url: `https://api.example.test/v1/decisions/${decision.id}/confirm`,
        method: "POST",
        body: { wordingVersion: 1 },
      },
      {
        url: `https://api.example.test/v1/decisions/${decision.id}/reject`,
        method: "POST",
        body: { wordingVersion: 1 },
      },
    ]);
    for (const call of api.calls) {
      expect(call.headers.get("content-type")).toBe("application/json");
      expect(call.headers.get("x-correlation-id")).toBe("corr-1");
      expect(await tokenSubject(call.headers)).toBe("U0123456789");
    }
  });

  it("patches the new wording, nulls included", async () => {
    const api = fakeApi(() => Response.json({ status: "edited" }));
    const result = await editDecision(
      person,
      decision.id,
      { statement: "Use Postgres full-text search", reason: null, wordingVersion: 1 },
      deps(api.fetch),
    );
    expect(result).toEqual({ kind: "ok", value: { status: "edited" } });
    expect(api.calls[0]).toMatchObject({
      url: `https://api.example.test/v1/decisions/${decision.id}`,
      method: "PATCH",
      body: { statement: "Use Postgres full-text search", reason: null, wordingVersion: 1 },
    });
  });

  it("passes on a refusal in the body, and reports a failed call", async () => {
    const refused = fakeApi(() =>
      Response.json({ status: "not_allowed", reason: "not_in_thread" }),
    );
    expect(await confirmDecision(person, decision.id, 1, deps(refused.fetch))).toEqual({
      kind: "ok",
      value: { status: "not_allowed", reason: "not_in_thread" },
    });
    const bad = fakeApi(() => Response.json({ error: {} }, { status: 400 }));
    expect(
      await editDecision(person, decision.id, { area: null, wordingVersion: 1 }, deps(bad.fetch)),
    ).toEqual({
      kind: "failed",
      reason: "status_400",
    });
    const down: Fetch = () => Promise.reject(new Error("connection refused"));
    expect(await rejectDecision(person, decision.id, 1, deps(down))).toEqual({
      kind: "failed",
      reason: "unreachable",
    });
    const odd = fakeApi(() => Response.json({ status: "maybe" }));
    expect(
      await apiSend(person, "POST", "/v1/x", {}, decisionActionResultSchema, deps(odd.fetch)),
    ).toEqual({ kind: "failed", reason: "unexpected_response" });
  });
});

describe("areas and people", () => {
  it("reads every area and the people known, as the person", async () => {
    const list = { areas: [area], fallbackOwner: { actorId: "U9", name: "Owner" } };
    const people = { people: [{ actorId: "U1", name: "Ada" }] };
    const api = fakeApi((call) => Response.json(call.url.endsWith("/v1/people") ? people : list));
    expect(await fetchAreas(person, deps(api.fetch))).toEqual({ kind: "ok", value: list });
    expect(await fetchPeople(person, deps(api.fetch))).toEqual({
      kind: "ok",
      value: people.people,
    });
    expect(api.calls.map(({ url, method }) => [method, url])).toEqual([
      ["GET", "https://api.example.test/v1/areas"],
      ["GET", "https://api.example.test/v1/people"],
    ]);
    for (const call of api.calls) expect(await tokenSubject(call.headers)).toBe("U0123456789");
  });

  it("reads one area by its name, encoded as one segment, and tells not found apart", async () => {
    const api = fakeApi(() => Response.json(areaDetail));
    expect(await fetchArea(person, "apps/api search", deps(api.fetch))).toEqual({
      kind: "ok",
      value: areaDetail,
    });
    expect(api.calls[0]?.url).toBe("https://api.example.test/v1/areas/apps%2Fapi%20search");
    const missing = fakeApi(() =>
      Response.json({ error: { code: "not_found", message: "No such area" } }, { status: 404 }),
    );
    expect(await fetchArea(person, "search", deps(missing.fetch))).toEqual({ kind: "not_found" });
    const down = fakeApi(() => new Response(null, { status: 503 }));
    expect(await fetchArea(person, "search", deps(down.fetch))).toEqual({
      kind: "failed",
      reason: "status_503",
    });
    expect(await fetchPeople(person, deps(down.fetch))).toEqual({
      kind: "failed",
      reason: "status_503",
    });
    const odd = fakeApi(() => Response.json({ areas: [{ name: "search" }] }));
    expect(await fetchAreas(person, deps(odd.fetch))).toEqual({
      kind: "failed",
      reason: "unexpected_response",
    });
  });

  it("creates with a POST and edits with a PATCH to the area's id, naming no one else", async () => {
    const api = fakeApi((call) =>
      call.method === "POST"
        ? Response.json({ status: "created", area }, { status: 201 })
        : Response.json({ status: "changed", area }),
    );
    expect(
      await createArea(
        person,
        { name: "search", ownerActorId: "U1", words: ["full-text"] },
        deps(api.fetch),
      ),
    ).toEqual({ kind: "ok", value: { status: "created", area } });
    expect(
      await editArea(person, area.id, { version: 2, ownerActorId: null }, deps(api.fetch)),
    ).toEqual({ kind: "ok", value: { status: "changed", area } });
    expect(api.calls.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
      {
        url: "https://api.example.test/v1/areas",
        method: "POST",
        body: { name: "search", ownerActorId: "U1", words: ["full-text"] },
      },
      {
        url: `https://api.example.test/v1/areas/${area.id}`,
        method: "PATCH",
        body: { version: 2, ownerActorId: null },
      },
    ]);
    for (const call of api.calls) {
      expect(call.headers.get("content-type")).toBe("application/json");
      expect(call.headers.get("x-correlation-id")).toBe("corr-1");
      expect(await tokenSubject(call.headers)).toBe("U0123456789");
    }
  });

  it("reports a refused, unreachable or odd write as failed", async () => {
    const bad = fakeApi(() => Response.json({ error: {} }, { status: 400 }));
    expect(await createArea(person, { name: "search" }, deps(bad.fetch))).toEqual({
      kind: "failed",
      reason: "status_400",
    });
    const down: Fetch = () => Promise.reject(new Error("connection refused"));
    expect(await editArea(person, area.id, { version: 1 }, deps(down))).toEqual({
      kind: "failed",
      reason: "unreachable",
    });
    const odd = fakeApi(() => Response.json({ status: "moved" }));
    expect(await editArea(person, area.id, { version: 1 }, deps(odd.fetch))).toEqual({
      kind: "failed",
      reason: "unexpected_response",
    });
  });
});

describe("conflicts", () => {
  it("lists them by status and decision, as the person, asking only for what is given", async () => {
    const api = fakeApi(() => Response.json({ conflicts: [conflict] }));
    expect(
      await fetchConflicts(person, { status: "all", decision: 7, limit: 200 }, deps(api.fetch)),
    ).toEqual({ kind: "ok", value: [conflict] });
    await fetchConflicts(person, {}, deps(api.fetch));
    expect(api.calls.map(({ url, method }) => [method, url])).toEqual([
      ["GET", "https://api.example.test/v1/conflicts?status=all&decision=7&limit=200"],
      ["GET", "https://api.example.test/v1/conflicts"],
    ]);
    for (const call of api.calls) expect(await tokenSubject(call.headers)).toBe("U0123456789");
    const odd = fakeApi(() => Response.json({ conflicts: [{ number: 3 }] }));
    expect(await fetchConflicts(person, {}, deps(odd.fetch))).toEqual({
      kind: "failed",
      reason: "unexpected_response",
    });
  });

  it("reads one by its number, and tells not found from an API that did not answer", async () => {
    const api = fakeApi(() => Response.json(conflictDetail));
    expect(await fetchConflict(person, 3, deps(api.fetch))).toEqual({
      kind: "ok",
      value: conflictDetail,
    });
    expect(api.calls[0]?.url).toBe("https://api.example.test/v1/conflicts/3");
    const missing = fakeApi(() =>
      Response.json({ error: { code: "not_found", message: "No such conflict" } }, { status: 404 }),
    );
    expect(await fetchConflict(person, 3, deps(missing.fetch))).toEqual({ kind: "not_found" });
    const down = fakeApi(() => new Response(null, { status: 503 }));
    expect(await fetchConflict(person, 3, deps(down.fetch))).toEqual({
      kind: "failed",
      reason: "status_503",
    });
  });

  it("settles with a POST to the conflict's id as the person, naming no one else", async () => {
    const settled = { ...conflict, status: "settled" as const, outcome: "kept" as const };
    const api = fakeApi(() => Response.json({ status: "settled", conflict: settled }));
    expect(
      await settleConflict(
        person,
        conflict.id,
        { outcome: "kept", note: "Postgres stays" },
        deps(api.fetch),
      ),
    ).toEqual({ kind: "ok", value: { status: "settled", conflict: settled } });
    expect(api.calls.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
      {
        url: `https://api.example.test/v1/conflicts/${conflict.id}/settle`,
        method: "POST",
        body: { outcome: "kept", note: "Postgres stays" },
      },
    ]);
    const call = api.calls[0];
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(call?.headers.get("x-correlation-id")).toBe("corr-1");
    expect(await tokenSubject(call?.headers ?? new Headers())).toBe("U0123456789");
    const refused = fakeApi(() =>
      Response.json({ status: "not_allowed", reason: "not_decider", conflict }),
    );
    expect(
      await settleConflict(person, conflict.id, { outcome: "dismissed" }, deps(refused.fetch)),
    ).toEqual({ kind: "ok", value: { status: "not_allowed", reason: "not_decider", conflict } });
    const odd = fakeApi(() => Response.json({ status: "closed" }));
    expect(await settleConflict(person, conflict.id, { outcome: "kept" }, deps(odd.fetch))).toEqual(
      { kind: "failed", reason: "unexpected_response" },
    );
  });
});
