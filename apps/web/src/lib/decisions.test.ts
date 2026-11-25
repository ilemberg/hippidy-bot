import type { Decision, DecisionDetail } from "@hippidy/contracts";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "./cookies.ts";
import {
  actionNotice,
  editFromForm,
  groupByArea,
  handleDecisionAction,
  historyItems,
  loadDecision,
  loadDecisions,
  noticeText,
  notAllowedText,
  notProposedText,
  searchWords,
  when,
  whereDecided,
  WITHDRAW_TEXT,
} from "./decisions.ts";
import type { HomeDeps } from "./home.ts";
import { memoryLogger } from "./log.ts";
import type { Fetch } from "./slack-oidc.ts";
import { config, conflict, proposal, proposalDetail } from "./testing.ts";
import { signSession, type Person } from "./tokens.ts";

const person: Person = { actorId: "U0123456789", workspaceId: "T0123456789", name: "Ilya" };
const now = new Date("2026-11-25T12:00:00.000Z");

const decision = (number: number, fields: Partial<Decision> = {}): Decision => ({
  ...proposal,
  id: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
  number,
  ...fields,
});

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** A fake API: `answer` gets each call; every call is recorded. */
function fakeApi(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch: Fetch = (url, init) => {
    const call = {
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    return Promise.resolve(answer(call));
  };
  return { fetch, calls };
}

function deps(fetch: Fetch): HomeDeps & { lines: Record<string, unknown>[] } {
  const { log, lines } = memoryLogger();
  return { config, fetch, log, now: () => now, lines };
}

const noCalls: Fetch = () => Promise.reject(new Error("no call expected"));
const signedIn = () => signSession(person, config.sessionSecret, now);

describe("groupByArea", () => {
  it("puts areas in alphabetical order, no area last, and the newest first in each", () => {
    const groups = groupByArea([
      decision(1, { area: "search" }),
      decision(2, { area: null }),
      decision(3, { area: "Billing" }),
      decision(4, { area: "search" }),
    ]);
    expect(groups.map((group) => [group.label, group.decisions.map((d) => d.number)])).toEqual([
      ["Billing", [3]],
      ["search", [4, 1]],
      ["No area", [2]],
    ]);
  });
});

describe("searchWords", () => {
  it("trims, keeps at most 200 characters, and drops an empty search", () => {
    expect(searchWords("  postgres  ")).toBe("postgres");
    expect(searchWords("   ")).toBeUndefined();
    expect(searchWords(undefined)).toBeUndefined();
    expect(searchWords("a".repeat(300))).toHaveLength(200);
  });
});

describe("loadDecisions", () => {
  it("shows the active decisions and the proposals by default, by area, as the person", async () => {
    const api = fakeApi((call) =>
      Response.json({
        decisions: call.url.includes("status=active")
          ? [decision(1, { status: "active", area: null }), decision(2, { status: "active" })]
          : [decision(3), decision(2, { status: "active" })],
      }),
    );
    const view = await loadDecisions(
      { sessionCookie: await signedIn(), q: undefined, status: undefined },
      deps(api.fetch),
    );
    expect(api.calls.map((call) => call.url).sort()).toEqual([
      "https://api.example.test/v1/decisions?status=active&limit=500",
      "https://api.example.test/v1/decisions?status=proposed&limit=500",
    ]);
    expect(view).toMatchObject({ kind: "signed_in", person, q: undefined, filter: "open" });
    if (view.kind !== "signed_in" || view.groups.kind !== "ok") throw new Error("no groups");
    expect(view.groups.value.map((g) => [g.label, g.decisions.map((d) => d.number)])).toEqual([
      ["Search", [3, 2]],
      ["No area", [1]],
    ]);
    expect(view.truncated).toBe(false);
  });

  it("searches the words given, in one status or all", async () => {
    const api = fakeApi(() => Response.json({ decisions: [] }));
    for (const status of ["rejected", "all", "<script>"]) {
      await loadDecisions(
        { sessionCookie: await signedIn(), q: " postgres ", status },
        deps(api.fetch),
      );
    }
    expect(api.calls.map((call) => call.url)).toEqual([
      "https://api.example.test/v1/decisions?q=postgres&status=rejected&limit=500",
      "https://api.example.test/v1/decisions?q=postgres&status=all&limit=500",
      "https://api.example.test/v1/decisions?q=postgres&status=active&limit=500",
      "https://api.example.test/v1/decisions?q=postgres&status=proposed&limit=500",
    ]);
  });

  it("says when some may not be shown, and when the API did not answer", async () => {
    const many = Array.from({ length: 500 }, (_, i) => decision(i + 1, { status: "rejected" }));
    const full = fakeApi(() => Response.json({ decisions: many }));
    expect(
      await loadDecisions(
        { sessionCookie: await signedIn(), q: undefined, status: "rejected" },
        deps(full.fetch),
      ),
    ).toMatchObject({ truncated: true });
    const down = fakeApi((call) =>
      call.url.includes("proposed")
        ? new Response(null, { status: 503 })
        : Response.json({ decisions: [] }),
    );
    expect(
      await loadDecisions(
        { sessionCookie: await signedIn(), q: undefined, status: undefined },
        deps(down.fetch),
      ),
    ).toMatchObject({ kind: "signed_in", groups: { kind: "failed", reason: "status_503" } });
  });

  it("asks a signed-out visitor to sign in, and calls nothing", async () => {
    expect(
      await loadDecisions(
        { sessionCookie: undefined, q: undefined, status: undefined },
        deps(noCalls),
      ),
    ).toEqual({ kind: "signed_out" });
    expect(
      await loadDecisions(
        { sessionCookie: undefined, q: undefined, status: undefined },
        { ...deps(noCalls), config: undefined },
      ),
    ).toEqual({ kind: "unconfigured" });
  });
});

describe("loadDecision", () => {
  const input = async (number: string, done?: string, error?: string) => ({
    sessionCookie: await signedIn(),
    number,
    done,
    error,
  });

  /** The API's reads: `detail` for the decision, and the open conflicts bearing on it. */
  const reads = (detail: DecisionDetail = proposalDetail) =>
    fakeApi((call) =>
      call.url.includes("/v1/conflicts")
        ? Response.json({ conflicts: [conflict] })
        : Response.json(detail),
    );

  it("reads the decision by its number and its open conflicts, with a notice this app sent", async () => {
    const api = reads();
    expect(await loadDecision(await input("7", "confirmed"), deps(api.fetch))).toEqual({
      kind: "ok",
      person,
      detail: proposalDetail,
      conflicts: { kind: "ok", value: [conflict] },
      notice: { kind: "done", done: "confirmed" },
      readAt: now.toISOString(),
    });
    expect(api.calls.map((call) => call.url).sort()).toEqual([
      "https://api.example.test/v1/conflicts?status=open&decision=7",
      "https://api.example.test/v1/decisions/7",
    ]);
    expect(
      await loadDecision(await input("7", undefined, "not_in_thread"), deps(api.fetch)),
    ).toMatchObject({ notice: { kind: "error", error: "not_in_thread" } });
    expect(await loadDecision(await input("7", "hacked", "<b>"), deps(api.fetch))).toMatchObject({
      kind: "ok",
      notice: undefined,
    });
  });

  it("shows the decision when only its conflicts could not be read", async () => {
    const api = fakeApi((call) =>
      call.url.includes("/v1/conflicts")
        ? new Response(null, { status: 500 })
        : Response.json(proposalDetail),
    );
    expect(await loadDecision(await input("7"), deps(api.fetch))).toMatchObject({
      kind: "ok",
      detail: proposalDetail,
      conflicts: { kind: "failed", reason: "status_500" },
    });
  });

  it("does not repeat a refusal the page already gives under the proposal", async () => {
    const refused = { ...proposalDetail, youMay: { act: false, reason: "not_in_thread" as const } };
    const api = reads(refused);
    expect(
      await loadDecision(await input("7", undefined, "not_in_thread"), deps(api.fetch)),
    ).toMatchObject({ kind: "ok", notice: undefined });
    expect(
      await loadDecision(await input("7", undefined, "not_proposed"), deps(api.fetch)),
    ).toMatchObject({ kind: "ok", notice: { kind: "error", error: "not_proposed" } });
  });

  it("says there is no such decision, asking the API only for a number", async () => {
    const api = fakeApi(() =>
      Response.json({ error: { code: "not_found", message: "No such decision" } }, { status: 404 }),
    );
    expect(await loadDecision(await input("8"), deps(api.fetch))).toEqual({
      kind: "not_found",
      person,
    });
    for (const number of ["0", "abc", "7.5", "-1", "1e3", "12345678901"]) {
      expect(await loadDecision(await input(number), deps(noCalls))).toEqual({
        kind: "not_found",
        person,
      });
    }
  });

  it("says when the API did not answer, and asks a signed-out visitor to sign in", async () => {
    const down = fakeApi(() => new Response(null, { status: 500 }));
    expect(await loadDecision(await input("7"), deps(down.fetch))).toEqual({
      kind: "failed",
      person,
      reason: "status_500",
    });
    expect(
      await loadDecision(
        { sessionCookie: undefined, number: "7", done: undefined, error: "signed_out" },
        deps(noCalls),
      ),
    ).toEqual({ kind: "signed_out", notice: { kind: "error", error: "signed_out" } });
  });
});

describe("handleDecisionAction", () => {
  const post = (
    path: string,
    options: { cookie?: string; headers?: Record<string, string>; form?: Record<string, string> },
  ) =>
    new Request(new URL(path, config.webBaseUrl), {
      method: "POST",
      headers: {
        origin: config.webBaseUrl,
        ...(options.cookie === undefined ? {} : { cookie: `${SESSION_COOKIE}=${options.cookie}` }),
        ...options.headers,
      },
      // The page's forms always send the wording they showed.
      body: new URLSearchParams({ wordingVersion: "1", ...(options.form ?? {}) }),
    });

  /** The API: the decision by number, and `result` for the action. */
  const api = (result: unknown, current: DecisionDetail = proposalDetail) =>
    fakeApi((call) =>
      call.method === "GET" ? Response.json(current) : Response.json(result, { status: 200 }),
    );

  const location = (res: Response) => res.headers.get("location");

  it("confirms as the person: looks the number up, posts to its id, and goes back", async () => {
    const fake = api({ status: "confirmed" });
    const res = await handleDecisionAction(
      post("/decisions/7/confirm", { cookie: await signedIn(), form: { actor: "U999" } }),
      "7",
      "confirm",
      deps(fake.fetch),
    );
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`${config.webBaseUrl}/decisions/7?done=confirmed`);
    expect(fake.calls).toEqual([
      { url: "https://api.example.test/v1/decisions/7", method: "GET", body: undefined },
      {
        url: `https://api.example.test/v1/decisions/${proposal.id}/confirm`,
        method: "POST",
        body: { wordingVersion: 1 },
      },
    ]);
  });

  it("rejects, and accepts Sec-Fetch-Site in place of Origin", async () => {
    const fake = api({ status: "rejected" });
    const res = await handleDecisionAction(
      post("/decisions/7/reject", {
        cookie: await signedIn(),
        headers: { origin: "", "sec-fetch-site": "same-origin" },
      }),
      "7",
      "reject",
      deps(fake.fetch),
    );
    expect(location(res)).toBe(`${config.webBaseUrl}/decisions/7?done=rejected`);
    expect(fake.calls[1]).toEqual({
      url: `https://api.example.test/v1/decisions/${proposal.id}/reject`,
      method: "POST",
      body: { wordingVersion: 1 },
    });
  });

  it("refuses a form on another site, or one that says nothing of where it came from", async () => {
    for (const headers of [
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { origin: "" },
    ]) {
      const d = deps(noCalls);
      const res = await handleDecisionAction(
        post("/decisions/7/confirm", { cookie: await signedIn(), headers }),
        "7",
        "confirm",
        d,
      );
      expect(res.status).toBe(403);
      expect(d.lines).toContainEqual(
        expect.objectContaining({ msg: "decision.action_refused", reason: "cross_origin" }),
      );
    }
  });

  it("refuses without a valid session, calling nothing", async () => {
    for (const cookie of [undefined, "forged"]) {
      const res = await handleDecisionAction(
        post("/decisions/7/confirm", cookie === undefined ? {} : { cookie }),
        "7",
        "confirm",
        deps(noCalls),
      );
      expect(res.status).toBe(303);
      expect(location(res)).toBe(`${config.webBaseUrl}/decisions/7?error=signed_out`);
    }
  });

  it("answers 404 for an action or a number it does not know", async () => {
    for (const [number, action] of [
      ["7", "delete"],
      ["abc", "confirm"],
      ["0", "edit"],
    ] as const) {
      const res = await handleDecisionAction(
        post(`/decisions/${number}/${action}`, { cookie: await signedIn() }),
        number,
        action,
        deps(noCalls),
      );
      expect(res.status).toBe(404);
    }
  });

  it("goes back with why when the API refuses or does not answer", async () => {
    const cases: [Response, Response | undefined, string][] = [
      [
        Response.json(proposalDetail),
        Response.json({ status: "not_allowed", reason: "not_in_thread" }),
        "error=not_in_thread",
      ],
      [
        Response.json(proposalDetail),
        Response.json({ status: "not_allowed", reason: "read_only" }),
        "error=read_only",
      ],
      [
        Response.json(proposalDetail),
        Response.json({ status: "not_allowed" }),
        "error=not_allowed",
      ],
      [
        Response.json(proposalDetail),
        Response.json({ status: "not_proposed" }),
        "error=not_proposed",
      ],
      [Response.json(proposalDetail), new Response(null, { status: 500 }), "error=failed"],
      [
        Response.json(
          { error: { code: "not_found", message: "No such decision" } },
          { status: 404 },
        ),
        undefined,
        "error=not_found",
      ],
      [new Response(null, { status: 502 }), undefined, "error=failed"],
    ];
    for (const [lookup, result, expected] of cases) {
      const fake = fakeApi((call) => (call.method === "GET" ? lookup : (result ?? lookup)));
      const res = await handleDecisionAction(
        post("/decisions/7/confirm", { cookie: await signedIn() }),
        "7",
        "confirm",
        deps(fake.fetch),
      );
      expect(location(res)).toBe(`${config.webBaseUrl}/decisions/7?${expected}`);
      if (result === undefined) expect(fake.calls).toHaveLength(1);
    }
  });

  it("edits: sends only what changed, clears an emptied reason, and never who acts", async () => {
    const fake = api({ status: "edited" });
    const res = await handleDecisionAction(
      post("/decisions/7/edit", {
        cookie: await signedIn(),
        form: {
          statement: "  Use Postgres full-text search\r\nfor now ",
          reason: "",
          area: "Search",
          actor: "U999",
          actorId: "U999",
        },
      }),
      "7",
      "edit",
      deps(fake.fetch),
    );
    expect(location(res)).toBe(`${config.webBaseUrl}/decisions/7?done=edited`);
    expect(fake.calls[1]).toEqual({
      url: `https://api.example.test/v1/decisions/${proposal.id}`,
      method: "PATCH",
      body: {
        wordingVersion: 1,
        statement: "Use Postgres full-text search\nfor now",
        reason: null,
      },
    });
  });

  it("calls nothing when the edit changes nothing or is too long", async () => {
    for (const [form, expected] of [
      [{ statement: "", reason: "It is already there", area: "Search" }, "error=unchanged"],
      [{ statement: proposal.statement }, "error=unchanged"],
      [{ statement: "x".repeat(501), reason: "", area: "" }, "error=invalid"],
      [{ area: "a".repeat(101) }, "error=invalid"],
    ] as const) {
      const fake = api({ status: "edited" });
      const res = await handleDecisionAction(
        post("/decisions/7/edit", { cookie: await signedIn(), form }),
        "7",
        "edit",
        deps(fake.fetch),
      );
      expect(location(res)).toBe(`${config.webBaseUrl}/decisions/7?${expected}`);
      expect(fake.calls.filter((call) => call.method !== "GET")).toEqual([]);
    }
  });
});

