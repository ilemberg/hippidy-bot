import { describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "./cookies.ts";
import {
  goalCreateFromForm,
  goalEditFromForm,
  handleGoalEdit,
  handleNewGoal,
  loadNewGoal,
  openText,
  threadFromLink,
  ticketRows,
  ticketsFieldValue,
  ticketsFromText,
} from "./goals.ts";
import type { HomeDeps } from "./home.ts";
import { jobHistoryItems, jobNotice, jobNoticeText } from "./jobs.ts";
import { memoryLogger } from "./log.ts";
import type { Fetch } from "./slack-oidc.ts";
import { config, goal, goalDetail, jobDetail } from "./testing.ts";
import { signSession, type Person } from "./tokens.ts";

// Slice 4.4 (decision 221): "New goal" and a goal's tickets in the web app, over a fake API.

const person: Person = { actorId: "U0123456789", workspaceId: "T0123456789", name: "Ilya" };
const now = new Date("2026-11-26T12:00:00.000Z");

interface Call {
  url: string;
  method: string;
  body: unknown;
}

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
const location = (res: Response) => res.headers.get("location");

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

const formData = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

const LINK = "https://acme.slack.com/archives/C123ABC/p1700000000000200";

describe("a thread's link", () => {
  it("reads the channel and thread of a Slack link, a reply's included", () => {
    expect(threadFromLink(` ${LINK} `)).toEqual({
      channelId: "C123ABC",
      threadId: "1700000000.000200",
    });
    expect(
      threadFromLink(
        "https://acme.slack.com/archives/C123ABC/p1700000099000300?thread_ts=1700000000.000200&cid=C123ABC",
      ),
    ).toEqual({ channelId: "C123ABC", threadId: "1700000000.000200" });
    expect(threadFromLink("https://app.slack.com/archives/G0AB12/p1700000000000200")).toEqual({
      channelId: "G0AB12",
      threadId: "1700000000.000200",
    });
  });

  it("is nothing for anything else", () => {
    for (const text of [
      "",
      "C123ABC",
      "http://acme.slack.com/archives/C123ABC/p1700000000000200",
      "https://acme.slack.com.evil.example/archives/C123ABC/p1700000000000200",
      "https://acme.slack.com/archives/c123abc/p1700000000000200",
      "https://acme.slack.com/archives/C123ABC/1700000000000200",
      "https://acme.slack.com/archives/C123ABC/p1700000000000200?thread_ts=x",
      "https://acme.slack.com/messages/C123ABC/p1700000000000200",
    ]) {
      expect(threadFromLink(text)).toBeUndefined();
    }
  });
});

describe("a goal's tickets as typed", () => {
  it("reads keys one per line or separated by commas, in order, each once", () => {
    expect(ticketsFromText("t-4\nT-5, T-6;scrum-8  T-4")).toEqual(["T-4", "T-5", "T-6", "SCRUM-8"]);
    expect(ticketsFromText("")).toBeUndefined();
    expect(ticketsFromText("T-4 export")).toBeUndefined();
    expect(ticketsFromText("T-0")).toBeUndefined();
    expect(
      ticketsFromText(Array.from({ length: 31 }, (_, i) => `T-${String(i + 1)}`).join(",")),
    ).toBeUndefined();
  });
});

describe("goalCreateFromForm", () => {
  const fields = { link: LINK, name: " Export ", goal: "Let people export.", tickets: "T-4\nT-5" };

  it("reads the thread from its link, with the limit, cap and interval unless changed", () => {
    expect(goalCreateFromForm(formData(fields))).toEqual({
      kind: "create",
      goal: {
        name: "export",
        goal: "Let people export.",
        channelId: "C123ABC",
        threadId: "1700000000.000200",
        tickets: ["T-4", "T-5"],
        limit: 2,
        capCents: 1000,
        everyMinutes: 10,
      },
    });
    expect(
      goalCreateFromForm(formData({ ...fields, limit: "3", cap: "$12.50", everyMinutes: "15" })),
    ).toMatchObject({ goal: { limit: 3, capCents: 1250, everyMinutes: 15 } });
  });

  it("says what is wrong", () => {
    expect(goalCreateFromForm(formData({ ...fields, link: "nope" }))).toEqual({
      kind: "invalid",
      error: "bad_link",
    });
    expect(goalCreateFromForm(formData({ ...fields, tickets: "four" }))).toEqual({
      kind: "invalid",
      error: "bad_tickets",
    });
    for (const change of [
      { limit: "6" },
      { limit: "two" },
      { cap: "200" },
      { everyMinutes: "0" },
      { name: "export now" },
      { goal: "" },
    ]) {
      expect(goalCreateFromForm(formData({ ...fields, ...change }))).toEqual({
        kind: "invalid",
        error: "invalid",
      });
    }
  });
});

describe("handleNewGoal", () => {
  const form = { link: LINK, name: "export", goal: "Let people export.", tickets: "T-4, T-5" };

  it("makes the goal as the person and opens its page", async () => {
    const fake = fakeApi(() =>
      Response.json({ status: "created", name: "export" }, { status: 201 }),
    );
    const res = await handleNewGoal(
      post("/new-goal", { cookie: await signedIn(), form }),
      deps(fake.fetch),
    );
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`${config.webBaseUrl}/jobs/export?done=created`);
    expect(fake.calls).toEqual([
      {
        url: `${config.apiBaseUrl}/v1/goals`,
        method: "POST",
        body: {
          name: "export",
          goal: "Let people export.",
          channelId: "C123ABC",
          threadId: "1700000000.000200",
          tickets: ["T-4", "T-5"],
          limit: 2,
          capCents: 1000,
          everyMinutes: 10,
        },
      },
    ]);
  });

  it("goes back to the form with why, naming the tickets the tracker does not have", async () => {
    const cases: [Response, string][] = [
      [Response.json({ status: "no_thread" }), "error=no_thread"],
      [Response.json({ status: "thread_taken" }), "error=thread_taken"],
      [Response.json({ status: "name_taken" }), "error=name_taken"],
      [Response.json({ status: "tracker_unavailable" }), "error=tracker_unavailable"],
      [
        Response.json({ status: "unknown_tickets", tickets: ["T-5"] }),
        "error=unknown_tickets&tickets=T-5",
      ],
      [new Response(null, { status: 400 }), "error=failed"],
    ];
    for (const [answer, expected] of cases) {
      const fake = fakeApi(() => answer.clone());
      const res = await handleNewGoal(
        post("/new-goal", { cookie: await signedIn(), form }),
        deps(fake.fetch),
      );
      expect(location(res)).toBe(`${config.webBaseUrl}/jobs/new-goal?${expected}`);
    }
    const res = await handleNewGoal(
      post("/new-goal", { cookie: await signedIn(), form: { ...form, link: "x" } }),
      deps(noCalls),
    );
    expect(location(res)).toBe(`${config.webBaseUrl}/jobs/new-goal?error=bad_link`);
    const invalid = await handleNewGoal(
      post("/new-goal", { cookie: await signedIn(), form: { ...form, limit: "9" } }),
      deps(noCalls),
    );
    expect(location(invalid)).toBe(`${config.webBaseUrl}/jobs/new-goal?error=goal_invalid`);
  });

  it("refuses a form on another site, or without a session, calling nothing", async () => {
    const cross = await handleNewGoal(
      post("/new-goal", {
        cookie: await signedIn(),
        headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
        form,
      }),
      deps(noCalls),
    );
    expect(cross.status).toBe(403);
    const d = deps(noCalls);
    const out = await handleNewGoal(post("/new-goal", { form }), d);
    expect(location(out)).toBe(`${config.webBaseUrl}/jobs/new-goal?error=signed_out`);
    expect(d.lines).toContainEqual(
      expect.objectContaining({ msg: "goal.create_refused", reason: "signed_out" }),
    );
  });

  it("shows the form to a signed-in person, with what the last try said", async () => {
    expect(
      await loadNewGoal(
        { sessionCookie: await signedIn(), error: "unknown_tickets", tickets: "T-5,bad,T-6" },
        deps(noCalls),
      ),
    ).toEqual({
      kind: "signed_in",
      person,
      notice: { kind: "error", error: "unknown_tickets", tickets: ["T-5", "T-6"] },
    });
    expect(
      await loadNewGoal(
        { sessionCookie: undefined, error: undefined, tickets: undefined },
        deps(noCalls),
      ),
    ).toEqual({ kind: "signed_out" });
  });
});

