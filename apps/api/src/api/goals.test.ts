import {
  goalActionResultSchema,
  jobDetailSchema,
  type CreateGoalRequest,
  type ListTasksQuery,
  type Task,
} from "@hippidy/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../agent/fake.ts";
import { FakeBriefWriter } from "../agent/brief-writer.ts";
import { configureApp } from "../compose.ts";
import type { Env } from "../config.ts";
import type {
  OpenPullRequest,
  PostedReview,
  PullRequestDiff,
  PullRequests,
  PullRequestState,
} from "../github/pulls.ts";
import { createBrief, startBrief, stopChanges } from "../store/changes.ts";
import { findOrCreateConversation } from "../store/conversations.ts";
import { listJobs } from "../store/jobs.ts";
import { createTask } from "../store/tasks.ts";
import { createTestDb } from "../store/testing.ts";
import { createTaskSource, type TaskLookup, type TaskSource } from "../tasks/provider.ts";
import { memoryLogger } from "../testing.ts";
import type { ConversationDeps } from "./conversations.ts";
import { goalBriefKey, runGoal, type GoalDeps } from "./goals.ts";
import { runJobs } from "./jobs.ts";
import { PERSON_SECRET, PERSON_WORKSPACE, RecordingDeliverer, signPersonToken } from "./testing.ts";
import type { ApiEnv } from "./types.ts";

// Slice 4.4 (decision 221): a person makes a goal for a thread the bot is in; each wake settles
// the changes it started and, under its limit, posts the next ticket's brief for a person to
// start. GitHub, the tracker and the model are faked.

let db: Awaited<ReturnType<typeof createTestDb>>;
const { log } = memoryLogger();
const place = { source: "slack" as const, workspaceId: PERSON_WORKSPACE };
const thread = { channelId: "C123ABC", threadId: "1700000000.000200" };
const REPO = "ilemberg/hippidy-bot";

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.close();
});

/** Pull requests in memory: only their state is read by goals. */
class FakePulls implements PullRequests {
  readonly repository = REPO;
  states: Record<number, PullRequestState> = {};
  failing = new Set<number>();
  asked: number[] = [];

  pullState(number: number): Promise<PullRequestState> {
    this.asked.push(number);
    if (this.failing.has(number)) return Promise.reject(new Error("GitHub answered 502"));
    return Promise.resolve(this.states[number] ?? "open");
  }
  listOpen(): Promise<OpenPullRequest[]> {
    return Promise.resolve([]);
  }
  diff(): Promise<PullRequestDiff> {
    return Promise.reject(new Error("not used"));
  }
  listReviews(): Promise<PostedReview[]> {
    return Promise.resolve([]);
  }
  postReview(): Promise<{ url: string }> {
    return Promise.reject(new Error("not used"));
  }
}

/** Jira, in memory, read-only. */
function fakeJira(tasks: Record<string, Partial<Task>>): TaskSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    provider: "jira",
    asked,
    list: (_place, _query: ListTasksQuery) =>
      Promise.resolve({ provider: "jira", available: true, problem: null, tasks: [] }),
    get(_place, key): Promise<TaskLookup> {
      asked.push(key);
      const task = tasks[key];
      if (task === undefined) return Promise.resolve({ kind: "missing" });
      return Promise.resolve({
        kind: "found",
        task: {
          key,
          title: `Jira ${key}`,
          status: "todo",
          statusName: "To Do",
          assignee: null,
          url: `https://acme.atlassian.net/browse/${key}`,
          updatedAt: "2026-11-26T00:00:00.000Z",
          ...task,
        },
      });
    },
  };
}

const serviceToken = "t".repeat(48);
const reconcileToken = "r".repeat(48);
const env: Env = {
  API_SERVICE_TOKEN: serviceToken,
  RECONCILE_TOKEN: reconcileToken,
  WEB_API_SECRET: PERSON_SECRET,
  SLACK_WORKSPACE_ID: PERSON_WORKSPACE,
};

interface Setup {
  app: Hono<ApiEnv>;
  pulls: FakePulls;
  writer: FakeBriefWriter;
  deliverer: RecordingDeliverer;
  conversations: ConversationDeps;
  conversationId: string;
  goalDeps: (tasks?: TaskSource) => GoalDeps;
  create: (body: Partial<CreateGoalRequest>, as?: string) => Promise<unknown>;
  edit: (jobId: string, body: object, as?: string) => Promise<unknown>;
  wake: (tasks?: TaskSource) => Promise<{ outcome: string; summary: string; cost: number }>;
}

