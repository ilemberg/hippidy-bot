import type { Job, JobDetail } from "@hippidy/contracts";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "./cookies.ts";
import type { HomeDeps } from "./home.ts";
import {
  budgetText,
  capFieldValue,
  centsFromText,
  everyText,
  handleJobEdit,
  jobEditFromForm,
  jobHistoryItems,
  jobHref,
  jobNameFromPath,
  jobNotice,
  jobNoticeText,
  loadJob,
  loadJobs,
  microsText,
  minutesFromText,
  spendText,
  stateOptions,
  wakeRows,
} from "./jobs.ts";
import { memoryLogger } from "./log.ts";
import type { Fetch } from "./slack-oidc.ts";
import { briefsJob, config, job, jobDetail } from "./testing.ts";
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
  Response.json({ error: { code: "not_found", message: "No such job" } }, { status: 404 });

describe("a job's address", () => {
  it("encodes the name as one segment, and reads it back however it arrives", () => {
    expect(jobHref("night watch")).toBe("/jobs/night%20watch");
    expect(jobNameFromPath("night%20watch")).toBe("night watch");
    expect(jobNameFromPath(" Capture ")).toBe("capture");
  });

  it("is nothing when it cannot be a name", () => {
    for (const text of ["", "  ", "a".repeat(61), "%E0%A4%A", "a%00b", "a\nb"]) {
      expect(jobNameFromPath(text)).toBeUndefined();
    }
  });
});

describe("loadJobs", () => {
  it("reads every job as the person", async () => {
    const list = { jobs: [job, briefsJob] };
    const api = fakeApi(() => Response.json(list));
    expect(await loadJobs({ sessionCookie: await signedIn() }, deps(api.fetch))).toEqual({
      kind: "signed_in",
      person,
      list: { kind: "ok", value: list },
      readAt: now.toISOString(),
    });
    expect(api.calls.map((call) => call.url)).toEqual(["https://api.example.test/v1/jobs"]);
  });

  it("says when the API did not answer", async () => {
    const down = fakeApi(() => new Response(null, { status: 503 }));
    expect(await loadJobs({ sessionCookie: await signedIn() }, deps(down.fetch))).toMatchObject({
      kind: "signed_in",
      list: { kind: "failed", reason: "status_503" },
    });
  });

  it("asks a signed-out visitor to sign in, and calls nothing", async () => {
    expect(await loadJobs({ sessionCookie: "forged" }, deps(noCalls))).toEqual({
      kind: "signed_out",
    });
    expect(
      await loadJobs({ sessionCookie: await signedIn() }, { ...deps(noCalls), config: undefined }),
    ).toEqual({ kind: "unconfigured" });
  });
});

