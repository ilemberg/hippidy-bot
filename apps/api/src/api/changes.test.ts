import type { InboundMessage, OutboundDelivery } from "@hippidy/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../agent/fake.ts";
import type { AgentEvent } from "../agent/runtime.ts";
import type { ChecksVerdict } from "../github/checks.ts";
import { getChange, type Change } from "../store/changes.ts";
import { getConversation } from "../store/conversations.ts";
import { createTestDb } from "../store/testing.ts";
import { memoryLogger } from "../testing.ts";
import { briefForThread, startReason } from "./agent-tools.ts";
import {
  changeTexts,
  formatBriefForWorker,
  MAX_HAND_OVER_ATTEMPTS,
  startBriefByPerson,
  syncChange,
} from "./changes.ts";
import {
  changeNotes,
  formatForAgent,
  GIVE_UP_AFTER_MINUTES,
  notes,
  reconcile,
  receiveMessage,
  REPORTS_LEAD,
  stopConversation,
  syncConversation,
  type ConversationDeps,
} from "./conversations.ts";
import { RecordingDeliverer } from "./testing.ts";

// Slice 2.1, part C (decisions 181, 184): the teammate writes a brief with start_change, the
// API posts it and hands it to a coding worker (at once, or once a person presses Start), and
// the worker's turn settles the person's message.

let db: Awaited<ReturnType<typeof createTestDb>>;
let runtime: FakeAgentRuntime;
let slack: RecordingDeliverer;
let deps: ConversationDeps;
let verdict: ChecksVerdict;
const { log } = memoryLogger();
const url = "https://github.com/ilemberg/hippidy-bot/pull/60";

beforeEach(async () => {
  db = await createTestDb();
  runtime = new FakeAgentRuntime();
  slack = new RecordingDeliverer();
  verdict = { kind: "passed" };
  deps = {
    db,
    runtime,
    deliverers: { slack },
    sleep: () => Promise.resolve(),
    checks: { verdict: () => Promise.resolve(verdict) },
  };
});

afterEach(async () => {
  await db.close();
});

function message(n: number, text = `please change ${String(n)}`): InboundMessage {
  return {
    source: "slack",
    sourceEventId: `Ev${String(n)}`,
    conversation: {
      workspaceId: "T1",
      channelId: "C1",
      threadId: "100.000001",
      messageId: `100.00000${String(n)}`,
    },
    actor: { id: "U1", displayName: "Ada" },
    text,
    sentAt: `2026-11-25T00:00:0${String(n)}.000Z`,
  };
}

const brief = {
  title: "Change the reaction",
  what: "Use 🫡 instead of 👀 when a message is received.",
  why: "Asked for in the thread.",
  doneWhen: "The bot reacts with 🫡; CI passes.",
  links: ["SCRUM-12"],
};

async function thread() {
  const rows = await db.query(`select id from conversations`);
  return getConversation(db, String(rows[0]?.id));
}

async function onlyChange(): Promise<Change> {
  const rows = await db.query(`select id from changes`);
  expect(rows).toHaveLength(1);
  return getChange(db, String(rows[0]?.id));
}

function workerOf(change: Change): string {
  const id = change.agentSessionId;
  if (id === null) throw new Error("no worker");
  return id;
}

function briefs(): Extract<OutboundDelivery, { kind: "brief" }>[] {
  return slack.delivered.flatMap((d) => (d.kind === "brief" ? [d] : []));
}

/**
 * A person asks; the teammate reads `mcpReads` tools first, calls start_change, and ends its
 * turn. Returns the teammate's session id.
 */
async function askForChange(
  mcpReads: readonly string[] = [],
  input: unknown = brief,
): Promise<string> {
  await receiveMessage(deps, message(1), log);
  const teammate = runtime.onlySessionId();
  runtime.work(teammate);
  for (const name of mcpReads) runtime.mcpToolUse(teammate, "atlassian", name);
  runtime.callCustomTools(teammate, [{ name: "start_change", input }]);
  await syncConversation(deps, await thread(), log);
  runtime.finish(teammate, "I've written a brief for the coding worker.");
  await syncConversation(deps, await thread(), log);
  return teammate;
}

