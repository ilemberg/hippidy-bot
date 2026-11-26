import type { TaskDetail } from "@hippidy/contracts";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "./cookies.ts";
import type { HomeDeps } from "./home.ts";
import { memoryLogger } from "./log.ts";
import type { Fetch } from "./slack-oidc.ts";
import {
  assigneeOptions,
  assigneeText,
  handleTaskAction,
  loadTask,
  loadTasks,
  problemText,
  taskCreateFromForm,
  taskEditFromForm,
  taskHistoryItems,
  taskHref,
  taskKeyFromPath,
  taskNotice,
  taskNoticeText,
  tasksHref,
  taskThreadHref,
  taskErrors,
} from "./tasks.ts";
import { config, jiraTask, task, taskDetail } from "./testing.ts";
import { signSession, type Person } from "./tokens.ts";

const person: Person = { actorId: "U0123456789", workspaceId: "T0123456789", name: "Ilya" };
const now = new Date("2026-11-25T12:00:00.000Z");
const people = [
  { actorId: "U1", name: "Ada" },
  { actorId: "U2", name: "Grace" },
];
const builtinList = { provider: "builtin", available: true, problem: null, tasks: [task] };
const builtinId = taskDetail.builtin?.id ?? "";

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

/** The API's reads: the people, the task list, and `detail` for any one task. */
function reads(call: Call, detail: TaskDetail = taskDetail): Response {
  if (call.url.endsWith("/v1/people")) return Response.json({ people });
  if (new URL(call.url).pathname === "/v1/tasks") return Response.json(builtinList);
  return Response.json(detail);
}

function deps(fetch: Fetch): HomeDeps & { lines: Record<string, unknown>[] } {
  const { log, lines } = memoryLogger();
  return { config, fetch, log, now: () => now, lines };
}

const noCalls: Fetch = () => Promise.reject(new Error("no call expected"));
const signedIn = () => signSession(person, config.sessionSecret, now);
const notFound = () =>
  Response.json({ error: { code: "not_found", message: "No such task" } }, { status: 404 });

describe("a task's address", () => {
  it("is its key, read back uppercased however it arrives", () => {
    expect(taskHref("SCRUM-8")).toBe("/tasks/SCRUM-8");
    expect(taskKeyFromPath("scrum-8")).toBe("SCRUM-8");
    expect(taskKeyFromPath("T-12")).toBe("T-12");
    expect(taskKeyFromPath("T%2D12")).toBe("T-12");
  });

  it("is nothing when it cannot be a key", () => {
    for (const text of ["", "T-0", "T12", "-1", "T-1/x", "%E0%A4%A", "T-1234567890"]) {
      expect(taskKeyFromPath(text)).toBeUndefined();
    }
  });

  it("keeps the search and leaves out the default filter", () => {
    expect(tasksHref("open")).toBe("/tasks");
    expect(tasksHref("done")).toBe("/tasks?status=done");
    expect(tasksHref("all", "rank & sort")).toBe("/tasks?q=rank+%26+sort&status=all");
  });
});

