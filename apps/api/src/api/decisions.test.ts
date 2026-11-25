import type { InboundMessage, OutboundDelivery } from "@hippidy/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../agent/fake.ts";
import { getConversation } from "../store/conversations.ts";
import { createTestDb } from "../store/testing.ts";
import { memoryLogger } from "../testing.ts";
import { proposedBecause } from "./agent-tools.ts";
import {
  DECISIONS_LEAD,
  receiveMessage,
  syncConversation,
  type ConversationDeps,
} from "./conversations.ts";
import { confirmDecisionByPerson, decisionTexts } from "./decisions.ts";
import { RecordingDeliverer } from "./testing.ts";

// Slice 2.2, parts C and D (decisions 190 to 192): the teammate records decisions, the API
// decides whether each is active or proposed, a person confirms a proposal, and the decisions
// that bear on a message are put before it.

let db: Awaited<ReturnType<typeof createTestDb>>;
let runtime: FakeAgentRuntime;
let slack: RecordingDeliverer;
let deps: ConversationDeps;
const { log } = memoryLogger();

beforeEach(async () => {
  db = await createTestDb();
  runtime = new FakeAgentRuntime();
  slack = new RecordingDeliverer();
  deps = { db, runtime, deliverers: { slack }, sleep: () => Promise.resolve() };
});

afterEach(async () => {
  await db.close();
});

function message(n: number, text: string, actor = "U1", name = "Ada"): InboundMessage {
  return {
    source: "slack",
    sourceEventId: `Ev${String(n)}`,
    conversation: {
      workspaceId: "T1",
      channelId: "C1",
      threadId: "100.000001",
      messageId: `100.00000${String(n)}`,
    },
    actor: { id: actor, displayName: name },
    text,
    sentAt: `2026-11-25T00:00:0${String(n)}.000Z`,
  };
}

const decision = {
  statement: "Search uses Postgres full-text search, not a vector store.",
  reason: "Fewer moving parts.",
  area: "search",
  decidedBy: { actorId: "U1" },
  askedToRecord: true,
};

async function thread() {
  const rows = await db.query(`select id from conversations`);
  return getConversation(db, String(rows[0]?.id));
}

function decisionPosts(): Extract<OutboundDelivery, { kind: "decision" }>[] {
  return slack.delivered.flatMap((d) => (d.kind === "decision" ? [d] : []));
}

/** A person says something; the teammate reads `mcpReads` first, then records `input`. */
async function record(
  input: unknown,
  options: { mcpReads?: string[]; n?: number; text?: string; actor?: string } = {},
) {
  const n = options.n ?? 1;
  await receiveMessage(
    deps,
    message(n, options.text ?? "we'll use full-text search; record that", options.actor),
    log,
  );
  const teammate = [...runtime.sessions.keys()][0] ?? "";
  runtime.work(teammate);
  for (const name of options.mcpReads ?? []) runtime.mcpToolUse(teammate, "atlassian", name);
  runtime.callCustomTools(teammate, [{ name: "record_decision", input }]);
  await syncConversation(deps, await thread(), log);
  runtime.finish(teammate, "Recorded.");
  await syncConversation(deps, await thread(), log);
  const answered = runtime.sessions.get(teammate)?.answered.at(-1);
  return { teammate, answer: answered };
}

async function stored(number: number) {
  const [row] = await db.query(
    `select status, decided_by_actor_id, decided_by_name, message_id, area,
            confirmed_by_actor_id
     from decisions where number = $1`,
    [number],
  );
  return row;
}