async function setup(options: { tasks?: TaskSource } = {}): Promise<Setup> {
  const deliverer = new RecordingDeliverer();
  const conversations: ConversationDeps = {
    db,
    runtime: new FakeAgentRuntime(),
    deliverers: { slack: deliverer },
    sleep: () => Promise.resolve(),
    ...(options.tasks === undefined ? {} : { tasks: options.tasks }),
  };
  const pulls = new FakePulls();
  const writer = new FakeBriefWriter();
  const app = configureApp(new Hono<ApiEnv>(), {
    env,
    log: memoryLogger().log,
    services: {
      conversations,
      goals: { pulls, writer },
      status: { db, configured: { agent: true, slack: true, github: true } },
    },
  });
  // The bot is already in the thread.
  const conversation = await findOrCreateConversation(db, { ...place, ...thread });
  for (const title of ["Export button", "Export as CSV", "Export as PDF", "Export history"]) {
    await createTask(
      db,
      { ...place, actorId: "U1", name: "Grace" },
      { title, description: `${title}, described.` },
    );
  }
  const headers = async (as: string) => ({
    authorization:
      as === "service"
        ? `Bearer ${serviceToken}`
        : `Bearer ${await signPersonToken({ subject: as, name: as === "U1" ? "Grace" : "Ada" })}`,
    "content-type": "application/json",
  });
  // The built-in tracker unless a test says, as reconcile gives it when no other is configured.
  const goalDeps = (tasks?: TaskSource): GoalDeps => ({
    pulls,
    writer,
    tasks: tasks ?? options.tasks ?? createTaskSource({ kind: "builtin" }, db, log),
    conversations,
    webBaseUrl: "https://web.example",
  });
  return {
    app,
    pulls,
    writer,
    deliverer,
    conversations,
    conversationId: conversation.id,
    goalDeps,
    async create(body, as = "U1") {
      const res = await app.request("/v1/goals", {
        method: "POST",
        headers: await headers(as),
        body: JSON.stringify({
          name: "export",
          goal: "Let people export their data.",
          ...thread,
          tickets: ["T-1", "T-2", "T-3", "T-4"],
          ...body,
        }),
      });
      return res.status === 400 ? { httpStatus: 400 } : await res.json();
    },
    async edit(jobId, body, as = "U1") {
      const res = await app.request(`/v1/goals/${jobId}`, {
        method: "PATCH",
        headers: await headers(as),
        body: JSON.stringify(body),
      });
      return res.status === 400 ? { httpStatus: 400 } : await res.json();
    },
    async wake(tasks) {
      await db.query(`update jobs set last_wake_at = null where kind = 'goal'`);
      await runJobs({ db, place, goals: goalDeps(tasks) }, log);
      const [row] = await db.query(
        `select w.outcome, w.summary, w.cost_micros::float8 as cost from job_wakes w
         join jobs j on j.id = w.job_id where j.kind = 'goal'
         order by w.started_at desc, w.id desc limit 1`,
      );
      return row as { outcome: string; summary: string; cost: number };
    },
  };
}

async function tickets() {
  return db.query(
    `select t.key, t.state, t.failures, t.change_id is not null as has_change
     from goal_tickets t order by t.position`,
  );
}

async function goalJobId(): Promise<string> {
  const [row] = await db.query(`select id from jobs where kind = 'goal'`);
  return String(row?.id);
}

async function ticketChange(key: string): Promise<{ changeId: string; briefId: string }> {
  const [row] = await db.query(`select change_id, brief_id from goal_tickets where key = $1`, [
    key,
  ]);
  return { changeId: String(row?.change_id), briefId: String(row?.brief_id) };
}

async function openPullRequest(key: string, number: number): Promise<void> {
  const { changeId } = await ticketChange(key);
  await db.query(`update changes set pull_request_url = $2 where id = $1`, [
    changeId,
    `https://github.com/${REPO}/pull/${String(number)}`,
  ]);
}