/** The worker opens a pull request and ends its turn. */
async function workerDelivers(change: Change, text = `Done: ${url}`) {
  const worker = workerOf(change);
  runtime.work(worker);
  runtime.pushed(worker);
  runtime.pullRequest(worker, url);
  runtime.finish(worker, text);
  await syncChange(deps, await getChange(db, change.id), log);
}

describe("the start rule (decision 181)", () => {
  const events: AgentEvent[] = [
    { kind: "user_message", id: "m1", processed: true },
    { kind: "mcp_tool_use", id: "t1", server: "atlassian", name: "getJiraIssue" },
    { kind: "mcp_tool_use", id: "t2", server: "atlassian", name: "getJiraIssue" },
    { kind: "custom_tool_use", id: "c1", name: "start_change", input: {}, processedAt: null },
    { kind: "mcp_tool_use", id: "t3", server: "atlassian", name: "searchConfluence" },
    { kind: "custom_tool_use", id: "c2", name: "start_change", input: {}, processedAt: null },
  ];

  it("needs no one when nothing outside the thread was read first", () => {
    const call: AgentEvent = {
      kind: "custom_tool_use",
      id: "c1",
      name: "start_change",
      input: {},
      processedAt: null,
    };
    expect(startReason([{ kind: "user_message", id: "m1", processed: true }, call], "c1")).toBe(
      undefined,
    );
  });

  it("names each tool read with before the brief, once", () => {
    expect(startReason(events, "c1")).toBe("read with atlassian.getJiraIssue");
    expect(startReason(events, "c2")).toBe(
      "read with atlassian.getJiraIssue, atlassian.searchConfluence",
    );
  });

  it("fails closed when the call is not among the events", () => {
    expect(startReason(events, "c9")).toBe("could not tell what was read before this brief");
  });
});

describe("a brief that needs no one to start it", () => {
  it("is posted, handed to a worker, and the person's message waits for the worker's CI", async () => {
    await askForChange();
    const change = await onlyChange();
    expect(change).toMatchObject({
      status: "started",
      requestedBy: { actorId: "U1", name: "Ada" },
    });
    expect(briefs()).toEqual([
      expect.objectContaining({ needsStart: false, text: briefForThread(brief, undefined) }),
    ]);
    // The teammate's turn ended, but the message waits for the change: no ✅ yet.
    expect(slack.replies()).toEqual(["I've written a brief for the coding worker."]);
    expect(slack.statuses()).toEqual([]);
    expect((await thread()).status).toBe("answered");

    const worker = workerOf(change);
    expect(runtime.sessions.get(worker)?.agentKind).toBe("engineer");
    expect(runtime.sessions.get(worker)?.sent).toEqual([
      formatBriefForWorker(change, { id: "", ...brief, followUp: false, posted: "sent" }),
    ]);
    expect(runtime.sessions.get(worker)?.sent[0]).toMatch(
      /^Change asked for by Ada \(slack user U1\) in Slack\.\n\n# Change the reaction/,
    );

    await workerDelivers(change);
    expect(slack.replies().at(-1)).toBe(`Done: ${url}`);
    expect(slack.statuses()).toEqual([{ messageIds: ["100.000001"], status: "answered" }]);
    expect((await getChange(db, change.id)).waitingSince).toBeNull();
  });

  it("shows ❌ when the worker's pull request fails CI", async () => {
    await askForChange();
    verdict = { kind: "failed", names: ["Lint, typecheck, test"] };
    await workerDelivers(await onlyChange(), "CI is red.");
    expect(slack.replies().slice(-2)).toEqual([
      "CI is red.",
      changeNotes.failed(url, ["Lint, typecheck, test"]),
    ]);
    expect(slack.statuses()).toEqual([{ messageIds: ["100.000001"], status: "failed" }]);
  });

  it("keeps the worker's usage on the change", async () => {
    await askForChange();
    const change = await onlyChange();
    runtime.setUsage(workerOf(change), { listCostMinor: 123, currency: "USD" });
    await workerDelivers(change);
    expect(await db.query(`select usage_list_cost_minor::int as cost from changes`)).toEqual([
      { cost: 123 },
    ]);
  });

  it("answers the call once, and posts the brief once, if the call is answered again", async () => {
    const teammate = await askForChange();
    const call = runtime.sessions.get(teammate)?.answered[0];
    expect(JSON.parse(call?.text ?? "{}")).toMatchObject({ status: "started" });
    await syncConversation(deps, await thread(), log);
    expect(await db.query(`select count(*)::int as n from change_briefs`)).toEqual([{ n: 1 }]);
    expect(briefs()).toHaveLength(1);
  });
});