describe("editFromForm", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.set(name, value);
    return data;
  };

  it("clears an emptied reason or area, keeps an emptied statement, and leaves out a missing field", () => {
    const v = { wordingVersion: "1" };
    expect(editFromForm(form({ ...v, statement: "", reason: " ", area: "" }), proposal)).toEqual({
      kind: "edit",
      edit: { wordingVersion: 1, reason: null, area: null },
    });
    expect(editFromForm(form({ ...v, area: "Billing" }), proposal)).toEqual({
      kind: "edit",
      edit: { wordingVersion: 1, area: "Billing" },
    });
    expect(
      editFromForm(form({ ...v, reason: "", area: "" }), { ...proposal, reason: null, area: null }),
    ).toEqual({ kind: "unchanged" });
  });

  it("sends the wording the form showed, and refuses a form without it (decision 203)", () => {
    expect(editFromForm(form({ wordingVersion: "3", area: "x" }), proposal)).toEqual({
      kind: "edit",
      edit: { wordingVersion: 3, area: "x" },
    });
    expect(editFromForm(form({ area: "x" }), proposal)).toEqual({ kind: "invalid" });
    expect(editFromForm(form({ wordingVersion: "0", area: "x" }), proposal)).toEqual({
      kind: "invalid",
    });
  });

  it("says when someone changed the wording meanwhile, and who a proposal was taken over from", () => {
    expect(noticeText({ kind: "error", error: "changed" }, proposal)).toMatch(/^Someone changed/);
    const items = historyItems({
      ...proposalDetail,
      decision: { ...proposal, decidedBy: { actorId: "U2", name: "Mallory" } },
      history: [
        {
          kind: "edited",
          actor: { actorId: "U2", name: "Mallory" },
          at: "2026-11-25T10:00:00.000Z",
          before: {
            statement: "Old.",
            reason: null,
            area: null,
            decidedBy: { actorId: "U1", name: "Ada" },
          },
          after: { statement: "New.", reason: null, area: null },
        },
      ],
    });
    expect(items.map((item) => item.text)).toEqual([
      "Proposed by Ada",
      "Reworded by Mallory, so it is in their name now",
    ]);
  });
});

