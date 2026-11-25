import type { Conflict, ConflictDetail } from "@hippidy/contracts";
import { describe, expect, it } from "vitest";
import {
  conflictHref,
  conflictsHref,
  conflictThread,
  decidersText,
  handleSettleConflict,
  loadConflict,
  loadConflicts,
  namesOr,
  refusalText,
  settleAbout,
  settleFromForm,
  settleNotice,
  settleNoticeText,
} from "./conflicts.ts";
import { SESSION_COOKIE } from "./cookies.ts";
import type { HomeDeps } from "./home.ts";
import { memoryLogger } from "./log.ts";
import type { Fetch } from "./slack-oidc.ts";
import { config, conflict, conflictDetail } from "./testing.ts";
import { signSession, type Person } from "./tokens.ts";

const person: Person = { actorId: "U0123456789", workspaceId: "T0123456789", name: "Ilya" };
const now = new Date("2026-11-25T12:00:00.000Z");

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
const notFound = () =>
  Response.json({ error: { code: "not_found", message: "No such conflict" } }, { status: 404 });

/** The same conflict, with a proposal that would replace decision 7. */
const replacement: Conflict = {
  ...conflict,
  kind: "replacement",
  proposal: {
    number: 12,
    statement: "Search moves to a vector index",
    status: "proposed",
    decidedBy: { actorId: "U3", name: "Linus" },
  },
};

describe("loadConflicts", () => {
  it("reads the open ones by default, as the person", async () => {
    const api = fakeApi(() => Response.json({ conflicts: [conflict] }));
    expect(
      await loadConflicts({ sessionCookie: await signedIn(), status: undefined }, deps(api.fetch)),
    ).toEqual({
      kind: "signed_in",
      person,
      filter: "open",
      list: { kind: "ok", value: [conflict] },
      truncated: false,
      readAt: now.toISOString(),
    });
    expect(api.calls.map((call) => call.url)).toEqual([
      "https://api.example.test/v1/conflicts?status=open&limit=200",
    ]);
  });

  it("reads the settled ones or all on request, and ignores a filter it does not know", async () => {
    const api = fakeApi(() => Response.json({ conflicts: [] }));
    for (const status of ["settled", "all", "<b>"]) {
      await loadConflicts({ sessionCookie: await signedIn(), status }, deps(api.fetch));
    }
    expect(api.calls.map((call) => call.url)).toEqual([
      "https://api.example.test/v1/conflicts?status=settled&limit=200",
      "https://api.example.test/v1/conflicts?status=all&limit=200",
      "https://api.example.test/v1/conflicts?status=open&limit=200",
    ]);
  });

  it("says when some may not be shown, and when the API did not answer", async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ ...conflict, number: i + 1 }));
    const full = fakeApi(() => Response.json({ conflicts: many }));
    expect(
      await loadConflicts({ sessionCookie: await signedIn(), status: "all" }, deps(full.fetch)),
    ).toMatchObject({ truncated: true, filter: "all" });
    const down = fakeApi(() => new Response(null, { status: 503 }));
    expect(
      await loadConflicts({ sessionCookie: await signedIn(), status: undefined }, deps(down.fetch)),
    ).toMatchObject({
      kind: "signed_in",
      list: { kind: "failed", reason: "status_503" },
      truncated: false,
    });
  });

  it("asks a signed-out visitor to sign in, and calls nothing", async () => {
    expect(
      await loadConflicts({ sessionCookie: "forged", status: undefined }, deps(noCalls)),
    ).toEqual({ kind: "signed_out" });
    expect(
      await loadConflicts(
        { sessionCookie: await signedIn(), status: undefined },
        { ...deps(noCalls), config: undefined },
      ),
    ).toEqual({ kind: "unconfigured" });
  });
});

describe("loadConflict", () => {
  const input = async (number: string, done?: string, error?: string) => ({
    sessionCookie: await signedIn(),
    number,
    done,
    error,
  });

  it("reads the conflict by its number, with a notice this app sent", async () => {
    const api = fakeApi(() => Response.json(conflictDetail));
    expect(await loadConflict(await input("3", "settled"), deps(api.fetch))).toEqual({
      kind: "ok",
      person,
      detail: conflictDetail,
      notice: { kind: "done", done: "settled" },
      readAt: now.toISOString(),
    });
    expect(api.calls[0]?.url).toBe("https://api.example.test/v1/conflicts/3");
    expect(await loadConflict(await input("3", "hacked", "<b>"), deps(api.fetch))).toMatchObject({
      kind: "ok",
      notice: undefined,
    });
  });

  it("does not repeat a refusal the page gives in place of the form", async () => {
    const refused: ConflictDetail = { conflict, youMay: { settle: false, reason: "not_decider" } };
    const api = fakeApi(() => Response.json(refused));
    expect(
      await loadConflict(await input("3", undefined, "not_decider"), deps(api.fetch)),
    ).toMatchObject({ kind: "ok", notice: undefined });
    expect(
      await loadConflict(await input("3", undefined, "already_settled"), deps(api.fetch)),
    ).toMatchObject({ kind: "ok", notice: { kind: "error", error: "already_settled" } });
  });

  it("says there is no such conflict, asking the API only for a number", async () => {
    const api = fakeApi(notFound);
    expect(await loadConflict(await input("9"), deps(api.fetch))).toEqual({
      kind: "not_found",
      person,
    });
    for (const number of ["0", "abc", "3.5", "-1", "12345678901"]) {
      expect(await loadConflict(await input(number), deps(noCalls))).toEqual({
        kind: "not_found",
        person,
      });
    }
  });

  it("says when the API did not answer, and asks a signed-out visitor to sign in", async () => {
    const down = fakeApi(() => new Response(null, { status: 502 }));
    expect(await loadConflict(await input("3"), deps(down.fetch))).toEqual({
      kind: "failed",
      person,
      reason: "status_502",
    });
    expect(
      await loadConflict(
        { sessionCookie: undefined, number: "3", done: undefined, error: "signed_out" },
        deps(noCalls),
      ),
    ).toEqual({ kind: "signed_out", notice: { kind: "error", error: "signed_out" } });
  });
});