describe("making a goal", () => {
  it("a person makes a goal for a thread the bot is in, owned by them and kept in its history", async () => {
    const s = await setup();
    expect(await s.create({ limit: 2 })).toEqual({ status: "created", name: "export" });
    const [job] = await db.query(
      `select name, kind, goal, owner_actor_id, owner_name, cap_cents, every_minutes, state
       from jobs where kind = 'goal'`,
    );
    expect(job).toEqual({
      name: "export",
      kind: "goal",
      goal: "Let people export their data.",
      owner_actor_id: "U1",
      owner_name: "Grace",
      cap_cents: 1000,
      every_minutes: 10,
      state: "active",
    });
    expect(await tickets()).toEqual(
      ["T-1", "T-2", "T-3", "T-4"].map((key) => ({
        key,
        state: "pending",
        failures: 0,
        has_change: false,
      })),
    );
    const headers = { authorization: `Bearer ${await signPersonToken({ subject: "U2" })}` };
    const detail = jobDetailSchema.parse(
      await (await s.app.request("/v1/jobs/export", { headers })).json(),
    );
    expect(detail.goal).toMatchObject({
      conversationId: s.conversationId,
      ...thread,
      limit: 2,
      open: 0,
      provider: "builtin",
    });
    expect(detail.goal?.tickets.map((t) => [t.key, t.title, t.state])).toEqual([
      ["T-1", "Export button", "pending"],
      ["T-2", "Export as CSV", "pending"],
      ["T-3", "Export as PDF", "pending"],
      ["T-4", "Export history", "pending"],
    ]);
    expect(detail.history).toHaveLength(1);
    expect(detail.history[0]).toMatchObject({
      actor: { actorId: "U1", name: "Grace" },
      before: {},
      after: { tickets: ["T-1", "T-2", "T-3", "T-4"], limit: 2, capCents: 1000 },
    });
    // Another job's detail has no goal.
    await runJobs({ db, place }, log);
    const capture = jobDetailSchema.parse(
      await (await s.app.request("/v1/jobs/capture", { headers })).json(),
    );
    expect(capture.goal).toBeNull();
  });

  it("refuses a thread the bot is not in, a second goal in a thread, a taken name and unknown tickets", async () => {
    const s = await setup();
    expect(await s.create({ threadId: "1700000000.999999" })).toEqual({ status: "no_thread" });
    expect(await s.create({ tickets: ["T-1", "T-9", "T-12"] })).toEqual({
      status: "unknown_tickets",
      tickets: ["T-9", "T-12"],
    });
    expect(await s.create({ name: "new-goal" })).toEqual({ status: "name_taken" });
    expect(await s.create({})).toMatchObject({ status: "created" });
    expect(await s.create({ name: "export-two" })).toEqual({ status: "thread_taken" });
    await findOrCreateConversation(db, { ...place, channelId: "C9", threadId: "1.2" });
    expect(await s.create({ channelId: "C9", threadId: "1.2" })).toEqual({
      status: "name_taken",
    });
    // Limits: 1 to 30 tickets, none twice, a limit of 1 to 5.
    expect(await s.create({ name: "x", tickets: [] })).toEqual({ httpStatus: 400 });
    expect(await s.create({ name: "x", tickets: ["T-1", "t-1"] })).toEqual({ httpStatus: 400 });
    expect(await s.create({ name: "x", limit: 6 })).toEqual({ httpStatus: 400 });
    expect(
      await s.create({
        name: "x",
        tickets: Array.from({ length: 31 }, (_, i) => `T-${String(i + 1)}`),
      }),
    ).toEqual({ httpStatus: 400 });
    expect((await db.query(`select 1 from jobs where kind = 'goal'`)).length).toBe(1);
  });

  it("checks tickets in Jira, and says when Jira cannot answer", async () => {
    const jira = fakeJira({ "SCRUM-1": {}, "SCRUM-2": {} });
    const s = await setup({ tasks: jira });
    expect(await s.create({ tickets: ["SCRUM-1", "SCRUM-3"] })).toEqual({
      status: "unknown_tickets",
      tickets: ["SCRUM-3"],
    });
    const down: TaskSource = {
      ...jira,
      get: () => Promise.resolve({ kind: "unavailable", problem: "unreachable" }),
    };
    const sDown = setupWith(down);
    expect(await sDown.create({ tickets: ["SCRUM-1"] })).toEqual({
      status: "tracker_unavailable",
    });
    expect(await s.create({ tickets: ["SCRUM-1", "SCRUM-2"] })).toMatchObject({
      status: "created",
    });
    const [row] = await db.query(`select title, url from goal_tickets where key = 'SCRUM-1'`);
    expect(row).toEqual({
      title: "Jira SCRUM-1",
      url: "https://acme.atlassian.net/browse/SCRUM-1",
    });
  });

  it("the service token cannot make or change a goal", async () => {
    const s = await setup();
    expect(await s.create({}, "service")).toEqual({ httpStatus: 400 });
    expect((await db.query(`select 1 from jobs where kind = 'goal'`)).length).toBe(0);
    await s.create({});
    const jobId = await goalJobId();
    expect(await s.edit(jobId, { version: 1, limit: 3 }, "service")).toEqual({
      httpStatus: 400,
    });
    const [row] = await db.query(`select open_limit from goals`);
    expect(row?.open_limit).toBe(2);
  });
});