describe("a brief written after reading Jira or Confluence", () => {
  it("waits for a person, then goes to the worker when they press Start", async () => {
    const teammate = await askForChange(["getJiraIssue"]);
    const answer = runtime.sessions.get(teammate)?.answered[0];
    expect(JSON.parse(answer?.text ?? "{}")).toMatchObject({ status: "waiting_for_start" });
    const [posted] = briefs();
    expect(posted).toMatchObject({ needsStart: true });
    expect(posted?.text).toContain("read with atlassian.getJiraIssue");
    expect((await onlyChange()).agentSessionId).toBeNull();
    expect(runtime.sessions.size).toBe(1);

    const result = await startBriefByPerson(
      deps,
      posted?.briefId ?? "",
      { source: "slack", workspaceId: "T1", actor: { id: "U2", displayName: "Grace" } },
      log,
    );
    expect(result).toEqual({ status: "started" });
    expect(slack.replies()).toContain(changeTexts.started("Grace"));
    const change = await onlyChange();
    expect(change.status).toBe("started");
    expect(runtime.sessions.get(workerOf(change))?.sent).toHaveLength(1);
    expect(await db.query(`select started_by_actor_id, start_reason from change_briefs`)).toEqual([
      { started_by_actor_id: "U2", start_reason: "read with atlassian.getJiraIssue" },
    ]);

    // A second press does nothing more.
    expect(
      await startBriefByPerson(
        deps,
        posted?.briefId ?? "",
        { source: "slack", workspaceId: "T1", actor: { id: "U3" } },
        log,
      ),
    ).toEqual({ status: "already_started" });
    expect(runtime.sessions.get(workerOf(change))?.sent).toHaveLength(1);

    await workerDelivers(change);
    expect(slack.statuses()).toEqual([{ messageIds: ["100.000001"], status: "answered" }]);
  });

  it("cannot be started from another workspace, nor once the thread was stopped", async () => {
    await askForChange(["searchConfluence"]);
    const briefId = briefs()[0]?.briefId ?? "";
    expect(
      await startBriefByPerson(
        deps,
        briefId,
        { source: "slack", workspaceId: "T9", actor: { id: "U2" } },
        log,
      ),
    ).toEqual({ status: "not_found" });

    await stopConversation(
      deps,
      {
        source: "slack",
        sourceEventId: "EvStop",
        workspaceId: "T1",
        channelId: "C1",
        threadId: "100.000001",
        actor: { id: "U1" },
      },
      log,
    );
    expect(slack.statuses()).toEqual([{ messageIds: ["100.000001"], status: "stopped" }]);
    expect(
      await startBriefByPerson(
        deps,
        briefId,
        { source: "slack", workspaceId: "T1", actor: { id: "U2" } },
        log,
      ),
    ).toEqual({ status: "stopped" });
    expect(slack.replies()).toContain(changeTexts.stopped);
    expect(runtime.sessions.size).toBe(1);
  });
});

