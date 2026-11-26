import type { Wait } from "@hippidy/contracts";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "./cookies.ts";
import type { HomeDeps } from "./home.ts";
import { memoryLogger } from "./log.ts";
import type { Fetch } from "./slack-oidc.ts";
import { config, wait } from "./testing.ts";
import { signSession, type Person } from "./tokens.ts";
import {
  endWaitPath,
  groupByWaitingOn,
  handleWaitAction,
  loadWaits,
  sinceText,
  waitedFor,
  waitErrors,
  waitFromForm,
  waitIdFromPath,
  waitingOnOptions,
  waitNotice,
  waitNoticeText,
  waitsHref,
  waitThread,
  youArePart,
} from "./waits.ts";

const person: Person = { actorId: "U0123456789", workspaceId: "T0123456789", name: "Ilya" };
const now = new Date("2026-11-25T12:00:00.000Z");
const people = [
  { actorId: "U1", name: "Ada" },
  { actorId: "U2", name: "Grace" },
];

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

function reads(call: Call): Response {
  if (call.url.endsWith("/v1/people")) return Response.json({ people });
  return Response.json({ waits: [wait] });
}

function deps(fetch: Fetch): HomeDeps & { lines: Record<string, unknown>[] } {
  const { log, lines } = memoryLogger();
  return { config, fetch, log, now: () => now, lines };
}

const noCalls: Fetch = () => Promise.reject(new Error("no call expected"));
const signedIn = () => signSession(person, config.sessionSecret, now);

describe("addresses", () => {
  it("leaves out the default filter, and reads a wait's id only when it is one", () => {
    expect(waitsHref("open")).toBe("/waits");
    expect(waitsHref("ended")).toBe("/waits?status=ended");
    expect(endWaitPath(wait.id)).toBe(`/waits/${wait.id}/end`);
    expect(waitIdFromPath(wait.id.toUpperCase())).toBe(wait.id);
    for (const text of ["", "2", "not-a-guid", `${wait.id}x`]) {
      expect(waitIdFromPath(text)).toBeUndefined();
    }
  });
});

describe("loadWaits", () => {
  const input = async (status?: string, done?: string, error?: string) => ({
    sessionCookie: await signedIn(),
    status,
    done,
    error,
  });

  it("reads the open waits and the people known, as the person, with a notice this app sent", async () => {
    const api = fakeApi(reads);
    expect(await loadWaits(await input(undefined, "recorded"), deps(api.fetch))).toEqual({
      kind: "signed_in",
      person,
      filter: "open",
      list: { kind: "ok", value: [wait] },
      people: { kind: "ok", value: people },
      truncated: false,
      notice: { kind: "done", done: "recorded" },
      readAt: now.toISOString(),
    });
    expect(api.calls.map((call) => call.url).sort()).toEqual([
      "https://api.example.test/v1/people",
      "https://api.example.test/v1/waits?status=open&limit=200",
    ]);
  });

  it("reads the ended ones on request, and ignores what it does not know", async () => {
    const api = fakeApi(reads);
    expect(await loadWaits(await input("ended"), deps(api.fetch))).toMatchObject({
      filter: "ended",
    });
    expect(await loadWaits(await input("all", "hacked", "<b>"), deps(api.fetch))).toMatchObject({
      filter: "open",
      notice: undefined,
    });
    expect(api.calls.map((call) => call.url).filter((url) => url.includes("/waits"))).toEqual([
      "https://api.example.test/v1/waits?status=ended&limit=200",
      "https://api.example.test/v1/waits?status=open&limit=200",
    ]);
  });

  it("says when the API did not answer, and asks a signed-out visitor to sign in", async () => {
    const down = fakeApi(() => new Response(null, { status: 503 }));
    expect(await loadWaits(await input(), deps(down.fetch))).toMatchObject({
      list: { kind: "failed", reason: "status_503" },
      people: { kind: "failed", reason: "status_503" },
      truncated: false,
    });
    expect(
      await loadWaits(
        { sessionCookie: undefined, status: undefined, done: undefined, error: "signed_out" },
        deps(noCalls),
      ),
    ).toEqual({ kind: "signed_out", notice: { kind: "error", error: "signed_out" } });
    expect(
      await loadWaits(
        { sessionCookie: "forged", status: undefined, done: undefined, error: undefined },
        { ...deps(noCalls), config: undefined },
      ),
    ).toEqual({ kind: "unconfigured" });
  });
});

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

const location = (res: Response) => res.headers.get("location");