describe("loadJob", () => {
  const input = async (name: string, done?: string, error?: string) => ({
    sessionCookie: await signedIn(),
    name,
    done,
    error,
  });

  it("reads the job by its name, with a notice this app sent", async () => {
    const api = fakeApi(() => Response.json(jobDetail));
    expect(
      await loadJob(await input("Capture", undefined, "still_capped"), deps(api.fetch)),
    ).toEqual({
      kind: "ok",
      person,
      detail: jobDetail,
      notice: { kind: "error", error: "still_capped" },
      readAt: now.toISOString(),
    });
    expect(api.calls.map((call) => call.url)).toEqual(["https://api.example.test/v1/jobs/capture"]);
    expect(await loadJob(await input("capture", "hacked", "<b>"), deps(api.fetch))).toMatchObject({
      notice: undefined,
    });
  });

  it("says there is no such job, asking the API only for a name", async () => {
    const api = fakeApi(() => notFound());
    expect(await loadJob(await input("checker"), deps(api.fetch))).toEqual({
      kind: "not_found",
      person,
      name: "checker",
    });
    expect(await loadJob(await input("a".repeat(61)), deps(noCalls))).toEqual({
      kind: "not_found",
      person,
      name: undefined,
    });
  });

  it("says when the API did not answer, and asks a signed-out visitor to sign in", async () => {
    const down = fakeApi(() => new Response(null, { status: 502 }));
    expect(await loadJob(await input("capture"), deps(down.fetch))).toEqual({
      kind: "failed",
      person,
      reason: "status_502",
    });
    expect(
      await loadJob(
        { sessionCookie: undefined, name: "capture", done: "edited", error: undefined },
        deps(noCalls),
      ),
    ).toEqual({ kind: "signed_out", notice: { kind: "done", done: "edited" } });
    expect(await loadJob(await input("capture"), { ...deps(noCalls), config: undefined })).toEqual({
      kind: "unconfigured",
    });
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
const writes = (calls: Call[]) => calls.filter((call) => call.method !== "GET");

describe("handleJobEdit", () => {
  /** The job's form as the page fills it, with `changes` on top. */
  const formOf = (changes: Record<string, string>, shown: Job = job) => ({
    version: String(shown.version),
    state: shown.state,
    cap: capFieldValue(shown.capCents),
    everyMinutes: String(shown.everyMinutes),
    goal: shown.goal ?? "",
    ...changes,
  });

  /** The API: `detail` for the job by name, and `result` for the edit. */
  const api = (result: Response, detail: JobDetail = jobDetail) =>
    fakeApi((call) => (call.method === "GET" ? Response.json(detail) : result));

  const edit = async (form: Record<string, string>, fetch: Fetch, name = "capture") =>
    handleJobEdit(
      post(`/jobs/${name}/edit`, { cookie: await signedIn(), form }),
      name,
      deps(fetch),
    );

  it("sends only what changed, with the version shown, as the person, and goes back to the job", async () => {
    const fake = api(Response.json({ status: "edited", job: { ...job, state: "paused" } }));
    const res = await edit(
      formOf({ state: "paused", cap: "$40.5", actorId: "U999", actor: "U999" }),
      fake.fetch,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(location(res)).toBe(`${config.webBaseUrl}/jobs/capture?done=edited`);
    expect(fake.calls).toEqual([
      { url: "https://api.example.test/v1/jobs/capture", method: "GET", body: undefined },
      {
        url: `https://api.example.test/v1/jobs/${job.id}`,
        method: "PATCH",
        body: { version: 3, state: "paused", capCents: 4050 },
      },
    ]);
  });

  it("changes the interval and clears an emptied goal", async () => {
    const fake = api(Response.json({ status: "edited", job }));
    await edit(formOf({ everyMinutes: " 15 ", goal: "  \r\n" }), fake.fetch);
    expect(writes(fake.calls)[0]?.body).toEqual({ version: 3, everyMinutes: 15, goal: null });
  });

  it("leaves a capped job's state alone unless the person resumes or pauses it", async () => {
    const capped: Job = {
      ...job,
      state: "capped",
      capCents: 1000,
      spentMicrosThisMonth: 10_000_000,
    };
    const detail = { ...jobDetail, job: capped };
    const raised = api(
      Response.json({ status: "edited", job: { ...capped, state: "active" } }),
      detail,
    );
    await edit(formOf({ cap: "20" }, capped), raised.fetch);
    expect(writes(raised.calls)[0]?.body).toEqual({ version: 3, capCents: 2000 });
    const resumed = api(Response.json({ status: "still_capped", job: capped }), detail);
    const res = await edit(formOf({ state: "active" }, capped), resumed.fetch);
    expect(writes(resumed.calls)[0]?.body).toEqual({ version: 3, state: "active" });
    expect(location(res)).toBe(`${config.webBaseUrl}/jobs/capture?error=still_capped`);
  });

  it("calls nothing when nothing changed, or the form is invalid", async () => {
    for (const [form, expected] of [
      [formOf({}), "error=unchanged"],
      [formOf({ cap: "$40", goal: ` ${job.goal ?? ""} ` }), "error=unchanged"],
      [formOf({ version: "" }), "error=invalid"],
      [formOf({ version: "0" }), "error=invalid"],
      [formOf({ state: "stopped" }), "error=invalid"],
      [formOf({ cap: "forty" }), "error=invalid"],
      [formOf({ cap: "100.01" }), "error=invalid"],
      [formOf({ cap: "-1" }), "error=invalid"],
      [formOf({ cap: "4.005" }), "error=invalid"],
      [formOf({ everyMinutes: "0" }), "error=invalid"],
      [formOf({ everyMinutes: "1441" }), "error=invalid"],
      [formOf({ everyMinutes: "1.5" }), "error=invalid"],
      [formOf({ goal: "g".repeat(2001) }), "error=invalid"],
      [formOf({ goal: "a\u0000b" }), "error=invalid"],
    ] as const) {
      const fake = api(Response.json({ status: "edited", job }));
      const res = await edit(form, fake.fetch);
      expect(location(res)).toBe(`${config.webBaseUrl}/jobs/capture?${expected}`);
      expect(writes(fake.calls)).toEqual([]);
    }
  });

  it("goes back with why when the API refuses or does not answer", async () => {
    const cases: [Response, Response | undefined, string][] = [
      [Response.json(jobDetail), Response.json({ status: "changed", job }), "error=changed"],
      [Response.json(jobDetail), Response.json({ status: "unchanged", job }), "error=unchanged"],
      [Response.json(jobDetail), Response.json({ status: "not_found" }), "error=not_found"],
      [Response.json(jobDetail), new Response(null, { status: 500 }), "error=failed"],
      [Response.json(jobDetail), Response.json({ status: "odd" }), "error=failed"],
      [notFound(), undefined, "error=not_found"],
      [new Response(null, { status: 502 }), undefined, "error=failed"],
    ];
    for (const [lookup, result, expected] of cases) {
      const fake = fakeApi((call) => (call.method === "GET" ? lookup : (result ?? lookup)));
      const res = await edit(formOf({ state: "paused" }), fake.fetch);
      expect(location(res)).toBe(`${config.webBaseUrl}/jobs/capture?${expected}`);
      if (result === undefined) expect(fake.calls).toHaveLength(1);
    }
  });

  it("refuses without a valid session or configuration, calling nothing", async () => {
    for (const cookie of [undefined, "forged"]) {
      const d = deps(noCalls);
      const res = await handleJobEdit(
        post("/jobs/capture/edit", {
          ...(cookie === undefined ? {} : { cookie }),
          form: formOf({ state: "paused" }),
        }),
        "capture",
        d,
      );
      expect(location(res)).toBe(`${config.webBaseUrl}/jobs/capture?error=signed_out`);
      expect(d.lines).toContainEqual(
        expect.objectContaining({ msg: "job.edit_refused", reason: "signed_out" }),
      );
    }
    const res = await handleJobEdit(
      post("/jobs/night%20watch/edit", {
        cookie: await signedIn(),
        headers: { "sec-fetch-site": "same-origin" },
      }),
      "night%20watch",
      { ...deps(noCalls), config: undefined },
    );
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`${config.webBaseUrl}/jobs/night%20watch?error=unavailable`);
  });

  it("refuses a form on another site, and answers 404 for a name that cannot be a job's", async () => {
    for (const headers of [
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { origin: "" },
    ]) {
      const d = deps(noCalls);
      const res = await handleJobEdit(
        post("/jobs/capture/edit", { cookie: await signedIn(), headers, form: formOf({}) }),
        "capture",
        d,
      );
      expect(res.status).toBe(403);
      expect(d.lines).toContainEqual(
        expect.objectContaining({ msg: "job.edit_refused", reason: "cross_origin" }),
      );
    }
    const res = await edit(formOf({ state: "paused" }), noCalls, "a".repeat(61));
    expect(res.status).toBe(404);
  });
});

describe("the form's fields", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.set(name, value);
    return data;
  };

  it("reads dollars with or without cents, and whole minutes", () => {
    expect(centsFromText("40")).toBe(4000);
    expect(centsFromText(" $40.5 ")).toBe(4050);
    expect(centsFromText("$ 0.07")).toBe(7);
    expect(centsFromText("100.00")).toBe(10_000);
    for (const text of ["", "$", "4,000", "1e3", "40.", "-5", "40.123"]) {
      expect(centsFromText(text)).toBeUndefined();
    }
    expect(minutesFromText(" 60 ")).toBe(60);
    for (const text of ["", "1.5", "-1", "ten"]) expect(minutesFromText(text)).toBeUndefined();
  });

  it("leaves out a field the form did not send", () => {
    expect(jobEditFromForm(form({ version: "3", goal: "New goal" }), job)).toEqual({
      kind: "edit",
      edit: { version: 3, goal: "New goal" },
    });
    expect(jobEditFromForm(form({ version: "3" }), job)).toEqual({ kind: "unchanged" });
    expect(jobEditFromForm(form({ version: "3", state: "capped" }), job)).toEqual({
      kind: "unchanged",
    });
  });
});

describe("how a job is worded", () => {
  it("shows money in dollars, spend against the cap, and the interval", () => {
    expect(microsText(12_340_000)).toBe("$12.34");
    expect(microsText(0)).toBe("$0.00");
    expect(microsText(4_000)).toBe("under $0.01");
    expect(spendText(job)).toBe("$12.34 of $40.00");
    expect(capFieldValue(4050)).toBe("40.50");
    expect(everyText(1)).toBe("every minute");
    expect(everyText(15)).toBe("every 15 minutes");
  });

  it("says what all jobs are meant to stay inside, and what their caps add up to", () => {
    expect(budgetText([job, briefsJob])).toBe(
      "All jobs together are meant to stay inside $100.00 a month; their caps add up to $41.00.",
    );
    expect(budgetText([job, { ...job, capCents: 7000 }])).toBe(
      "All jobs together are meant to stay inside $100.00 a month; their caps add up to $110.00, which is more than that.",
    );
    expect(budgetText([])).toMatch(/their caps add up to \$0\.00\.$/);
  });

  it("offers leaving a capped job capped only when it is", () => {
    expect(stateOptions("active").map((o) => o.value)).toEqual(["active", "paused"]);
    expect(stateOptions("capped").map((o) => o.value)).toEqual(["capped", "active", "paused"]);
  });

  it("lists the wakes with their outcome, what they said or why they failed, and their cost", () => {
    expect(
      wakeRows([
        ...jobDetail.wakes,
        {
          startedAt: "2026-11-25T11:56:00.000Z",
          endedAt: null,
          outcome: "failed",
          summary: "Started reading",
          costMicros: 1_000,
          error: "Timed out",
        },
        {
          startedAt: "2026-11-25T11:55:00.000Z",
          endedAt: null,
          outcome: "skipped",
          summary: null,
          costMicros: 0,
          error: null,
        },
      ]),
    ).toEqual([
      {
        key: "0:2026-11-25T11:58:00.000Z",
        at: "2026-11-25T11:58:00.000Z",
        outcome: "silent",
        label: "Silent",
        text: "No quiet thread to read",
        cost: "$0.00",
      },
      {
        key: "1:2026-11-25T11:57:00.000Z",
        at: "2026-11-25T11:57:00.000Z",
        outcome: "said",
        label: "Said",
        text: "Proposed decision #8",
        cost: "$0.04",
      },
      {
        key: "2:2026-11-25T11:56:00.000Z",
        at: "2026-11-25T11:56:00.000Z",
        outcome: "failed",
        label: "Failed",
        text: "Timed out",
        cost: "under $0.01",
      },
      {
        key: "3:2026-11-25T11:55:00.000Z",
        at: "2026-11-25T11:55:00.000Z",
        outcome: "skipped",
        label: "Skipped",
        text: "",
        cost: "$0.00",
      },
    ]);
  });

  it("words each change a person made, oldest first", () => {
    const fields = { state: "active", capCents: 3000, everyMinutes: 1, goal: null };
    const items = jobHistoryItems({
      ...jobDetail,
      history: [
        ...jobDetail.history,
        {
          actor: { actorId: "U2", name: null },
          at: "2026-11-25T11:00:00.000Z",
          before: fields,
          after: { ...fields, state: "paused", everyMinutes: 5, goal: "Watch #general" },
        },
        {
          actor: { actorId: "U1", name: "Ada" },
          at: "2026-11-25T11:30:00.000Z",
          before: { ...fields, state: "capped", goal: "Old" },
          after: { ...fields, state: "active", goal: null, notes: "x" },
        },
        {
          actor: { actorId: "U1", name: "Ada" },
          at: "2026-11-25T11:40:00.000Z",
          before: { ...fields, state: "active", goal: "a".repeat(200) },
          after: { ...fields, state: "capped", goal: "b" },
        },
        {
          actor: { actorId: "U1", name: "Ada" },
          at: "2026-11-25T11:50:00.000Z",
          before: {},
          after: {},
        },
      ],
    });
    expect(items).toEqual([
      {
        key: "0:2026-11-25T10:00:00.000Z",
        at: "2026-11-25T10:00:00.000Z",
        lines: ["Ada changed the cap from $30.00 to $40.00"],
      },
      {
        key: "1:2026-11-25T11:00:00.000Z",
        at: "2026-11-25T11:00:00.000Z",
        lines: [
          "U2 paused it",
          "U2 changed the interval from every minute to every 5 minutes",
          "U2 set the goal to “Watch #general”",
        ],
      },
      {
        key: "2:2026-11-25T11:30:00.000Z",
        at: "2026-11-25T11:30:00.000Z",
        lines: ["Ada resumed it", "Ada cleared the goal", "Ada changed its notes"],
      },
      {
        key: "3:2026-11-25T11:40:00.000Z",
        at: "2026-11-25T11:40:00.000Z",
        lines: [
          "Ada changed its state from active to capped",
          `Ada changed the goal from “${"a".repeat(119)}…” to “b”`,
        ],
      },
      {
        key: "4:2026-11-25T11:50:00.000Z",
        at: "2026-11-25T11:50:00.000Z",
        lines: ["Ada edited it"],
      },
    ]);
  });

  it("reads only the notices this app sends, and words each", () => {
    expect(jobNotice("edited", undefined)).toEqual({ kind: "done", done: "edited" });
    expect(jobNotice(undefined, "still_capped")).toEqual({ kind: "error", error: "still_capped" });
    expect(jobNotice("nope", "nope")).toBeUndefined();
    expect(jobNoticeText({ kind: "error", error: "still_capped" })).toMatch(
      /Raise its cap above this month's spend to resume it\.$/,
    );
    expect(jobNoticeText({ kind: "done", done: "edited" })).toBe("Saved.");
  });
});