describe("the worker and the thread", () => {
  it("is interrupted by a stop, and gets nothing more", async () => {
    await askForChange();
    const change = await onlyChange();
    runtime.work(workerOf(change));
    await stopConversation(
      deps,
      {
        source: "slack",
        sourceEventId: "EvStop",
        workspaceId: "T1",
        channelId: "C1",
        threadId: "100.000001",
        actor: { id: "U1" },
      },
      log,
    );
    expect(runtime.sessions.get(workerOf(change))?.interrupted).toBe(1);
    expect((await getChange(db, change.id)).status).toBe("stopped");
    expect(slack.statuses()).toEqual([{ messageIds: ["100.000001"], status: "stopped" }]);
  });

  it("tells the teammate what the worker reported, with the next message", async () => {
    const teammate = await askForChange();
    await workerDelivers(await onlyChange(), `Opened ${url}`);
    await receiveMessage(deps, message(2, "thanks, what next?"), log);
    const sent = runtime.sessions.get(teammate)?.sent.at(-1) ?? "";
    expect(sent).toBe(
      formatForAgent("U1", "thanks, what next?", "Ada", [], {}, [
        { title: brief.title, text: `Opened ${url}` },
      ]),
    );
    expect(sent.startsWith(`${REPORTS_LEAD}\n- On "Change the reaction": Opened ${url}`)).toBe(
      true,
    );
  });

  it("refuses a tool the API answers, and denies calls that wait for approval", async () => {
    await askForChange();
    const change = await onlyChange();
    const worker = workerOf(change);
    runtime.work(worker);
    const { custom, approvals } = runtime.callCustomTools(
      worker,
      [{ name: "start_change", input: brief }],
      1,
    );
    await syncChange(deps, await getChange(db, change.id), log);
    expect(runtime.sessions.get(worker)?.answered).toEqual([
      {
        customToolUseId: custom[0],
        text: "This tool is not available to the coding worker.",
        isError: true,
      },
    ]);
    expect(runtime.sessions.get(worker)?.denied).toEqual(approvals);
    expect(await db.query(`select count(*)::int as n from change_briefs`)).toEqual([{ n: 1 }]);
  });

  it("gives up on a worker's turn gone quiet, and reconcile hands over what failed", async () => {
    await receiveMessage(deps, message(1), log);
    const teammate = runtime.onlySessionId();
    runtime.work(teammate);
    runtime.callCustomTools(teammate, [{ name: "start_change", input: brief }]);
    // The worker cannot be started this time: reconcile tries again.
    runtime.failNext.startSession = new Error("runtime down");
    await syncConversation(deps, await thread(), log);
    expect((await onlyChange()).agentSessionId).toBeNull();
    await reconcile(deps, log);
    const change = await onlyChange();
    expect(runtime.sessions.get(workerOf(change))?.sent).toHaveLength(1);

    await db.query(`update changes set waiting_since = now() - make_interval(mins => $1)`, [
      GIVE_UP_AFTER_MINUTES + 1,
    ]);
    runtime.setClock(new Date(Date.now() - (GIVE_UP_AFTER_MINUTES + 5) * 60_000));
    runtime.work(workerOf(change));
    await syncChange(deps, await getChange(db, change.id), log);
    expect(runtime.sessions.get(workerOf(change))?.interrupted).toBe(1);
    expect(slack.replies()).toContain(notes.timeout);
    expect(slack.statuses()).toEqual([{ messageIds: ["100.000001"], status: "failed" }]);
  });

  it("answers its budget running out with a note and ❌", async () => {
    await askForChange();
    const change = await onlyChange();
    runtime.idle(workerOf(change), "budget_reached");
    await syncChange(deps, await getChange(db, change.id), log);
    expect((await getChange(db, change.id)).sessionState).toBe("budget_reached");
    expect(slack.replies()).toContain(notes.budget_reached);
    expect(slack.statuses()).toEqual([{ messageIds: ["100.000001"], status: "failed" }]);
  });
});

describe("start_change's answers", () => {
  it("refuses a bad brief, and a change id that is not the thread's", async () => {
    const teammate = await askForChange([], { title: "x" });
    expect(runtime.sessions.get(teammate)?.answered[0]).toMatchObject({ isError: true });
    expect(await db.query(`select count(*)::int as n from changes`)).toEqual([{ n: 0 }]);
    // Its message was not linked to anything, so the teammate's turn answered it.
    expect(slack.statuses()).toEqual([{ messageIds: ["100.000001"], status: "answered" }]);
  });

  it("refuses a change id that is not the thread's", async () => {
    const teammate = await askForChange([], {
      ...brief,
      changeId: "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f",
    });
    expect(runtime.sessions.get(teammate)?.answered[0]?.text).toBe(
      "this thread has no change with id 6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f",
    );
  });

  it("sends a further brief for the same change to the same worker, marked as an update", async () => {
    const teammate = await askForChange();
    const change = await onlyChange();
    await workerDelivers(change);
    await receiveMessage(deps, message(2, "also make it bigger"), log);
    runtime.work(teammate);
    runtime.callCustomTools(teammate, [
      { name: "start_change", input: { ...brief, title: "Bigger", changeId: change.id } },
    ]);
    await syncConversation(deps, await thread(), log);
    runtime.finish(teammate, "Sent the update.");
    await syncConversation(deps, await thread(), log);
    const sent = runtime.sessions.get(workerOf(change))?.sent ?? [];
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatch(/^An updated brief for the same change, asked for by Ada/);
    await workerDelivers(await getChange(db, change.id), "Bigger now.");
    expect(slack.statuses()).toEqual([
      { messageIds: ["100.000001"], status: "answered" },
      { messageIds: ["100.000002"], status: "answered" },
    ]);
  });
});

