import {
  taskActionResultSchema,
  taskDetailSchema,
  taskListSchema,
  waitActionResultSchema,
  waitListSchema,
  type InboundMessage,
  type OutboundDelivery,
} from "@hippidy/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../agent/fake.ts";
import { configureApp } from "../compose.ts";
import { readTaskConfig, type Env } from "../config.ts";
import { getConversation } from "../store/conversations.ts";
import { createTask } from "../store/tasks.ts";
import { createTestDb } from "../store/testing.ts";
import { createTaskSource } from "../tasks/provider.ts";
import { memoryLogger } from "../testing.ts";
import { answerCustomToolCall } from "./agent-tools.ts";
import { receiveMessage, syncConversation, type ConversationDeps } from "./conversations.ts";
import { PERSON_SECRET, PERSON_WORKSPACE, RecordingDeliverer, signPersonToken } from "./testing.ts";
import type { ApiEnv } from "./types.ts";

// Slice 3.3 (decision 210): tasks from one provider, read the same way; a thread's task; and
// the waiting-on list, recorded in threads and the web app.

let db: Awaited<ReturnType<typeof createTestDb>>;
let runtime: FakeAgentRuntime;
let slack: RecordingDeliverer;
let deps: ConversationDeps;
const { log } = memoryLogger();
const ws = PERSON_WORKSPACE;
const place = { source: "slack" as const, workspaceId: ws };

beforeEach(async () => {
  db = await createTestDb();
  runtime = new FakeAgentRuntime();
  slack = new RecordingDeliverer();
  deps = { db, runtime, deliverers: { slack }, sleep: () => Promise.resolve() };
});

afterEach(async () => {
  await db.close();
});

const person = (actorId: string, name: string | null = null) => ({ ...place, actorId, name });

function message(n: number, text: string, actorId = "U1", name = "Grace"): InboundMessage {
  return {
    source: "slack",
    sourceEventId: `Ev${String(n)}`,
    conversation: {
      workspaceId: ws,
      channelId: "C1",
      threadId: "100.1",
      messageId: `100.${String(n)}`,
    },
    actor: { id: actorId, displayName: name },
    text,
    sentAt: `2026-11-25T00:00:0${String(n)}.000Z`,
  };
}

async function thread() {
  const rows = await db.query(`select id from conversations`);
  return getConversation(db, String(rows[0]?.id));
}

function replies(): Extract<OutboundDelivery, { kind: "reply" }>[] {
  return slack.delivered.flatMap((d) => (d.kind === "reply" ? [d] : []));
}

/** The teammate makes one call in the turn answering the oldest message; answers its result. */
async function teammateCalls(name: string, input: unknown): Promise<string> {
  const teammate = runtime.onlySessionId();
  runtime.work(teammate);
  runtime.callCustomTools(teammate, [{ name, input }]);
  await syncConversation(deps, await thread(), log);
  const answer = runtime.sessions.get(teammate)?.answered.at(-1)?.text ?? "";
  runtime.finish(teammate, "Done.");
  await syncConversation(deps, await thread(), log);
  return answer;
}

const serviceToken = "t".repeat(48);
const env: Env = {
  API_SERVICE_TOKEN: serviceToken,
  WEB_API_SECRET: PERSON_SECRET,
  SLACK_WORKSPACE_ID: PERSON_WORKSPACE,
};

function app() {
  return configureApp(new Hono<ApiEnv>(), {
    env,
    log: memoryLogger().log,
    services: {
      conversations: deps,
      status: { db, configured: { agent: true, slack: true, github: true } },
    },
  });
}

async function as(actorId: string) {
  return {
    authorization: `Bearer ${await signPersonToken({ subject: actorId, name: "Someone" })}`,
    "content-type": "application/json",
  };
}

/** A fake Jira: answers search and issue reads from a list, and records what it was asked. */
function fakeJira(options: { down?: boolean } = {}) {
  const asked: { url: string; body: string | null; auth: string | null }[] = [];
  const issue = (key: string, summary: string, category: string, name: string) => ({
    key,
    fields: {
      summary,
      status: { name, statusCategory: { key: category } },
      assignee: { displayName: "Ada" },
      updated: "2026-11-24T10:00:00.000+0000",
    },
  });
  const issues = [
    issue("SCRUM-8", "Which task a thread works on", "indeterminate", "In Progress"),
    issue("SCRUM-9", "Ship briefs", "new", "To Do"),
  ];
  const fetchJira = (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    asked.push({
      url,
      body: typeof init.body === "string" ? init.body : null,
      auth: headers.get("authorization"),
    });
    if (options.down === true) return Promise.reject(new TypeError("fetch failed"));
    if (url.includes("/search/jql")) return Promise.resolve(Response.json({ issues }));
    const key = decodeURIComponent(url.split("/issue/")[1]?.split("?")[0] ?? "");
    const found = issues.find((i) => i.key === key);
    return Promise.resolve(
      found === undefined ? new Response("{}", { status: 404 }) : Response.json(found),
    );
  };
  return { asked, fetchJira };
}