describe("settleFromForm", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.set(name, value);
    return data;
  };

  it("takes the outcome and a trimmed note, leaving out an empty one", () => {
    expect(settleFromForm(form({ outcome: "kept", note: "  Postgres stays\r\nfor now " }))).toEqual(
      { kind: "settle", settle: { outcome: "kept", note: "Postgres stays\nfor now" } },
    );
    expect(settleFromForm(form({ outcome: "dismissed", note: "  " }))).toEqual({
      kind: "settle",
      settle: { outcome: "dismissed" },
    });
    expect(settleFromForm(form({ outcome: "changed" }))).toEqual({
      kind: "settle",
      settle: { outcome: "changed" },
    });
  });

  it("refuses a missing or unknown outcome, and a note over 500 characters", () => {
    for (const fields of [
      {},
      { outcome: "" },
      { outcome: "won" },
      { outcome: "kept", note: "n".repeat(501) },
    ]) {
      expect(settleFromForm(form(fields))).toEqual({ kind: "invalid" });
    }
    expect(settleFromForm(form({ outcome: "kept", note: "n".repeat(500) }))).toMatchObject({
      kind: "settle",
    });
  });
});

describe("handleSettleConflict", () => {
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
      body: new URLSearchParams(options.form ?? {}),
    });

  /** The API: the conflict by number, and `result` for settling it. */
  const api = (result: Response, current: ConflictDetail = conflictDetail) =>
    fakeApi((call) => (call.method === "GET" ? Response.json(current) : result));

  const location = (res: Response) => res.headers.get("location");

  const settle = async (form: Record<string, string>, fetch: Fetch, number = "3") =>
    handleSettleConflict(
      post(`/conflicts/${number}/settle`, { cookie: await signedIn(), form }),
      number,
      deps(fetch),
    );

  it("settles as the person: looks the number up, posts to its id, and goes back", async () => {
    const settled = { ...conflict, status: "settled" as const, outcome: "kept" as const };
    const fake = api(Response.json({ status: "settled", conflict: settled }));
    const res = await settle(
      { outcome: "kept", note: " Postgres stays ", actor: "U999", actorId: "U999" },
      fake.fetch,
    );
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`${config.webBaseUrl}/conflicts/3?done=settled`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(fake.calls).toEqual([
      { url: "https://api.example.test/v1/conflicts/3", method: "GET", body: undefined },
      {
        url: `https://api.example.test/v1/conflicts/${conflict.id}/settle`,
        method: "POST",
        body: { outcome: "kept", note: "Postgres stays" },
      },
    ]);
  });

  it("accepts Sec-Fetch-Site in place of Origin", async () => {
    const fake = api(Response.json({ status: "settled", conflict }));
    const res = await handleSettleConflict(
      post("/conflicts/3/settle", {
        cookie: await signedIn(),
        headers: { origin: "", "sec-fetch-site": "same-origin" },
        form: { outcome: "dismissed" },
      }),
      "3",
      deps(fake.fetch),
    );
    expect(location(res)).toBe(`${config.webBaseUrl}/conflicts/3?done=settled`);
  });

  it("refuses a form on another site, or one that says nothing of where it came from", async () => {
    for (const headers of [
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { origin: "" },
    ]) {
      const d = deps(noCalls);
      const res = await handleSettleConflict(
        post("/conflicts/3/settle", {
          cookie: await signedIn(),
          headers,
          form: { outcome: "kept" },
        }),
        "3",
        d,
      );
      expect(res.status).toBe(403);
      expect(d.lines).toContainEqual(
        expect.objectContaining({ msg: "conflict.settle_refused", reason: "cross_origin" }),
      );
    }
  });

  it("refuses without a valid session or configuration, calling nothing", async () => {
    for (const cookie of [undefined, "forged"]) {
      const res = await handleSettleConflict(
        post("/conflicts/3/settle", {
          ...(cookie === undefined ? {} : { cookie }),
          form: { outcome: "kept" },
        }),
        "3",
        deps(noCalls),
      );
      expect(location(res)).toBe(`${config.webBaseUrl}/conflicts/3?error=signed_out`);
    }
    const res = await handleSettleConflict(
      post("/conflicts/3/settle", {
        cookie: await signedIn(),
        headers: { "sec-fetch-site": "same-origin" },
        form: { outcome: "kept" },
      }),
      "3",
      { ...deps(noCalls), config: undefined },
    );
    expect(res.status).toBe(303);
    expect(location(res)).toContain("/conflicts/3?error=unavailable");
  });

  it("answers 404 for a number it does not know, and calls nothing for an invalid form", async () => {
    for (const number of ["0", "abc", "-1"]) {
      const res = await settle({ outcome: "kept" }, noCalls, number);
      expect(res.status).toBe(404);
    }
    for (const form of [{}, { outcome: "won" }, { outcome: "kept", note: "n".repeat(501) }]) {
      const res = await settle(form, noCalls);
      expect(location(res)).toBe(`${config.webBaseUrl}/conflicts/3?error=invalid`);
    }
  });

  it("goes back with why when the API refuses or does not answer", async () => {
    const cases: [Response, Response | undefined, string][] = [
      [notFound(), undefined, "error=not_found"],
      [new Response(null, { status: 500 }), undefined, "error=failed"],
      [
        Response.json(conflictDetail),
        Response.json({ status: "not_allowed", reason: "not_decider", conflict }),
        "error=not_decider",
      ],
      [
        Response.json(conflictDetail),
        Response.json({ status: "not_allowed", reason: "has_proposal", conflict }),
        "error=has_proposal",
      ],
      [
        Response.json(conflictDetail),
        Response.json({ status: "not_allowed", reason: "settled", conflict }),
        "error=already_settled",
      ],
      [Response.json(conflictDetail), Response.json({ status: "not_found" }), "error=not_found"],
      [Response.json(conflictDetail), new Response(null, { status: 503 }), "error=failed"],
      [Response.json(conflictDetail), Response.json({ status: "won" }), "error=failed"],
    ];
    for (const [lookup, result, expected] of cases) {
      const fake = fakeApi((call) =>
        call.method === "GET" ? lookup : (result ?? new Response(null, { status: 500 })),
      );
      const res = await settle({ outcome: "kept" }, fake.fetch);
      expect(location(res)).toBe(`${config.webBaseUrl}/conflicts/3?${expected}`);
    }
  });
});