describe("loadTasks", () => {
  const input = async (fields: { q?: string; status?: string; done?: string; error?: string }) => ({
    sessionCookie: await signedIn(),
    q: fields.q,
    status: fields.status,
    done: fields.done,
    error: fields.error,
  });

  it("reads the open tasks and the people known, as the person, with a notice this app sent", async () => {
    const api = fakeApi((call) => reads(call));
    expect(await loadTasks(await input({ done: "created" }), deps(api.fetch))).toEqual({
      kind: "signed_in",
      person,
      filter: "open",
      q: undefined,
      list: { kind: "ok", value: builtinList },
      people: { kind: "ok", value: people },
      truncated: false,
      notice: { kind: "done", done: "created" },
      readAt: now.toISOString(),
    });
    expect(api.calls.map((call) => call.url).sort()).toEqual([
      "https://api.example.test/v1/people",
      "https://api.example.test/v1/tasks?status=open&limit=100",
    ]);
  });

  it("asks for the words and filter given, and ignores a filter or notice it does not know", async () => {
    const api = fakeApi((call) => reads(call));
    expect(
      await loadTasks(await input({ q: "  rank  ", status: "done" }), deps(api.fetch)),
    ).toMatchObject({ filter: "done", q: "rank" });
    expect(
      await loadTasks(await input({ status: "doing", error: "<b>" }), deps(api.fetch)),
    ).toMatchObject({ filter: "open", notice: undefined });
    expect(api.calls.map((call) => call.url).filter((url) => url.includes("/tasks"))).toEqual([
      "https://api.example.test/v1/tasks?q=rank&status=done&limit=100",
      "https://api.example.test/v1/tasks?status=open&limit=100",
    ]);
  });

  it("passes on a provider that gave nothing, and says when there may be more", async () => {
    const none = { provider: "jira", available: false, problem: "not_configured", tasks: [] };
    const api = fakeApi((call) =>
      call.url.includes("/v1/tasks") ? Response.json(none) : reads(call),
    );
    expect(await loadTasks(await input({}), deps(api.fetch))).toMatchObject({
      list: { kind: "ok", value: none },
      truncated: false,
    });
    const full = { ...builtinList, tasks: Array.from({ length: 100 }, () => task) };
    const many = fakeApi((call) =>
      call.url.includes("/v1/tasks") ? Response.json(full) : reads(call),
    );
    expect(await loadTasks(await input({}), deps(many.fetch))).toMatchObject({ truncated: true });
  });

  it("asks a signed-out visitor to sign in, and calls nothing", async () => {
    expect(
      await loadTasks(
        {
          sessionCookie: undefined,
          q: undefined,
          status: undefined,
          done: undefined,
          error: "signed_out",
        },
        deps(noCalls),
      ),
    ).toEqual({ kind: "signed_out", notice: { kind: "error", error: "signed_out" } });
    expect(
      await loadTasks(
        {
          sessionCookie: "forged",
          q: undefined,
          status: undefined,
          done: undefined,
          error: undefined,
        },
        { ...deps(noCalls), config: undefined },
      ),
    ).toEqual({ kind: "unconfigured" });
  });
});