describe("handleGoalEdit", () => {
  const formOf = (changes: Record<string, string>) => ({
    version: "2",
    tickets: ticketsFieldValue(goal),
    limit: String(goal.limit),
    ...changes,
  });
  const edit = async (form: Record<string, string>, fetch: Fetch) =>
    handleGoalEdit(
      post("/jobs/export/goal", { cookie: await signedIn(), form }),
      "export",
      deps(fetch),
    );

  it("sends only what changed, on the version shown, and goes back to the goal", async () => {
    const fake = fakeApi((call) =>
      call.method === "GET"
        ? Response.json(goalDetail)
        : Response.json({ status: "edited", name: "export" }),
    );
    const res = await edit(formOf({ tickets: "T-4\nT-5\nT-7\nT-6\nT-8" }), fake.fetch);
    expect(location(res)).toBe(`${config.webBaseUrl}/jobs/export?done=edited`);
    expect(fake.calls[1]).toEqual({
      url: `${config.apiBaseUrl}/v1/goals/${goalDetail.job.id}`,
      method: "PATCH",
      body: { version: 2, tickets: ["T-4", "T-5", "T-7", "T-6", "T-8"] },
    });
    const limit = fakeApi((call) =>
      call.method === "GET" ? Response.json(goalDetail) : Response.json({ status: "edited" }),
    );
    await edit(formOf({ limit: "3" }), limit.fetch);
    expect(limit.calls[1]?.body).toEqual({ version: 2, limit: 3 });
  });

  it("goes back with why, calling nothing to write when nothing changed", async () => {
    const reads = fakeApi(() => Response.json(goalDetail));
    expect(location(await edit(formOf({}), reads.fetch))).toBe(
      `${config.webBaseUrl}/jobs/export?error=unchanged`,
    );
    expect(location(await edit(formOf({ tickets: "T-4 x" }), reads.fetch))).toBe(
      `${config.webBaseUrl}/jobs/export?error=bad_tickets`,
    );
    expect(reads.calls.every((call) => call.method === "GET")).toBe(true);
    const briefed = fakeApi((call) =>
      call.method === "GET"
        ? Response.json(goalDetail)
        : Response.json({ status: "briefed_tickets", tickets: ["T-4"] }),
    );
    expect(location(await edit(formOf({ tickets: "T-5" }), briefed.fetch))).toBe(
      `${config.webBaseUrl}/jobs/export?error=briefed_tickets&tickets=T-4`,
    );
    // A job that is not a goal has no tickets to change.
    const notGoal = fakeApi(() => Response.json(jobDetail));
    expect(location(await edit(formOf({ limit: "3" }), notGoal.fetch))).toBe(
      `${config.webBaseUrl}/jobs/export?error=not_found`,
    );
    const cross = await handleGoalEdit(
      post("/jobs/export/goal", {
        cookie: await signedIn(),
        headers: { origin: "https://evil.example" },
        form: formOf({}),
      }),
      "export",
      deps(noCalls),
    );
    expect(cross.status).toBe(403);
  });

  it("reads the form against the goal shown", () => {
    expect(
      goalEditFromForm(formData({ version: "2", tickets: "t-4, t-5, t-6, t-7" }), {
        ...goalDetail,
        goal,
      }),
    ).toEqual({ kind: "unchanged" });
    expect(
      goalEditFromForm(formData({ version: "2", limit: "9" }), { ...goalDetail, goal }),
    ).toEqual({ kind: "invalid", error: "invalid" });
  });
});