/** A second app over the same database, with another tracker. */
function setupWith(tasks: TaskSource) {
  const app = configureApp(new Hono<ApiEnv>(), {
    env,
    log: memoryLogger().log,
    services: {
      conversations: {
        db,
        runtime: new FakeAgentRuntime(),
        deliverers: { slack: new RecordingDeliverer() },
        tasks,
      },
      status: { db, configured: { agent: true, slack: true, github: true } },
    },
  });
  return {
    async create(body: Partial<CreateGoalRequest>) {
      const res = await app.request("/v1/goals", {
        method: "POST",
        headers: {
          authorization: `Bearer ${await signPersonToken({ subject: "U1" })}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "export", goal: "G", ...thread, tickets: [], ...body }),
      });
      return res.json();
    },
  };
}

describe("changing a goal", () => {
  it("adds, removes and reorders tickets not yet briefed, and changes the limit, on the version seen", async () => {
    const s = await setup();
    await s.create({ tickets: ["T-1", "T-2", "T-3"] });
    const jobId = await goalJobId();
    expect(await s.edit(jobId, { version: 1, tickets: ["T-3", "T-4", "T-1"], limit: 3 })).toEqual({
      status: "edited",
      name: "export",
    });
    expect((await tickets()).map((t) => t.key)).toEqual(["T-3", "T-4", "T-1"]);
    // On the version seen: a stale page changes nothing.
    expect(await s.edit(jobId, { version: 1, limit: 1 })).toEqual({
      status: "changed",
      name: "export",
    });
    expect(await s.edit(jobId, { version: 2, tickets: ["T-3", "T-4", "T-9"] })).toEqual({
      status: "unknown_tickets",
      tickets: ["T-9"],
    });
    expect(await s.edit(jobId, { version: 2, limit: 3 })).toEqual({
      status: "unchanged",
      name: "export",
    });
    // A briefed ticket stays.
    await s.wake();
    expect(await s.edit(jobId, { version: 2, tickets: ["T-4", "T-1"] })).toEqual({
      status: "briefed_tickets",
      tickets: ["T-3"],
    });
    expect(await s.edit(jobId, { version: 2, tickets: ["T-4", "T-3"] })).toMatchObject({
      status: "edited",
    });
    expect((await tickets()).map((t) => [t.key, t.state])).toEqual([
      ["T-4", "pending"],
      ["T-3", "briefed"],
    ]);
    const history = await db.query(
      `select actor_id, before, after from job_events where job_id = $1 order by seq`,
      [jobId],
    );
    expect(history.slice(1)).toEqual([
      {
        actor_id: "U1",
        before: { tickets: ["T-1", "T-2", "T-3"], limit: 2 },
        after: { tickets: ["T-3", "T-4", "T-1"], limit: 3 },
      },
      {
        actor_id: "U1",
        before: { tickets: ["T-3", "T-4", "T-1"], limit: 3 },
        after: { tickets: ["T-4", "T-3"], limit: 3 },
      },
    ]);
    expect(await s.edit("00000000-0000-4000-8000-000000000000", { version: 1, limit: 2 })).toEqual({
      status: "not_found",
    });
  });
});

describe("a goal's wakes", () => {
  it("posts its first brief in its thread, needing Start, with its cost on the wake", async () => {
    const s = await setup();
    await s.create({});
    const wake = await s.wake();
    // $4 and $20 per million tokens: 5,000 in and 1,000 out.
    expect(wake).toEqual({ outcome: "said", summary: "posted the brief for T-1", cost: 40_000 });
    const briefs = s.deliverer.delivered.filter((d) => d.kind === "brief");
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toMatchObject({
      needsStart: true,
      target: { ...place, ...thread },
    });
    expect(briefs[0]?.kind === "brief" ? briefs[0].text : "").toContain(
      "I read ticket T-1 for the export goal before writing this, so someone needs to press Start",
    );
    expect(briefs[0]?.kind === "brief" ? briefs[0].text : "").toContain(
      "**Links:** https://web.example/tasks/T-1",
    );
    // The model was given the goal, the ticket with its description, and the other titles.
    expect(s.writer.calls[0]).toEqual({
      goal: { name: "export", text: "Let people export their data." },
      ticket: { key: "T-1", title: "Export button", description: "Export button, described." },
      others: [
        { key: "T-2", title: "Export as CSV" },
        { key: "T-3", title: "Export as PDF" },
        { key: "T-4", title: "Export history" },
      ],
    });
    // The change is the goal owner's, in the goal's thread, waiting for a person.
    const [change] = await db.query(
      `select c.conversation_id, c.requested_by_actor_id, c.status, b.start_needed,
         b.start_reason, b.custom_tool_use_id
       from changes c join change_briefs b on b.change_id = c.id`,
    );
    expect(change).toEqual({
      conversation_id: s.conversationId,
      requested_by_actor_id: "U1",
      status: "waiting_for_start",
      start_needed: true,
      start_reason: "read ticket T-1 for the export goal",
      custom_tool_use_id: goalBriefKey(await goalJobId(), "T-1"),
    });
    // One brief per wake: the second takes T-2, then the limit of two holds.
    expect(await s.wake()).toMatchObject({ outcome: "said", summary: "posted the brief for T-2" });
    expect(await s.wake()).toEqual({
      outcome: "silent",
      summary: "2 of 2 changes open; waiting",
      cost: 0,
    });
    expect(s.writer.calls).toHaveLength(2);
    expect(s.deliverer.delivered.filter((d) => d.kind === "brief")).toHaveLength(2);
    // Nobody started them: a brief nobody starts holds its place.
    expect(await s.wake()).toMatchObject({ outcome: "silent" });
  });

  it("a merged pull request marks the ticket merged and its task done, says so once, and frees a place", async () => {
    const s = await setup();
    await s.create({});
    await s.wake();
    await s.wake();
    const t1 = await ticketChange("T-1");
    expect(
      await startBrief(db, t1.briefId, { ...place, actorId: "U2", name: "Ada" }),
    ).toMatchObject({ status: "started" });
    await openPullRequest("T-1", 12);
    // Open: nothing to settle, the limit still holds.
    expect(await s.wake()).toMatchObject({ outcome: "silent" });
    expect(s.pulls.asked).toEqual([12]);
    s.pulls.states[12] = "merged";
    const wake = await s.wake();
    expect(wake).toEqual({
      outcome: "said",
      summary: "T-1 merged; posted the brief for T-3",
      cost: 40_000,
    });
    expect(s.deliverer.replies()).toEqual([
      `T-1's pull request [#12](https://github.com/${REPO}/pull/12) merged, so T-1 is done.`,
    ]);
    expect((await tickets()).map((t) => [t.key, t.state])).toEqual([
      ["T-1", "merged"],
      ["T-2", "briefed"],
      ["T-3", "briefed"],
      ["T-4", "pending"],
    ]);
    // The built-in task is done, as the goal, kept in its history.
    const [task] = await db.query(`select status, version from tasks where number = 1`);
    expect(task).toEqual({ status: "done", version: 2 });
    const [event] = await db.query(
      `select e.actor_id, e.actor_name, e.after->>'status' as status from task_events e
       join tasks t on t.id = e.task_id where t.number = 1 and e.kind = 'edited'`,
    );
    expect(event).toEqual({
      actor_id: "job:export",
      actor_name: "the export goal",
      status: "done",
    });
    // Said once: a later wake does not say it again, nor ask GitHub about it.
    await s.wake();
    expect(s.deliverer.replies()).toHaveLength(1);
    expect(s.pulls.asked.filter((n) => n === 12)).toHaveLength(2);
  });

  it("a stopped change or a closed pull request settles its ticket without a new brief", async () => {
    const s = await setup();
    await s.create({ tickets: ["T-1", "T-2"], limit: 2 });
    await s.wake();
    await s.wake();
    await openPullRequest("T-1", 7);
    s.pulls.states[7] = "closed";
    expect(await s.wake()).toMatchObject({ outcome: "said", summary: "T-1 closed" });
    await stopChanges(db, s.conversationId);
    expect(await s.wake()).toEqual({
      outcome: "said",
      summary: "T-2 stopped; every ticket is settled",
      cost: 0,
    });
    expect(s.deliverer.replies()).toEqual([
      `T-1's pull request [#7](https://github.com/${REPO}/pull/7) was closed without merging, so the goal will not brief T-1 again.`,
      "T-2's change was stopped in this thread, so the goal will not brief T-2 again.",
      "Every ticket of the export goal is settled (1 closed, 1 stopped).",
    ]);
    expect(s.writer.calls).toHaveLength(2);
    // Every ticket settled is said once.
    expect(await s.wake()).toEqual({
      outcome: "silent",
      summary: "every ticket is settled",
      cost: 0,
    });
    expect(s.deliverer.replies()).toHaveLength(3);
    // The tasks of closed or stopped tickets are not marked done.
    const done = await db.query(`select number from tasks where status = 'done'`);
    expect(done).toEqual([]);
  });

  it("a stop after a merge does not hide the merge", async () => {
    const s = await setup();
    await s.create({ tickets: ["T-1"] });
    await s.wake();
    await openPullRequest("T-1", 9);
    s.pulls.states[9] = "merged";
    await stopChanges(db, s.conversationId);
    expect(await s.wake()).toMatchObject({ summary: "T-1 merged; every ticket is settled" });
  });

  it("never briefs a ticket twice", async () => {
    const s = await setup();
    await s.create({ tickets: ["T-1", "T-2"] });
    const jobId = await goalJobId();
    // A wake that died after writing T-1's brief and before marking it: the next posts it,
    // without another model call.
    await createBrief(db, {
      conversationId: s.conversationId,
      customToolUseId: goalBriefKey(jobId, "T-1"),
      changeId: undefined,
      requestedBy: { ...place, actorId: "U1", name: "Grace" },
      brief: { title: "Earlier", what: "W", why: "Y", doneWhen: "D", links: [] },
      startReason: "read ticket T-1 for the export goal",
      turnEventIds: [],
    });
    expect(await s.wake()).toEqual({
      outcome: "said",
      summary: "posted the brief for T-1",
      cost: 0,
    });
    expect(s.writer.calls).toHaveLength(0);
    await s.wake();
    await s.wake();
    await s.wake();
    expect(s.writer.calls.map((call) => call.ticket.key)).toEqual(["T-2"]);
    const briefs = await db.query(
      `select custom_tool_use_id from change_briefs order by custom_tool_use_id`,
    );
    expect(briefs).toEqual([
      { custom_tool_use_id: goalBriefKey(jobId, "T-1") },
      { custom_tool_use_id: goalBriefKey(jobId, "T-2") },
    ]);
    // A run of the goal that overlaps another cannot either: the brief is keyed.
    await db.query(`update goal_tickets set state = 'pending' where key = 'T-2'`);
    await runGoal(s.goalDeps(), db, place, await goalJob(), log);
    expect((await db.query(`select 1 from change_briefs`)).length).toBe(2);
  });

  it("a refusal leaves the ticket pending and the wake failed; the third in a row skips it, said in the thread", async () => {
    const s = await setup();
    await s.create({ tickets: ["T-1", "T-2"], limit: 1 });
    s.writer.answer({ kind: "refused", usage: { inputTokens: 1_000, outputTokens: 0 } });
    s.writer.answer({ kind: "cut_off", usage: { inputTokens: 1_000, outputTokens: 6_000 } });
    s.writer.answer({ kind: "failed", error: "timeout", usage: null });
    expect(await s.wake()).toEqual({
      outcome: "failed",
      summary: "could not write the brief for T-1",
      cost: 4_000,
    });
    expect((await tickets())[0]).toMatchObject({ key: "T-1", state: "pending", failures: 1 });
    expect(await s.wake()).toMatchObject({ outcome: "failed", cost: 124_000 });
    expect(await s.wake()).toEqual({
      outcome: "failed",
      summary: "could not write the brief for T-1; skipped it",
      cost: 0,
    });
    expect((await tickets())[0]).toMatchObject({ key: "T-1", state: "skipped", failures: 3 });
    expect(s.deliverer.replies()).toEqual([
      "I could not write a brief for T-1 3 times in a row, so the goal skips it.",
    ]);
    const [wakeRow] = await db.query(
      `select error from job_wakes where outcome = 'failed' order by started_at limit 1`,
    );
    expect(wakeRow?.error).toBe("the model declined to write it");
    expect(await s.wake()).toMatchObject({ outcome: "said", summary: "posted the brief for T-2" });
  });

  it("a ticket done in the tracker already is not briefed, and the next is taken", async () => {
    const s = await setup();
    await s.create({ tickets: ["T-1", "T-2"] });
    await db.query(`update tasks set status = 'done' where number = 1`);
    expect(await s.wake()).toMatchObject({
      outcome: "said",
      summary: "T-1 done elsewhere; posted the brief for T-2",
    });
    expect((await tickets()).map((t) => t.state)).toEqual(["done_elsewhere", "briefed"]);
  });

  it("with Jira, a merged ticket is left for a person to close, the brief from its title and link", async () => {
    const jira = fakeJira({ "SCRUM-4": {}, "SCRUM-5": {} });
    const s = await setup({ tasks: jira });
    await s.create({ tickets: ["SCRUM-4", "SCRUM-5"], limit: 1 });
    await s.wake();
    expect(s.writer.calls[0]?.ticket).toEqual({
      key: "SCRUM-4",
      title: "Jira SCRUM-4",
      description: null,
    });
    const brief = s.deliverer.delivered.find((d) => d.kind === "brief");
    expect(brief?.kind === "brief" ? brief.text : "").toContain(
      "**Links:** https://acme.atlassian.net/browse/SCRUM-4",
    );
    await openPullRequest("SCRUM-4", 21);
    s.pulls.states[21] = "merged";
    expect(await s.wake()).toMatchObject({
      summary: "SCRUM-4 merged; posted the brief for SCRUM-5",
    });
    expect(s.deliverer.replies()).toEqual([
      `SCRUM-4's pull request [#21](https://github.com/${REPO}/pull/21) merged. I only read the tracker, so someone needs to close SCRUM-4 there.`,
    ]);
    // Jira is never written: only read.
    expect(jira.asked).toEqual(["SCRUM-4", "SCRUM-5", "SCRUM-4", "SCRUM-5"]);
  });

  it("a pull request GitHub cannot read is left for a later wake, and said in the summary", async () => {
    const s = await setup();
    await s.create({ tickets: ["T-1"] });
    await s.wake();
    await openPullRequest("T-1", 5);
    s.pulls.failing.add(5);
    expect(await s.wake()).toEqual({
      outcome: "silent",
      summary: "1 change open; no ticket left to brief; 1 pull request not read from GitHub",
      cost: 0,
    });
    expect((await tickets())[0]).toMatchObject({ state: "briefed" });
  });

  it("never changes its own goal, tickets or limit (rule 16)", async () => {
    const s = await setup();
    await s.create({ tickets: ["T-1", "T-2"] });
    const before = await db.query(
      `select j.goal, j.version, g.open_limit from jobs j join goals g on g.job_id = j.id`,
    );
    for (let i = 0; i < 3; i++) await s.wake();
    expect(
      await db.query(
        `select j.goal, j.version, g.open_limit from jobs j join goals g on g.job_id = j.id`,
      ),
    ).toEqual(before);
    expect((await tickets()).map((t) => t.key)).toEqual(["T-1", "T-2"]);
    expect((await db.query(`select 1 from job_events`)).length).toBe(1);
  });

  it("runs on reconcile with what compose gives it", async () => {
    const s = await setup();
    await s.create({ tickets: ["T-1"] });
    const res = await s.app.request("/v1/reconcile", {
      method: "POST",
      headers: { authorization: `Bearer ${reconcileToken}` },
    });
    expect(await res.json()).toMatchObject({ jobs: { said: 1, failed: 0 } });
    expect(s.writer.calls).toHaveLength(1);
    expect(goalActionResultSchema.safeParse({ status: "created", name: "export" }).success).toBe(
      true,
    );
  });
});

async function goalJob() {
  const job = (await listJobs(db, place)).find((j) => j.kind === "goal");
  if (job === undefined) throw new Error("no goal job");
  return job;
}