describe("handleWaitAction: record", () => {
  const record = async (form: Record<string, string>, fetch: Fetch) =>
    handleWaitAction(
      post("/new-wait", { cookie: await signedIn(), form }),
      "record",
      undefined,
      deps(fetch),
    );

  it("records the person's own wait, never reading who waits from the form", async () => {
    const api = fakeApi(() => Response.json({ status: "recorded", wait }, { status: 201 }));
    const res = await record(
      {
        waiting_on: "U1",
        what: "  review the ranking ",
        task: " t-4 ",
        waiter: "U999",
        waiterActorId: "U999",
      },
      api.fetch,
    );
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`${config.webBaseUrl}/waits?done=recorded`);
    expect(api.calls).toEqual([
      {
        url: "https://api.example.test/v1/waits",
        method: "POST",
        body: { waitingOnActorId: "U1", what: "review the ranking", taskKey: "T-4" },
      },
    ]);
  });

  it("leaves out an empty task key", async () => {
    const api = fakeApi(() => Response.json({ status: "recorded", wait }, { status: 201 }));
    await record({ waiting_on: "U1", what: "a review", task: "" }, api.fetch);
    expect(api.calls[0]?.body).toEqual({ waitingOnActorId: "U1", what: "a review" });
  });

  it("calls nothing for a form the API would refuse", async () => {
    for (const form of [
      {},
      { waiting_on: "", what: "a review" },
      { waiting_on: "U1", what: " " },
      { waiting_on: "U1", what: "w".repeat(301) },
      { waiting_on: "U1", what: "a review", task: "not a key" },
    ]) {
      const res = await record(form, noCalls);
      expect(location(res)).toBe(`${config.webBaseUrl}/waits?error=invalid`);
    }
  });

  it("goes back with why when the API refuses or does not answer", async () => {
    for (const [answer, expected] of [
      [Response.json({ status: "unknown_person" }), "error=unknown_person"],
      [Response.json({ status: "ended", wait }), "error=failed"],
      [new Response(null, { status: 500 }), "error=failed"],
    ] as const) {
      const api = fakeApi(() => answer);
      const res = await record({ waiting_on: "U1", what: "a review" }, api.fetch);
      expect(location(res)).toBe(`${config.webBaseUrl}/waits?${expected}`);
    }
  });
});

describe("handleWaitAction: end", () => {
  const end = async (id: string, fetch: Fetch, cookie?: string) =>
    handleWaitAction(
      post(`/waits/${id}/end`, { cookie: cookie ?? (await signedIn()) }),
      "end",
      id,
      deps(fetch),
    );

  it("ends it as the person, with an empty body", async () => {
    const api = fakeApi(() =>
      Response.json({ status: "ended", wait: { ...wait, status: "ended" } }),
    );
    const res = await end(wait.id, api.fetch);
    expect(location(res)).toBe(`${config.webBaseUrl}/waits?done=ended`);
    expect(api.calls).toEqual([
      { url: `https://api.example.test/v1/waits/${wait.id}/end`, method: "POST", body: {} },
    ]);
  });

  it("goes back with why when the API refuses or does not answer", async () => {
    for (const [answer, expected] of [
      [Response.json({ status: "not_allowed" }), "error=not_allowed"],
      [Response.json({ status: "already_ended", wait }), "error=already_ended"],
      [Response.json({ status: "not_found" }), "error=not_found"],
      [Response.json({ status: "recorded", wait }), "error=failed"],
      [new Response(null, { status: 404 }), "error=failed"],
    ] as const) {
      const api = fakeApi(() => answer);
      const res = await end(wait.id, api.fetch);
      expect(location(res)).toBe(`${config.webBaseUrl}/waits?${expected}`);
    }
  });

  it("answers 404 for an id that cannot be one, and refuses another site or no session", async () => {
    expect((await end("2", noCalls)).status).toBe(404);
    const d = deps(noCalls);
    const refused = await handleWaitAction(
      post(`/waits/${wait.id}/end`, {
        cookie: await signedIn(),
        headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      }),
      "end",
      wait.id,
      d,
    );
    expect(refused.status).toBe(403);
    expect(d.lines).toContainEqual(
      expect.objectContaining({ msg: "wait.action_refused", reason: "cross_origin" }),
    );
    const signedOut = await end(wait.id, noCalls, "forged");
    expect(location(signedOut)).toBe(`${config.webBaseUrl}/waits?error=signed_out`);
    const unconfigured = await handleWaitAction(
      post(`/waits/${wait.id}/end`, { headers: { "sec-fetch-site": "same-origin" } }),
      "end",
      wait.id,
      { ...deps(noCalls), config: undefined },
    );
    expect(location(unconfigured)).toBe(`${config.webBaseUrl}/waits?error=unavailable`);
  });
});