describe("how a goal is worded", () => {
  it("lists each ticket with where it is, its change and its pull request", () => {
    expect(ticketRows(goal)).toEqual([
      {
        key: "T-4",
        title: "Export button",
        href: "/tasks/T-4",
        state: "merged",
        label: "Merged",
        change: "Started",
        pullRequest: { href: "https://github.com/ilemberg/hippidy-bot/pull/12", text: "#12" },
      },
      expect.objectContaining({
        key: "T-5",
        label: "Briefed",
        change: "Started",
        pullRequest: null,
      }),
      expect.objectContaining({
        key: "T-6",
        label: "Not briefed yet (2 failed tries)",
        change: null,
      }),
      expect.objectContaining({ key: "T-7", label: "Not briefed yet" }),
    ]);
    const jira = {
      key: "SCRUM-7",
      title: "Export history",
      url: "https://acme.atlassian.net/browse/SCRUM-7",
      state: "pending" as const,
      change: null,
      failures: 0,
      settledAt: null,
    };
    expect(ticketRows({ ...goal, provider: "jira", tickets: [jira] })[0]?.href).toBe(
      "https://acme.atlassian.net/browse/SCRUM-7",
    );
    expect(openText(goal)).toBe("1 of 2 open");
    expect(ticketsFieldValue(goal)).toBe("T-4\nT-5\nT-6\nT-7");
  });

  it("words who made the goal and who changed its tickets and limit", () => {
    expect(jobHistoryItems(goalDetail).map((item) => item.lines)).toEqual([
      ["Grace made it, with the tickets T-4, T-5, T-6"],
      [
        "Ada changed the tickets from T-4, T-5, T-6 to T-4, T-5, T-6, T-7",
        "Ada changed the limit on open changes from 2 to 3",
      ],
    ]);
  });

  it("words a goal's notices, naming the tickets", () => {
    const notice = jobNotice(undefined, "unknown_tickets", "T-9,T-10");
    expect(notice).toEqual({ kind: "error", error: "unknown_tickets", tickets: ["T-9", "T-10"] });
    expect(notice === undefined ? "" : jobNoticeText(notice)).toBe(
      "Not saved: the tracker has no such ticket: T-9, T-10.",
    );
    expect(jobNoticeText({ kind: "done", done: "created" })).toMatch(/^Goal made\./);
    expect(jobNoticeText({ kind: "error", error: "no_thread" })).toBe(
      "Not saved: the bot is not in that thread yet. Mention the bot there first, then try again.",
    );
  });
});