describe("record_decision (decision 192)", () => {
  it("is active when the person who decided asked for it, and nothing untrusted was read", async () => {
    const { answer } = await record(decision);
    const output = JSON.parse(answer?.text ?? "{}") as { number: number; status: string };
    expect(output.status).toBe("active");
    expect(await stored(output.number)).toEqual({
      status: "active",
      decided_by_actor_id: "U1",
      decided_by_name: "Ada",
      message_id: "100.000001",
      area: "search",
      confirmed_by_actor_id: null,
    });
    expect(decisionPosts()).toEqual([expect.objectContaining({ needsConfirm: false })]);
    expect(decisionPosts()[0]?.text).toMatch(
      new RegExp(`^\\*\\*Recorded as decision ${String(output.number)}:\\*\\* Search uses`),
    );
  });

  it("is only proposed after a read of Jira or Confluence, and a person confirms it", async () => {
    const { answer } = await record(decision, { mcpReads: ["getJiraIssue"] });
    const output = JSON.parse(answer?.text ?? "{}") as { number: number; status: string };
    expect(output.status).toBe("proposed");
    const [post] = decisionPosts();
    expect(post).toMatchObject({ needsConfirm: true });
    expect(post?.text).toContain("read with atlassian.getJiraIssue first");

    const person = {
      source: "slack" as const,
      workspaceId: "T1",
      actor: { id: "U2", displayName: "Grace" },
    };
    expect(await confirmDecisionByPerson(deps, post?.decisionId ?? "", person, log)).toEqual({
      status: "confirmed",
    });
    expect(await stored(output.number)).toMatchObject({
      status: "active",
      confirmed_by_actor_id: "U2",
    });
    expect(slack.replies()).toContain(decisionTexts.confirmed(output.number, "Grace"));
    expect(await confirmDecisionByPerson(deps, post?.decisionId ?? "", person, log)).toEqual({
      status: "not_proposed",
    });
    expect(
      await confirmDecisionByPerson(
        deps,
        post?.decisionId ?? "",
        { ...person, workspaceId: "T9" },
        log,
      ),
    ).toEqual({ status: "not_found" });
  });

  it("is only proposed when someone else decided it, or nobody asked to record it", async () => {
    await receiveMessage(
      deps,
      message(1, "I think we should use full-text search", "U2", "Grace"),
      log,
    );
    // Grace's message gets its own turn; the next turn answers Ada.
    runtime.reply(runtime.onlySessionId(), "Noted.");
    await syncConversation(deps, await thread(), log);
    const first = await record({ ...decision, decidedBy: { actorId: "U2" } }, { n: 2 });
    expect(JSON.parse(first.answer?.text ?? "{}")).toMatchObject({ status: "proposed" });
    const second = await record({ ...decision, askedToRecord: false }, { n: 3 });
    expect(JSON.parse(second.answer?.text ?? "{}")).toMatchObject({ status: "proposed" });
  });

  it("refuses a decider who has not written in the thread", async () => {
    const { answer } = await record({ ...decision, decidedBy: { actorId: "U9" } });
    expect(answer).toMatchObject({ isError: true });
    expect(
      await db.query(`select count(*)::int as n from decisions where origin = 'thread'`),
    ).toEqual([{ n: 0 }]);
  });

  it("supersedes an active decision when the new one is active", async () => {
    const [old] = await db.query(
      `select number::int as number from decisions where origin_ref = '173'`,
    );
    const { answer } = await record({ ...decision, supersedes: Number(old?.number) });
    expect(JSON.parse(answer?.text ?? "{}")).toMatchObject({ status: "active" });
    expect(await stored(Number(old?.number))).toMatchObject({ status: "superseded" });
    expect(decisionPosts()[0]?.text).toContain(`It replaces decision ${String(old?.number)}.`);
  });

  it("records and posts once when the call is answered again", async () => {
    await record(decision);
    await syncConversation(deps, await thread(), log);
    expect(
      await db.query(`select count(*)::int as n from decisions where origin = 'thread'`),
    ).toEqual([{ n: 1 }]);
    expect(decisionPosts()).toHaveLength(1);
  });
});

describe("proposedBecause", () => {
  it("names the first reason a decision is only proposed", () => {
    expect(
      proposedBecause({ deciderIsAsker: true, askedToRecord: true, untrustedRead: undefined }),
    ).toBeUndefined();
    expect(
      proposedBecause({ deciderIsAsker: false, askedToRecord: true, untrustedRead: "read with x" }),
    ).toBe("I read with x first, so a person needs to confirm it");
    expect(
      proposedBecause({ deciderIsAsker: true, askedToRecord: false, untrustedRead: undefined }),
    ).toBe("nobody asked for it to be recorded");
  });
});

describe("recall (slice 2.2)", () => {
  it("answers recall_decisions with active decisions from the log, to cite", async () => {
    await receiveMessage(deps, message(1, "who may merge?"), log);
    const teammate = runtime.onlySessionId();
    runtime.work(teammate);
    runtime.callCustomTools(teammate, [
      { name: "recall_decisions", input: { query: "only a person merges", limit: 3 } },
    ]);
    await syncConversation(deps, await thread(), log);
    const answer = JSON.parse(runtime.sessions.get(teammate)?.answered[0]?.text ?? "{}") as {
      decisions: { number: number; where: string; decidedBy: string }[];
    };
    expect(answer.decisions.length).toBeGreaterThan(0);
    expect(answer.decisions.length).toBeLessThanOrEqual(3);
    expect(answer.decisions[0]?.where).toMatch(/^the planning log, entry \d+$/);
    expect(answer.decisions[0]?.decidedBy).toBe("the owner");
  });

  it("puts the decisions that bear on a message before it, in a teammate's thread", async () => {
    await receiveMessage(deps, message(1, "Who is allowed to merge a pull request?"), log);
    const sent = runtime.sessions.get(runtime.onlySessionId())?.sent[0] ?? "";
    expect(sent.startsWith(`${DECISIONS_LEAD}\n- Decision `)).toBe(true);
    expect(sent).toMatch(/planning log entry \d+\): /);
    expect(sent).toContain("From: Ada (Slack user U1)\n\nWho is allowed to merge a pull request?");
  });

  it("puts none before a message in an older thread, and none when nothing matches", async () => {
    deps.newThreadAgent = "engineer";
    await receiveMessage(deps, message(1, "Who is allowed to merge a pull request?"), log);
    expect(runtime.sessions.get(runtime.onlySessionId())?.sent[0]).not.toContain(DECISIONS_LEAD);
  });
});