// From the independent review of part C.
describe("what the review found", () => {
  const stop = {
    source: "slack" as const,
    sourceEventId: "EvStop",
    workspaceId: "T1",
    channelId: "C1",
    threadId: "100.000001",
    actor: { id: "U1" },
  };

  async function followUp(teammate: string, change: Change, n: number, mcpReads: string[] = []) {
    await receiveMessage(deps, message(n, `follow-up ${String(n)}`), log);
    runtime.work(teammate);
    for (const name of mcpReads) runtime.mcpToolUse(teammate, "atlassian", name);
    runtime.callCustomTools(teammate, [
      {
        name: "start_change",
        input: { ...brief, title: `Follow-up ${String(n)}`, changeId: change.id },
      },
    ]);
    await syncConversation(deps, await thread(), log);
    runtime.finish(teammate, "Sent.");
    await syncConversation(deps, await thread(), log);
  }

  it("does not settle a follow-up by the turn before it while the worker works on it", async () => {
    const teammate = await askForChange();
    const change = await onlyChange();
    await workerDelivers(change);
    await followUp(teammate, change, 2);
    // The worker takes up the follow-up but has not finished it.
    runtime.work(workerOf(change));
    await syncChange(deps, await getChange(db, change.id), log);
    expect(slack.statuses()).toEqual([{ messageIds: ["100.000001"], status: "answered" }]);
    expect((await getChange(db, change.id)).waitingSince).not.toBeNull();
  });

  it("reads an Atlassian call from an earlier turn back from the record: a person must start", async () => {
    await receiveMessage(deps, message(1, "what does SCRUM-12 say?"), log);
    const teammate = runtime.onlySessionId();
    runtime.work(teammate);
    runtime.mcpToolUse(teammate, "atlassian", "getJiraIssue");
    runtime.finish(teammate, "It asks for a new reaction.");
    await syncConversation(deps, await thread(), log);
    // A later turn, read by a later sync that lists only new events.
    await receiveMessage(deps, message(2, "do it"), log);
    runtime.work(teammate);
    runtime.callCustomTools(teammate, [{ name: "start_change", input: brief }]);
    await syncConversation(deps, await thread(), log);
    expect(briefs()).toEqual([
      expect.objectContaining({
        needsStart: true,
        text: expect.stringContaining("getJiraIssue") as string,
      }),
    ]);
    expect(runtime.sessions.size).toBe(1);
  });

  it("starts nothing when the thread was stopped before the call was answered", async () => {
    await receiveMessage(deps, message(1), log);
    const teammate = runtime.onlySessionId();
    runtime.work(teammate);
    runtime.callCustomTools(teammate, [{ name: "start_change", input: brief }]);
    await stopConversation(deps, stop, log);
    await syncConversation(deps, await thread(), log);
    expect(runtime.sessions.get(teammate)?.answered[0]?.text).toMatch(/stopped/);
    expect(await db.query(`select count(*)::int as n from changes`)).toEqual([{ n: 0 }]);
    expect(runtime.sessions.size).toBe(1);
  });

  it("interrupts a worker a stop finds, even between its turns", async () => {
    await askForChange();
    const change = await onlyChange();
    await workerDelivers(change);
    await stopConversation(deps, stop, log);
    expect(runtime.sessions.get(workerOf(change))?.interrupted).toBe(1);
  });

  it("links only the call's own turn's messages, not an earlier one still waiting", async () => {
    await receiveMessage(deps, message(1, "a question"), log);
    const teammate = runtime.onlySessionId();
    runtime.reply(teammate, "An answer."); // its end is not synced yet
    await receiveMessage(deps, message(2), log);
    runtime.work(teammate);
    runtime.callCustomTools(teammate, [{ name: "start_change", input: brief }]);
    await syncConversation(deps, await thread(), log);
    runtime.finish(teammate, "Handed over.");
    await syncConversation(deps, await thread(), log);
    expect(slack.statuses()).toEqual([{ messageIds: ["100.000001"], status: "answered" }]);
    await workerDelivers(await onlyChange());
    expect(slack.statuses().at(-1)).toEqual({ messageIds: ["100.000002"], status: "answered" });
  });

  it("hands a brief over only once it is posted in the thread", async () => {
    await receiveMessage(deps, message(1), log);
    const teammate = runtime.onlySessionId();
    runtime.work(teammate);
    runtime.callCustomTools(teammate, [{ name: "start_change", input: brief }]);
    slack.failures = 1; // the brief's post fails once
    await syncConversation(deps, await thread(), log);
    expect((await onlyChange()).agentSessionId).toBeNull();
    await reconcile(deps, log); // posts it, then hands it over
    expect(briefs()).toHaveLength(1);
    expect(runtime.sessions.get(workerOf(await onlyChange()))?.sent).toHaveLength(1);
  });

  it("gives a brief up with a note after several failed hand-overs", async () => {
    await receiveMessage(deps, message(1), log);
    const teammate = runtime.onlySessionId();
    runtime.work(teammate);
    runtime.callCustomTools(teammate, [{ name: "start_change", input: brief }]);
    runtime.rejectAllSends = new Error("runtime down");
    await syncConversation(deps, await thread(), log);
    for (let attempt = 1; attempt < MAX_HAND_OVER_ATTEMPTS; attempt++) await reconcile(deps, log);
    expect(slack.replies()).toContain(notes.undeliverable);
    expect(slack.statuses()).toEqual([{ messageIds: ["100.000001"], status: "failed" }]);
    expect(await db.query(`select gave_up_at is not null as gave_up from change_briefs`)).toEqual([
      { gave_up: true },
    ]);
    // Nothing is left for reconcile to try.
    expect((await reconcile(deps, log)).checked).toBe(0);
  });

  it("answers a follow-up for a worker that can take no more with a note, once", async () => {
    const teammate = await askForChange();
    const change = await onlyChange();
    runtime.idle(workerOf(change), "budget_reached");
    await syncChange(deps, await getChange(db, change.id), log);
    await followUp(teammate, change, 2);
    expect(slack.replies()).toContain(notes.closed_budget);
    expect(slack.statuses().at(-1)).toEqual({ messageIds: ["100.000002"], status: "failed" });
    expect(runtime.sessions.get(workerOf(change))?.sent).toHaveLength(1);
    expect((await reconcile(deps, log)).checked).toBe(0);
  });

  it("hands two briefs started together to one new worker", async () => {
    const teammate = await askForChange(["getJiraIssue"]);
    const change = await onlyChange();
    await followUp(teammate, change, 2);
    const [first, second] = briefs();
    // Started in the database together, then handed over by one sync.
    await db.query(
      `update change_briefs set started_at = now(), started_by_source = 'slack',
         started_by_workspace_id = 'T1', started_by_actor_id = 'U2'`,
    );
    await db.query(`update changes set status = 'started'`);
    expect(first?.needsStart && second?.needsStart).toBe(true);
    await syncChange(deps, await getChange(db, change.id), log);
    expect(runtime.sessions.size).toBe(2);
    expect(runtime.sessions.get(workerOf(await getChange(db, change.id)))?.sent).toHaveLength(2);
  });
});

describe("the start rule counts git reads of other refs (G18, decision 189)", () => {
  it("makes a person start a brief written after the teammate fetched other refs", async () => {
    await receiveMessage(deps, message(1), log);
    const teammate = runtime.onlySessionId();
    runtime.work(teammate);
    runtime.gitRead(teammate);
    runtime.callCustomTools(teammate, [{ name: "start_change", input: brief }]);
    await syncConversation(deps, await thread(), log);
    expect(briefs()).toEqual([
      expect.objectContaining({
        needsStart: true,
        text: expect.stringContaining("git (refs other than main)") as string,
      }),
    ]);
    expect(runtime.sessions.size).toBe(1);
  });
});