const jiraConfig = {
  kind: "jira" as const,
  baseUrl: "https://example.atlassian.net",
  email: "bot@example.com",
  token: "secret-token",
  project: "SCRUM",
};

describe("the built-in tracker", () => {
  it("creates and edits a task as the person, on the version they saw, keeping each change", async () => {
    const api = app();
    const created = taskActionResultSchema.parse(
      await (
        await api.request("/v1/tasks", {
          method: "POST",
          headers: await as("U1"),
          body: JSON.stringify({
            title: "Rank results",
            description: "By recall",
            assigneeActorId: "U1",
          }),
        })
      ).json(),
    );
    expect(created).toMatchObject({
      status: "created",
      task: { key: "T-1", title: "Rank results", status: "todo", statusName: "To do", url: null },
    });
    const detail = taskDetailSchema.parse(
      await (await api.request("/v1/tasks/t-1", { headers: await as("U2") })).json(),
    );
    expect(detail).toMatchObject({
      provider: "builtin",
      builtin: { description: "By recall", version: 1, createdBy: { actorId: "U1" } },
    });
    const id = detail.builtin?.id ?? "";
    const edit = (body: object) =>
      as("U2").then((headers) =>
        api.request(`/v1/tasks/${id}`, { method: "PATCH", headers, body: JSON.stringify(body) }),
      );
    const edited = taskActionResultSchema.parse(
      await (await edit({ version: 1, status: "doing" })).json(),
    );
    expect(edited.task).toMatchObject({ status: "doing", statusName: "Doing" });
    expect(
      taskActionResultSchema.parse(await (await edit({ version: 1, title: "x" })).json()).status,
    ).toBe("changed");
    expect(
      taskActionResultSchema.parse(await (await edit({ version: 2, status: "doing" })).json())
        .status,
    ).toBe("unchanged");
    const after = taskDetailSchema.parse(
      await (await api.request("/v1/tasks/T-1", { headers: await as("U2") })).json(),
    );
    expect(after.builtin?.history.map((h) => [h.kind, h.actor.actorId])).toEqual([
      ["created", "U1"],
      ["edited", "U2"],
    ]);
    // Done ones are left out of the open list.
    await edit({ version: 2, status: "done" });
    const open = taskListSchema.parse(
      await (await api.request("/v1/tasks", { headers: await as("U1") })).json(),
    );
    expect(open).toEqual({ provider: "builtin", available: true, problem: null, tasks: [] });
    const all = taskListSchema.parse(
      await (await api.request("/v1/tasks?status=all&q=rank", { headers: await as("U1") })).json(),
    );
    expect(all.tasks.map((t) => t.key)).toEqual(["T-1"]);
  });

  it("refuses writes from the service token, and from anyone when Jira is the home", async () => {
    const service = await app().request("/v1/tasks", {
      method: "POST",
      headers: { authorization: `Bearer ${serviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(service.status).toBe(400);
    deps = { ...deps, tasks: createTaskSource(jiraConfig, db, log, fakeJira().fetchJira) };
    const jira = await app().request("/v1/tasks", {
      method: "POST",
      headers: await as("U1"),
      body: JSON.stringify({ title: "x" }),
    });
    expect(taskActionResultSchema.parse(await jira.json()).status).toBe("not_builtin");
  });
});

describe("Jira as the provider", () => {
  it("reads the project's issues the same way, with its own credential, quoting words", async () => {
    const jira = fakeJira();
    deps = { ...deps, tasks: createTaskSource(jiraConfig, db, log, jira.fetchJira) };
    const list = taskListSchema.parse(
      await (
        await app().request(`/v1/tasks?q=${encodeURIComponent('a" OR project = X')}`, {
          headers: await as("U1"),
        })
      ).json(),
    );
    expect(list.tasks).toEqual([
      {
        key: "SCRUM-8",
        title: "Which task a thread works on",
        status: "doing",
        statusName: "In Progress",
        assignee: { actorId: null, name: "Ada" },
        url: "https://example.atlassian.net/browse/SCRUM-8",
        updatedAt: "2026-11-24T10:00:00.000Z",
      },
      expect.objectContaining({ key: "SCRUM-9", status: "todo" }),
    ]);
    const search = jira.asked[0];
    expect(search?.auth).toBe(
      `Basic ${Buffer.from("bot@example.com:secret-token").toString("base64")}`,
    );
    expect(JSON.parse(search?.body ?? "{}")).toMatchObject({
      jql: 'project = "SCRUM" AND text ~ "a\\" OR project = X" AND statusCategory != Done ORDER BY updated DESC',
    });
    const detail = taskDetailSchema.parse(
      await (await app().request("/v1/tasks/SCRUM-8", { headers: await as("U1") })).json(),
    );
    expect(detail).toMatchObject({ provider: "jira", builtin: null, task: { key: "SCRUM-8" } });
    expect((await app().request("/v1/tasks/SCRUM-99", { headers: await as("U1") })).status).toBe(
      404,
    );
    // Another project's key is not looked up.
    expect((await app().request("/v1/tasks/OTHER-1", { headers: await as("U1") })).status).toBe(
      404,
    );
  });

  it("says when Jira is down or not configured, and never logs the token", async () => {
    const { log: quiet, lines } = memoryLogger();
    deps = {
      ...deps,
      tasks: createTaskSource(jiraConfig, db, quiet, fakeJira({ down: true }).fetchJira),
    };
    const down = taskListSchema.parse(
      await (await app().request("/v1/tasks", { headers: await as("U1") })).json(),
    );
    expect(down).toEqual({ provider: "jira", available: false, problem: "unreachable", tasks: [] });
    expect((await app().request("/v1/tasks/SCRUM-8", { headers: await as("U1") })).status).toBe(
      503,
    );

    const config = readTaskConfig(
      { TASK_PROVIDER: "jira", JIRA_BASE_URL: "http://insecure", JIRA_API_TOKEN: "secret-token" },
      quiet,
    );
    expect(config).toEqual({ kind: "jira_unconfigured" });
    deps = { ...deps, tasks: createTaskSource(config, db, quiet) };
    const off = taskListSchema.parse(
      await (await app().request("/v1/tasks", { headers: await as("U1") })).json(),
    );
    expect(off.problem).toBe("not_configured");
    expect(JSON.stringify(lines)).not.toContain("secret-token");
    expect(readTaskConfig({}, quiet)).toEqual({ kind: "builtin" });
  });
});

describe("a thread's task (SCRUM-8)", () => {
  it("links a thread to a task that exists, and the task lists the thread", async () => {
    await createTask(db, person("U1"), { title: "Rank results" });
    await receiveMessage(deps, message(1, "this is T-1"), log);
    expect(await teammateCalls("link_task", { key: "t-1" })).toContain('"title":"Rank results"');
    await receiveMessage(deps, message(2, "and T-7"), log);
    expect(await teammateCalls("link_task", { key: "T-7" })).toBe(
      "there is no task T-7 in the built-in tracker",
    );
    const detail = taskDetailSchema.parse(
      await (await app().request("/v1/tasks/T-1", { headers: await as("U1") })).json(),
    );
    expect(detail.threads).toEqual([
      expect.objectContaining({ channelId: "C1", threadId: "100.1" }),
    ]);
  });
});

describe("the waiting-on list", () => {
  it("records a wait someone in the thread has, posts it once, and lets the thread end it", async () => {
    await receiveMessage(deps, message(1, "hi", "U2", "Ada"), log);
    await teammateCalls("record_decision", {
      statement: "x",
      decidedBy: { actorId: "U9" },
      askedToRecord: false,
    });
    await receiveMessage(deps, message(2, "I can't go on until Ada reviews the ranking"), log);
    const answer = await teammateCalls("record_wait", {
      waiter: "U1",
      waitingOn: "U2",
      what: "review the ranking",
      taskKey: "scrum-8",
    });
    expect(JSON.parse(answer)).toEqual({ number: 1, recorded: true });
    const posted = replies().filter((r) => r.text.startsWith("**Wait"));
    expect(posted).toEqual([
      expect.objectContaining({
        text: "**Wait 1:** Grace is waiting on {@U2}: review the ranking (SCRUM-8)",
        mentions: ["U2"],
      }),
    ]);
    const list = waitListSchema.parse(
      await (await app().request("/v1/waits?person=U2", { headers: await as("U3") })).json(),
    );
    expect(list.waits).toEqual([
      expect.objectContaining({
        number: 1,
        waiter: { actorId: "U1", name: "Grace" },
        waitingOn: { actorId: "U2", name: "Ada" },
        taskKey: "SCRUM-8",
        status: "open",
        channelId: "C1",
        recordedBy: { actorId: "U1", name: "Grace" },
      }),
    ]);

    // Refused: a waiter who never wrote here, someone unknown, and oneself.
    await receiveMessage(deps, message(3, "a"), log);
    expect(
      await teammateCalls("record_wait", { waiter: "U5", waitingOn: "U2", what: "x" }),
    ).toContain("has not written in this thread");
    await receiveMessage(deps, message(4, "b"), log);
    expect(
      await teammateCalls("record_wait", { waiter: "U1", waitingOn: "UNOBODY", what: "x" }),
    ).toContain("is not someone the bot knows");
    await receiveMessage(deps, message(5, "c"), log);
    expect(await teammateCalls("record_wait", { waiter: "U1", waitingOn: "U1", what: "x" })).toBe(
      "a person cannot wait on themselves",
    );

    // Ada says it is done: the turn answering her message ends it.
    await receiveMessage(deps, message(6, "reviewed!", "U2", "Ada"), log);
    expect(JSON.parse(await teammateCalls("end_wait", { number: 1 }))).toEqual({
      number: 1,
      status: "ended",
    });
    expect(replies().map((r) => r.text)).toContain(
      'Wait 1 ended by Ada: Grace is no longer waiting on Ada for "review the ranking".',
    );
    await receiveMessage(deps, message(7, "d"), log);
    expect(await teammateCalls("end_wait", { number: 99 })).toBe(
      "there is no wait 99 recorded in this thread",
    );
  });

  it("answers a record_wait call again from what it recorded, posting once", async () => {
    await receiveMessage(deps, message(1, "hi", "U2", "Ada"), log);
    await receiveMessage(deps, message(2, "waiting on Ada"), log);
    const conversation = await thread();
    const call = {
      id: "sevt_wait_twice",
      name: "record_wait",
      input: { waiter: "U1", waitingOn: "U2", what: "x" },
      processedAt: null,
    };
    const first = await answerCustomToolCall(db, conversation.id, call, [], [], deps);
    const again = await answerCustomToolCall(db, conversation.id, call, [], [], deps);
    expect(again).toEqual(first);
    expect(await db.query(`select 1 from waits`)).toHaveLength(1);
    expect(
      await db.query(`select 1 from deliveries where agent_event_id like 'wait:%'`),
    ).toHaveLength(1);
  });

  it("lets a person record their own wait in the web app, and only its people end it", async () => {
    await receiveMessage(deps, message(1, "hi", "U2", "Ada"), log);
    const api = app();
    const record = async (by: string, body: object) =>
      waitActionResultSchema.parse(
        await (
          await api.request("/v1/waits", {
            method: "POST",
            headers: await as(by),
            body: JSON.stringify(body),
          })
        ).json(),
      );
    expect((await record("U1", { waitingOnActorId: "UNOBODY", what: "x" })).status).toBe(
      "unknown_person",
    );
    expect((await record("U1", { waitingOnActorId: "U1", what: "x" })).status).toBe(
      "unknown_person",
    );
    const recorded = await record("U1", {
      waitingOnActorId: "U2",
      what: "a review",
      taskKey: "t-3",
    });
    expect(recorded).toMatchObject({
      status: "recorded",
      wait: {
        waiter: { actorId: "U1" },
        waitingOn: { actorId: "U2", name: "Ada" },
        taskKey: "T-3",
        conversationId: null,
      },
    });
    const id = recorded.wait?.id ?? "";
    const end = async (by: string) =>
      waitActionResultSchema.parse(
        await (
          await api.request(`/v1/waits/${id}/end`, {
            method: "POST",
            headers: await as(by),
            body: "{}",
          })
        ).json(),
      );
    expect((await end("U3")).status).toBe("not_allowed");
    expect(await end("U2")).toMatchObject({
      status: "ended",
      wait: { endedBy: { actorId: "U2" } },
    });
    expect((await end("U1")).status).toBe("already_ended");
    const ended = waitListSchema.parse(
      await (await api.request("/v1/waits?status=ended", { headers: await as("U1") })).json(),
    );
    expect(ended.waits.map((w) => w.status)).toEqual(["ended"]);
    const open = waitListSchema.parse(
      await (await api.request("/v1/waits", { headers: await as("U1") })).json(),
    );
    expect(open.waits).toEqual([]);
  });
});