describe("loadTask", () => {
  const input = async (key: string, done?: string, error?: string) => ({
    sessionCookie: await signedIn(),
    key,
    done,
    error,
  });

  it("reads the task by its key, with the people known", async () => {
    const api = fakeApi((call) => reads(call));
    expect(await loadTask(await input("t-4", "edited"), deps(api.fetch))).toEqual({
      kind: "ok",
      person,
      detail: taskDetail,
      people: { kind: "ok", value: people },
      notice: { kind: "done", done: "edited" },
      readAt: now.toISOString(),
    });
    expect(api.calls.map((call) => call.url).sort()).toEqual([
      "https://api.example.test/v1/people",
      "https://api.example.test/v1/tasks/T-4",
    ]);
  });

  it("says there is no such task, asking the API only for a key", async () => {
    expect(await loadTask(await input("T-0"), deps(noCalls))).toEqual({
      kind: "not_found",
      person,
      key: undefined,
    });
    const api = fakeApi((call) => (call.url.endsWith("/v1/people") ? reads(call) : notFound()));
    expect(await loadTask(await input("SCRUM-99"), deps(api.fetch))).toEqual({
      kind: "not_found",
      person,
      key: "SCRUM-99",
    });
  });

  it("says when the API did not answer, and asks a signed-out visitor to sign in", async () => {
    const down = fakeApi(() => new Response(null, { status: 502 }));
    expect(await loadTask(await input("T-4"), deps(down.fetch))).toEqual({
      kind: "failed",
      person,
      reason: "status_502",
    });
    expect(
      await loadTask(
        { sessionCookie: undefined, key: "T-4", done: "created", error: undefined },
        deps(noCalls),
      ),
    ).toEqual({ kind: "signed_out", notice: { kind: "done", done: "created" } });
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

describe("handleTaskAction: create", () => {
  const create = async (form: Record<string, string>, fetch: Fetch, cookie?: string) =>
    handleTaskAction(
      post("/new-task", { cookie: cookie ?? (await signedIn()), form }),
      "create",
      undefined,
      deps(fetch),
    );

  it("creates as the person, and never says who acts", async () => {
    const api = fakeApi(() => Response.json({ status: "created", task }, { status: 201 }));
    const res = await create(
      {
        title: "  Rank search results by recency ",
        description: "Newer first\r\nwhen equal",
        status: "doing",
        assignee: "U2",
        actorId: "U999",
      },
      api.fetch,
    );
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`${config.webBaseUrl}/tasks/T-4?done=created`);
    expect(api.calls).toEqual([
      {
        url: "https://api.example.test/v1/tasks",
        method: "POST",
        body: {
          title: "Rank search results by recency",
          description: "Newer first\nwhen equal",
          status: "doing",
          assigneeActorId: "U2",
        },
      },
    ]);
  });

  it("leaves out an empty description, status and assignee", async () => {
    const api = fakeApi(() => Response.json({ status: "created", task }, { status: 201 }));
    await create({ title: "Rank", description: " ", status: "", assignee: "" }, api.fetch);
    expect(api.calls[0]?.body).toEqual({ title: "Rank" });
  });

  it("goes back to the list when the tasks are in Jira, the API did not answer, or gave no task", async () => {
    for (const [answer, expected] of [
      [Response.json({ status: "not_builtin" }), "error=not_builtin"],
      [new Response(null, { status: 500 }), "error=failed"],
      [Response.json({ status: "edited", task }), "error=failed"],
      [Response.json({ status: "created" }), "done=created"],
    ] as const) {
      const api = fakeApi(() => answer);
      const res = await create({ title: "Rank" }, api.fetch);
      expect(location(res)).toBe(`${config.webBaseUrl}/tasks?${expected}`);
    }
  });

  it("calls nothing for a form the API would refuse", async () => {
    for (const form of [
      {},
      { title: " " },
      { title: "t".repeat(201) },
      { title: "Rank", description: "d".repeat(4001) },
      { title: "Rank", status: "blocked" },
    ]) {
      const res = await create(form, noCalls);
      expect(location(res)).toBe(`${config.webBaseUrl}/tasks?error=invalid`);
    }
  });

  it("refuses a form on another site, or one that says nothing of where it came from", async () => {
    for (const headers of [
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { origin: "" },
    ]) {
      const d = deps(noCalls);
      const res = await handleTaskAction(
        post("/new-task", { cookie: await signedIn(), headers, form: { title: "Rank" } }),
        "create",
        undefined,
        d,
      );
      expect(res.status).toBe(403);
      expect(d.lines).toContainEqual(
        expect.objectContaining({ msg: "task.action_refused", reason: "cross_origin" }),
      );
    }
  });

  it("refuses without a valid session or configuration, calling nothing", async () => {
    for (const cookie of [undefined, "forged"]) {
      const res = await handleTaskAction(
        post("/new-task", { ...(cookie === undefined ? {} : { cookie }), form: { title: "x" } }),
        "create",
        undefined,
        deps(noCalls),
      );
      expect(location(res)).toBe(`${config.webBaseUrl}/tasks?error=signed_out`);
    }
    const res = await handleTaskAction(
      post("/new-task", { cookie: await signedIn(), headers: { "sec-fetch-site": "same-origin" } }),
      "create",
      undefined,
      { ...deps(noCalls), config: undefined },
    );
    expect(location(res)).toBe(`${config.webBaseUrl}/tasks?error=unavailable`);
  });
});

describe("handleTaskAction: edit", () => {
  /** The task's form as the page fills it, with `changes` on top. */
  const formOf = (changes: Record<string, string>) => ({
    version: String(taskDetail.builtin?.version),
    title: task.title,
    description: (taskDetail.builtin?.description ?? "").replace("\n", "\r\n"),
    status: task.status,
    assignee: task.assignee?.actorId ?? "",
    ...changes,
  });

  /** The API: the task by key, and `result` for the edit. */
  const api = (result: Response, detail: TaskDetail = taskDetail) =>
    fakeApi((call) => (call.method === "GET" ? reads(call, detail) : result));

  const edit = async (form: Record<string, string>, fetch: Fetch, key = "T-4") =>
    handleTaskAction(
      post(`/tasks/${key}/edit`, { cookie: await signedIn(), form }),
      "edit",
      key,
      deps(fetch),
    );

  it("sends only what changed, with the version shown, to the task's id", async () => {
    const fake = api(Response.json({ status: "edited", task: { ...task, status: "done" } }));
    const res = await edit(formOf({ status: "done", assignee: "", actorId: "U999" }), fake.fetch);
    expect(location(res)).toBe(`${config.webBaseUrl}/tasks/T-4?done=edited`);
    expect(fake.calls).toEqual([
      { url: "https://api.example.test/v1/tasks/T-4", method: "GET", body: undefined },
      {
        url: `https://api.example.test/v1/tasks/${builtinId}`,
        method: "PATCH",
        body: { version: 2, status: "done", assigneeActorId: null },
      },
    ]);
  });

  it("clears an emptied description, and changes the title", async () => {
    const fake = api(Response.json({ status: "edited", task }));
    await edit(formOf({ title: "Rank by recency", description: "" }), fake.fetch, "t-4");
    expect(writes(fake.calls)[0]?.body).toEqual({
      version: 2,
      title: "Rank by recency",
      description: null,
    });
  });

  it("calls nothing when nothing changed, or the form is invalid", async () => {
    for (const [form, expected] of [
      [formOf({}), "error=unchanged"],
      [formOf({ title: "" }), "error=unchanged"],
      [formOf({ version: "" }), "error=invalid"],
      [formOf({ version: "0" }), "error=invalid"],
      [formOf({ status: "blocked" }), "error=invalid"],
      [formOf({ title: "t".repeat(201) }), "error=invalid"],
    ] as const) {
      const fake = api(Response.json({ status: "edited", task }));
      const res = await edit(form, fake.fetch);
      expect(location(res)).toBe(`${config.webBaseUrl}/tasks/T-4?${expected}`);
      expect(writes(fake.calls)).toEqual([]);
    }
  });

  it("refuses to edit a task from Jira, calling no write", async () => {
    const jira: TaskDetail = { ...taskDetail, provider: "jira", task: jiraTask, builtin: null };
    const fake = api(Response.json({ status: "edited", task }), jira);
    const res = await edit(formOf({ status: "done" }), fake.fetch, "SCRUM-8");
    expect(location(res)).toBe(`${config.webBaseUrl}/tasks/SCRUM-8?error=not_builtin`);
    expect(writes(fake.calls)).toEqual([]);
  });

  it("goes back with why when the API refuses or does not answer", async () => {
    const cases: [Response, Response | undefined, string][] = [
      [Response.json(taskDetail), Response.json({ status: "changed", task }), "error=changed"],
      [Response.json(taskDetail), Response.json({ status: "not_found" }), "error=not_found"],
      [Response.json(taskDetail), Response.json({ status: "unchanged", task }), "error=unchanged"],
      [Response.json(taskDetail), Response.json({ status: "not_builtin" }), "error=not_builtin"],
      [Response.json(taskDetail), new Response(null, { status: 500 }), "error=failed"],
      [notFound(), undefined, "error=not_found"],
      [new Response(null, { status: 502 }), undefined, "error=failed"],
    ];
    for (const [lookup, result, expected] of cases) {
      const fake = fakeApi((call) => (call.method === "GET" ? lookup : (result ?? lookup)));
      const res = await edit(formOf({ status: "done" }), fake.fetch);
      expect(location(res)).toBe(`${config.webBaseUrl}/tasks/T-4?${expected}`);
      if (result === undefined) expect(fake.calls).toHaveLength(1);
    }
  });

  it("answers 404 for a key that cannot be one, and refuses another site", async () => {
    const res = await edit(formOf({}), noCalls, "nope");
    expect(res.status).toBe(404);
    const d = deps(noCalls);
    const refused = await handleTaskAction(
      post("/tasks/T-4/edit", {
        cookie: await signedIn(),
        headers: { origin: "https://evil.example" },
        form: formOf({ status: "done" }),
      }),
      "edit",
      "T-4",
      d,
    );
    expect(refused.status).toBe(403);
    expect(d.lines).toContainEqual(
      expect.objectContaining({ msg: "task.action_refused", reason: "cross_origin" }),
    );
  });
});

describe("the form's fields", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.set(name, value);
    return data;
  };
  const current = { task, description: "Old" };

  it("leaves out a field the form did not send", () => {
    expect(taskEditFromForm(form({ version: "2", status: "todo" }), current)).toEqual({
      kind: "edit",
      edit: { version: 2, status: "todo" },
    });
  });

  it("creates from the fields, or says the form is invalid", () => {
    expect(taskCreateFromForm(form({ title: "Rank", assignee: "U1" }))).toEqual({
      kind: "create",
      task: { title: "Rank", assigneeActorId: "U1" },
    });
    expect(taskCreateFromForm(form({ title: "" }))).toEqual({ kind: "invalid" });
  });
});

describe("how a task is worded", () => {
  it("says why a provider gave nothing", () => {
    const list = (provider: "jira" | "builtin", problem: "not_configured" | "unreachable") => ({
      provider,
      available: false,
      problem,
      tasks: [],
    });
    expect(problemText(list("jira", "not_configured"))).toBe(
      "Jira is not set up for the API yet, so its tasks cannot be shown.",
    );
    expect(problemText(list("jira", "unreachable"))).toBe(
      "Jira did not answer. Reload the page to try again.",
    );
    expect(problemText(list("builtin", "unreachable"))).toBe(
      "The built-in tracker could not be read. Reload the page to try again.",
    );
  });

  it("names the assignee, or nobody", () => {
    expect(assigneeText(null)).toBe("Nobody");
    expect(assigneeText(jiraTask.assignee)).toBe("Grace Hopper");
  });

  it("offers nobody, the assignee now, you, and the people known, each once", () => {
    expect(assigneeOptions({ kind: "ok", value: people }, task.assignee, person)).toEqual([
      { value: "", label: "Nobody" },
      { value: "U2", label: "Grace" },
      { value: "U0123456789", label: "Ilya" },
      { value: "U1", label: "Ada" },
    ]);
    expect(
      assigneeOptions({ kind: "failed", reason: "status_503" }, jiraTask.assignee, person),
    ).toEqual([
      { value: "", label: "Nobody" },
      { value: "U0123456789", label: "Ilya" },
    ]);
  });

  it("links a thread working on it", () => {
    const thread = {
      conversationId: "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f",
      channelId: "C1",
      threadId: "1700.000100",
      linkedAt: "2026-11-25T11:00:00.000Z",
    };
    expect(taskThreadHref(thread)).toBe("https://slack.com/archives/C1/p1700000100");
  });

  it("lists its history, oldest first, with what changed", () => {
    expect(taskHistoryItems(taskDetail)).toEqual([
      { key: "0:created", text: "Created by Ada", at: "2026-11-25T09:00:00.000Z", changes: [] },
      {
        key: "1:edited",
        text: "Edited by Ada",
        at: "2026-11-25T10:00:00.000Z",
        changes: [
          { field: "Status", before: "To do", after: "Doing" },
          { field: "Assignee", before: "Nobody", after: "Grace" },
        ],
      },
    ]);
    expect(taskHistoryItems({ ...taskDetail, builtin: null })).toEqual([]);
  });

  it("reads an assignee kept as an id and a name", () => {
    const detail: TaskDetail = {
      ...taskDetail,
      builtin: taskDetail.builtin && {
        ...taskDetail.builtin,
        history: [
          {
            kind: "edited",
            actor: { actorId: "U1", name: null },
            at: "2026-11-25T10:00:00.000Z",
            before: { assigneeActorId: null, assigneeName: null },
            after: { assigneeActorId: "U2", assigneeName: "Grace" },
          },
        ],
      },
    };
    expect(taskHistoryItems(detail)[0]).toMatchObject({
      text: "Edited by U1",
      changes: [{ field: "Assignee", before: "Nobody", after: "Grace" }],
    });
  });

  it("reads only the notices this app sends, and words each", () => {
    expect(taskNotice("created", undefined)).toEqual({ kind: "done", done: "created" });
    expect(taskNotice(undefined, "changed")).toEqual({ kind: "error", error: "changed" });
    expect(taskNotice("hacked", "<b>")).toBeUndefined();
    for (const error of taskErrors) {
      expect(taskNoticeText({ kind: "error", error })).not.toBe("");
    }
    expect(taskNoticeText({ kind: "done", done: "edited" })).toBe("Saved.");
  });
});