describe("how a decision is worded", () => {
  it("links to the message it came from, or names its log entry", () => {
    expect(whereDecided(proposal)).toEqual({
      kind: "link",
      href: "https://slack.com/archives/C1/p1700000200?thread_ts=1700.000100&cid=C1",
      text: "the message in Slack",
    });
    expect(whereDecided({ ...proposal, messageId: null })).toEqual({
      kind: "link",
      href: "https://slack.com/archives/C1/p1700000100",
      text: "the thread in Slack",
    });
    expect(
      whereDecided({
        ...proposal,
        origin: "import",
        originRef: "42",
        channelId: null,
        threadId: null,
        messageId: null,
      }),
    ).toEqual({ kind: "text", text: "decisions.md entry 42" });
    expect(
      whereDecided({ ...proposal, channelId: null, threadId: null, messageId: null }),
    ).toBeUndefined();
  });

  it("says why a person may not act, and that mentioning the bot counts in a teammate's thread", () => {
    expect(notAllowedText("not_in_thread", proposal)).toBe(
      "Only people who wrote in the thread it came from, or the owner of its area, can confirm or change it. Mentioning @hippidy in that thread counts.",
    );
    expect(notAllowedText("not_in_thread", { ...proposal, origin: "capture" })).toBe(
      "Only people who wrote in the thread it came from, or the owner of its area, can confirm or change it.",
    );
    expect(notAllowedText("read_only", proposal)).toBe(
      "Imported from the decision log; change it there.",
    );
    expect(noticeText({ kind: "error", error: "not_in_thread" }, proposal)).toBe(
      notAllowedText("not_in_thread", proposal),
    );
    expect(notAllowedText("not_decider", proposal)).toMatch(
      /^It would replace someone else's decision, so only the people who decide it can confirm/,
    );
    expect(notAllowedText("not_decider", proposal)).not.toMatch(/withdraw/);
    expect(WITHDRAW_TEXT).toMatch(/withdraw/);
    expect(noticeText({ kind: "error", error: "not_decider" }, proposal)).toBe(
      notAllowedText("not_decider", proposal),
    );
    expect(notProposedText({ ...proposal, status: "active" })).toMatch(/replaces it/);
    expect(notProposedText({ ...proposal, status: "rejected" })).toBeUndefined();
  });

  it("reads only the notices this app sends", () => {
    expect(actionNotice("edited", undefined)).toEqual({ kind: "done", done: "edited" });
    expect(actionNotice(undefined, "read_only")).toEqual({ kind: "error", error: "read_only" });
    expect(actionNotice("nope", "nope")).toBeUndefined();
  });

  it("says how long ago for the last month, then the date", () => {
    expect(when("2026-11-25T11:00:00.000Z", now)).toBe("1 h ago");
    expect(when("2025-01-02T11:00:00.000Z", now)).toBe("on 2025-01-02");
  });

  it("lists its history, oldest first, with what each edit changed", () => {
    const items = historyItems({
      ...proposalDetail,
      decision: { ...proposal, status: "active" },
      history: [
        {
          kind: "edited",
          actor: { actorId: "U2", name: "Bea" },
          at: "2026-11-25T10:30:00.000Z",
          before: { statement: "Use PG", reason: "It is already there", area: null },
          after: {
            statement: "Use Postgres for search",
            reason: "It is already there",
            area: "Search",
          },
        },
        {
          kind: "confirmed",
          actor: { actorId: "U3", name: null },
          at: "2026-11-25T11:00:00.000Z",
          before: null,
          after: null,
        },
      ],
    });
    expect(items).toEqual([
      { key: "recorded", text: "Proposed by Ada", at: proposal.decidedAt, changes: [] },
      {
        key: "0:edited",
        text: "Edited by Bea",
        at: "2026-11-25T10:30:00.000Z",
        changes: [
          { field: "Statement", before: "Use PG", after: "Use Postgres for search" },
          { field: "Area", before: "(none)", after: "Search" },
        ],
      },
      { key: "1:confirmed", text: "Confirmed by U3", at: "2026-11-25T11:00:00.000Z", changes: [] },
    ]);
  });
});