describe("the form's fields", () => {
  it("records from the fields, or says the form is invalid", () => {
    const form = new FormData();
    form.set("waiting_on", "U1");
    form.set("what", "a review");
    expect(waitFromForm(form)).toEqual({
      kind: "record",
      wait: { waitingOnActorId: "U1", what: "a review" },
    });
    expect(waitFromForm(new FormData())).toEqual({ kind: "invalid" });
  });
});

describe("how a wait is worded", () => {
  const on = (actorId: string, name: string, since: string, extra: Partial<Wait> = {}): Wait => ({
    ...wait,
    id: `${actorId}-${since}`,
    waitingOn: { actorId, name },
    since,
    ...extra,
  });

  it("groups by the person waited on, alphabetically, the longest waiting first", () => {
    const groups = groupByWaitingOn([
      on("U3", "linus", "2026-11-25T08:00:00.000Z"),
      on("U1", "Ada", "2026-11-25T09:00:00.000Z"),
      on("U3", "linus", "2026-11-24T08:00:00.000Z"),
    ]);
    expect(groups.map((group) => [group.label, group.waits.map((w) => w.since)])).toEqual([
      ["Ada", ["2026-11-25T09:00:00.000Z"]],
      ["linus", ["2026-11-24T08:00:00.000Z", "2026-11-25T08:00:00.000Z"]],
    ]);
  });

  it("puts the latest ended first once they have ended", () => {
    const ended = (since: string, endedAt: string) =>
      on("U1", "Ada", since, { status: "ended", endedAt, endedBy: { actorId: "U1", name: "Ada" } });
    const groups = groupByWaitingOn([
      ended("2026-11-20T08:00:00.000Z", "2026-11-21T08:00:00.000Z"),
      ended("2026-11-22T08:00:00.000Z", "2026-11-24T08:00:00.000Z"),
    ]);
    expect(groups[0]?.waits.map((w) => w.endedAt)).toEqual([
      "2026-11-24T08:00:00.000Z",
      "2026-11-21T08:00:00.000Z",
    ]);
  });

  it("lets its people end it: who waits, who is waited on, and who recorded it", () => {
    const as = (actorId: string): Person => ({ ...person, actorId });
    expect(youArePart(wait, as("U2"))).toBe(true);
    expect(youArePart(wait, as("U1"))).toBe(true);
    expect(youArePart(wait, as("B1"))).toBe(true);
    expect(youArePart(wait, as("U3"))).toBe(false);
  });

  it("says how long and since when", () => {
    expect(waitedFor("2026-11-25T11:59:30.000Z", now)).toBe("a moment");
    expect(waitedFor("2026-11-25T11:55:00.000Z", now)).toBe("5 min");
    expect(waitedFor("2026-11-25T09:00:00.000Z", now)).toBe("3 h");
    expect(waitedFor("2026-11-24T11:00:00.000Z", now)).toBe("1 day");
    expect(sinceText(wait.since, now)).toBe("since 2026-11-23 (2 days)");
  });

  it("links the thread it was said in, if any", () => {
    expect(waitThread(wait)).toEqual({
      kind: "link",
      href: "https://slack.com/archives/C1/p1700000100",
      text: "the thread in Slack",
    });
    expect(
      waitThread({ ...wait, conversationId: null, channelId: null, threadId: null }),
    ).toBeUndefined();
  });

  it("offers the people known, without you, each once, by name", () => {
    expect(
      waitingOnOptions(
        {
          kind: "ok",
          value: [
            { actorId: "U2", name: "Grace" },
            { actorId: person.actorId, name: "Ilya" },
            { actorId: "U1", name: "Ada" },
            { actorId: "U2", name: "Grace" },
          ],
        },
        person,
      ),
    ).toEqual([
      { value: "U1", label: "Ada" },
      { value: "U2", label: "Grace" },
    ]);
    expect(waitingOnOptions({ kind: "failed", reason: "status_503" }, person)).toEqual([]);
  });

  it("reads only the notices this app sends, and words each", () => {
    expect(waitNotice("ended", undefined)).toEqual({ kind: "done", done: "ended" });
    expect(waitNotice(undefined, "not_allowed")).toEqual({ kind: "error", error: "not_allowed" });
    expect(waitNotice("hacked", "<b>")).toBeUndefined();
    for (const error of waitErrors) {
      expect(waitNoticeText({ kind: "error", error })).not.toBe("");
    }
  });
});