describe("how a conflict is worded", () => {
  it("links to its page, and to the list by filter", () => {
    expect(conflictHref(3)).toBe("/conflicts/3");
    expect(conflictsHref("open")).toBe("/conflicts");
    expect(conflictsHref("settled")).toBe("/conflicts?status=settled");
  });

  it("names who decides, or that nobody is set to", () => {
    expect(namesOr([])).toBe("");
    expect(namesOr(["Ada"])).toBe("Ada");
    expect(namesOr(["Ada", "Grace"])).toBe("Ada or Grace");
    expect(namesOr(["Ada", "Grace", "Linus"])).toBe("Ada, Grace or Linus");
    expect(
      decidersText([
        { actorId: "U1", name: "Ada" },
        { actorId: "U2", name: null },
      ]),
    ).toBe("Ada or U2");
    expect(decidersText([])).toBe("Nobody is set to decide it");
  });

  it("says why a person may not settle it", () => {
    expect(refusalText("not_decider", conflict)).toBe("Only the people named decide it: Ada.");
    expect(refusalText("not_decider", { ...conflict, deciders: [] })).toMatch(
      /^Nobody is set to decide it/,
    );
    expect(refusalText("has_proposal", replacement)).toBe(
      "It is settled by confirming or rejecting its proposal, decision 12.",
    );
    expect(settleNoticeText({ kind: "error", error: "not_decider" }, conflict)).toBe(
      "Not settled. Only the people named decide it: Ada.",
    );
    expect(settleNoticeText({ kind: "done", done: "settled" }, conflict)).toBe("Settled.");
  });

  it("reads only the notices this app sends", () => {
    expect(settleNotice("settled", undefined)).toEqual({ kind: "done", done: "settled" });
    expect(settleNotice(undefined, "has_proposal")).toEqual({
      kind: "error",
      error: "has_proposal",
    });
    expect(settleNotice(undefined, "settled")).toBeUndefined();
    expect(settleNotice("nope", "nope")).toBeUndefined();
  });

  it("links to the thread it came up in, or its channel", () => {
    expect(conflictThread(conflict)).toEqual({
      kind: "link",
      href: "https://slack.com/archives/C1/p1700000100",
      text: "the thread in Slack",
    });
    expect(conflictThread({ ...conflict, threadId: null })).toEqual({
      kind: "link",
      href: "https://slack.com/archives/C1",
      text: "the channel in Slack",
    });
    expect(conflictThread({ ...conflict, channelId: null, threadId: null })).toBeUndefined();
  });

  it("says the thread gets a note only where one is posted", () => {
    expect(settleAbout(conflict)).toMatch(/thread it came from gets a note/);
    expect(settleAbout({ ...conflict, kind: "capture" })).not.toMatch(/thread/);
    expect(settleAbout({ ...conflict, conversationId: null })).not.toMatch(/thread/);
  });
});
