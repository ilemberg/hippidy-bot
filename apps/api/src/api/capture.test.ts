import type { Observation } from "@hippidy/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeExtractor, type ExtractResult } from "../agent/extractor.ts";
import { findOrCreateConversation } from "../store/conversations.ts";
import { recordObservation, setListening } from "../store/listening.ts";
import { createTestDb } from "../store/testing.ts";
import { memoryLogger } from "../testing.ts";
import { checkDecisions, runCapture, type CaptureDeps } from "./capture.ts";

// Slice 2.5: a quiet thread of a listened channel is read once, and what the model finds is
// written only as proposals, checked against the thread (decision 199).

let db: Awaited<ReturnType<typeof createTestDb>>;
let extractor: FakeExtractor;
let now: Date;
let deps: CaptureDeps;
const { log } = memoryLogger();

const channel = { source: "slack" as const, workspaceId: "T1", channelId: "C1" };

beforeEach(async () => {
  db = await createTestDb();
  extractor = new FakeExtractor();
  now = new Date("2026-11-25T12:00:00.000Z");
  deps = { db, extractor, dailyBudgetCents: 100, now: () => now };
  await setListening(db, { ...channel, listening: true, actor: { id: "U1" } });
});

afterEach(async () => {
  await db.close();
});

function minutesAgo(minutes: number): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString();
}

async function say(
  messageId: string,
  actor: string,
  text: string,
  minutes: number,
  threadId = "100.1",
) {
  const observation: Observation = {
    kind: "posted",
    ...channel,
    messageId,
    threadId,
    actor: { id: actor, displayName: actor === "U2" ? "Grace" : "Ada" },
    text,
    sentAt: minutesAgo(minutes),
  };
  await recordObservation(db, observation);
}

const usage = { inputTokens: 2000, outputTokens: 100 };

function found(
  ...decisions: Partial<{ statement: string; decidedBy: string; messageId: string }>[]
) {
  return {
    kind: "ok",
    usage,
    decisions: decisions.map((d) => ({
      statement: d.statement ?? "We use Postgres full-text search, not a vector store.",
      reason: "Fewer moving parts.",
      area: "Search",
      decidedBy: d.decidedBy ?? "U2",
      messageId: d.messageId ?? "100.2",
    })),
  } satisfies ExtractResult;
}

async function proposals() {
  return db.query(
    `select statement, status, origin, area, decided_by_actor_id, decided_by_name, message_id,
            channel_id, thread_id, confirmable_by, decided_at
     from decisions where origin = 'capture' order by number`,
  );
}

describe("runCapture", () => {
  it("reads a thread quiet for 30 minutes once, and proposes what it finds with its link", async () => {
    await say("100.1", "U1", "Vector store or full-text search?", 50);
    await say("100.2", "U2", "Full-text. Agreed, let's not add a vector store.", 40);
    extractor.answer(found({}));

    expect(await runCapture(deps, log)).toMatchObject({ read: 1, proposed: 1, failed: 0 });
    expect(extractor.calls[0]?.lines.map((l) => [l.messageId, l.actorId])).toEqual([
      ["100.1", "U1"],
      ["100.2", "U2"],
    ]);
    expect(await proposals()).toEqual([
      {
        statement: "We use Postgres full-text search, not a vector store.",
        status: "proposed",
        origin: "capture",
        area: "search",
        decided_by_actor_id: "U2",
        decided_by_name: "Grace",
        message_id: "100.2",
        channel_id: "C1",
        thread_id: "100.1",
        confirmable_by: ["U1", "U2"],
        decided_at: new Date(minutesAgo(40)),
      },
    ]);
    const [run] = await db.query(
      `select outcome, messages_read, proposals, input_tokens, output_tokens,
              cost_micros::float8 as cost from capture_runs`,
    );
    // 2,000 input tokens at $0.10 and 100 output at $0.50 per million.
    expect(run).toEqual({
      outcome: "proposed",
      messages_read: 2,
      proposals: 1,
      input_tokens: 2000,
      output_tokens: 100,
      cost: 250,
    });

    // Read once: nothing new, so nothing to do.
    expect((await runCapture(deps, log)).read).toBe(0);
    expect(extractor.calls).toHaveLength(1);
  });

  it("waits for a thread to go quiet, and reads it again after a new message, without repeating", async () => {
    await say("100.1", "U1", "Let's ship on Tuesdays.", 10);
    await say("100.2", "U2", "Fine by me.", 10);
    expect((await runCapture(deps, log)).read).toBe(0);

    now = new Date(now.getTime() + 30 * 60_000);
    extractor.answer(
      found({ statement: "Releases go out on Tuesdays.", decidedBy: "U1", messageId: "100.1" }),
    );
    expect((await runCapture(deps, log)).proposed).toBe(1);

    await say("100.3", "U2", "Agreed. Tuesdays it is.", 1);
    now = new Date(now.getTime() + 31 * 60_000);
    // The model repeats the first one and adds nothing new.
    extractor.answer(
      found({ statement: "releases go out on Tuesdays.", decidedBy: "U1", messageId: "100.1" }),
    );
    expect(await runCapture(deps, log)).toMatchObject({ read: 1, proposed: 0 });
    expect(extractor.calls[1]?.existing).toEqual(["Releases go out on Tuesdays."]);
    expect(await proposals()).toHaveLength(1);
  });

  it("reads an edited thread again, and a message that arrived late", async () => {
    await say("100.1", "U1", "Ship on Tuesdays?", 50);
    await say("100.2", "U2", "Yes.", 40);
    await runCapture(deps, log);
    expect(extractor.calls).toHaveLength(1);
    await recordObservation(db, {
      kind: "edited",
      ...channel,
      messageId: "100.2",
      text: "No: Wednesdays.",
      editedAt: minutesAgo(35),
    });
    await runCapture(deps, log);
    expect(extractor.calls[1]?.lines.map((l) => l.text)).toEqual([
      "Ship on Tuesdays?",
      "No: Wednesdays.",
    ]);
    // Sent before what capture read, delivered after it.
    await say("100.0", "U2", "Earlier thought.", 60);
    await runCapture(deps, log);
    expect(extractor.calls).toHaveLength(3);
  });

  it("does not read a message nobody answered: no model runs per message", async () => {
    await say("100.1", "U1", "We're going with Postgres.", 40);
    await say("200.1", "U2", "Lunch?", 40, "200.1");
    expect((await runCapture(deps, log)).read).toBe(0);
    expect(extractor.calls).toEqual([]);
  });

  it("skips a thread the bot was mentioned in, and one of a channel no longer listened to", async () => {
    await say("100.1", "U1", "We decided X.", 40);
    await say("100.2", "U2", "Yes.", 40);
    await findOrCreateConversation(db, { ...channel, threadId: "100.1" });
    await say("200.1", "U1", "We decided Y.", 40, "200.1");
    await say("200.2", "U2", "Yes.", 40, "200.1");
    await setListening(db, { ...channel, listening: false, actor: { id: "U1" } });
    expect((await runCapture(deps, log)).read).toBe(0);
    expect(extractor.calls).toEqual([]);
  });

  it("stops for the day at its budget, and lets the threads it claimed go", async () => {
    deps.dailyBudgetCents = 0;
    await say("100.1", "U1", "We decided X.", 40);
    await say("100.2", "U2", "Yes.", 40);
    expect(await runCapture(deps, log)).toMatchObject({ read: 0, budgetReached: true });
    expect(extractor.calls).toEqual([]);

    // A budget used up during the run: the first call spends it, the second thread waits.
    deps.dailyBudgetCents = 1;
    await say("200.1", "U1", "We decided Y.", 40, "200.1");
    await say("200.2", "U2", "Yes.", 40, "200.1");
    extractor.answer({
      kind: "ok",
      decisions: [],
      usage: { inputTokens: 0, outputTokens: 30_000 },
    });
    expect(await runCapture(deps, log)).toMatchObject({ read: 1, budgetReached: true });
    expect(extractor.calls).toHaveLength(1);
    expect(
      await db.query(
        `select count(*)::int as held from observed_threads where capture_lease_until is not null`,
      ),
    ).toEqual([{ held: 0 }]);
  });

  it("records a refused or failed read, tries again, and gives up after three until a new message", async () => {
    await say("100.1", "U1", "We decided X.", 40);
    await say("100.2", "U2", "Yes.", 40);
    extractor.answer({ kind: "refused", usage });
    extractor.answer({ kind: "failed", error: "timeout", usage: null });
    extractor.answer({ kind: "cut_off", usage });
    for (let run = 0; run < 4; run++) await runCapture(deps, log);
    expect(extractor.calls).toHaveLength(3);
    expect(
      (await db.query(`select outcome from capture_runs order by finished_at, outcome`)).map(
        (r) => r.outcome,
      ),
    ).toEqual(expect.arrayContaining(["refused", "failed", "cut_off"]));

    await say("100.3", "U2", "Still decided.", 31);
    expect((await runCapture(deps, log)).read).toBe(1);
  });

  it("keeps a call's cost and counts a failure when writing its proposals fails (from the review)", async () => {
    await say("100.1", "U1", "We decided X.", 40);
    await say("100.2", "U2", "Yes.", 40);
    extractor.answer(found({}));
    // Writing any proposal now fails, after the call was made.
    await db.query(
      `alter table decisions add constraint no_capture check (origin <> 'capture') not valid`,
    );
    expect(await runCapture(deps, log)).toMatchObject({ read: 0, failed: 1 });
    expect(await db.query(`select cost_micros::float8 as cost from capture_runs`)).toEqual([
      { cost: 250 },
    ]);
    expect(
      await db.query(`select capture_failures, capture_lease_until from observed_threads`),
    ).toEqual([{ capture_failures: 1, capture_lease_until: null }]);
  });
});

describe("checkDecisions", () => {
  const lines = [
    {
      messageId: "1.1",
      actorId: "U1",
      actorName: "Ada",
      text: "x",
      sentAt: "2026-11-25T00:00:00.000Z",
    },
    {
      messageId: "1.2",
      actorId: "U2",
      actorName: "Grace",
      text: "y",
      sentAt: "2026-11-25T00:01:00.000Z",
    },
  ];

  it("keeps only decisions the thread backs up, at most five, clipped", () => {
    const result = {
      kind: "ok" as const,
      usage,
      decisions: [
        {
          statement: "Someone not in the thread",
          reason: null,
          area: null,
          decidedBy: "U9",
          messageId: "1.1",
        },
        {
          statement: "A message not in the thread",
          reason: null,
          area: null,
          decidedBy: "U1",
          messageId: "9.9",
        },
        { statement: "  ", reason: null, area: null, decidedBy: "U1", messageId: "1.1" },
        { statement: "\u0000\u0000", reason: null, area: null, decidedBy: "U1", messageId: "1.1" },
        // U2 wrote in the thread, but not this message: "Ada says Grace decided X" is not
        // Grace's decision.
        {
          statement: "In someone else's name",
          reason: null,
          area: null,
          decidedBy: "U2",
          messageId: "1.1",
        },
        {
          statement: "Already on record",
          reason: null,
          area: null,
          decidedBy: "U1",
          messageId: "1.1",
        },
        ...Array.from({ length: 7 }, (_, i) => ({
          statement: `${String(i)} ${"s".repeat(600)}`,
          reason: "",
          area: " ",
          decidedBy: " U1 ",
          messageId: "1.1",
        })),
      ],
    };
    const kept = checkDecisions(result, lines, ["already on record"]);
    expect(kept).toHaveLength(5);
    expect(kept[0]).toMatchObject({
      reason: null,
      area: null,
      decidedBy: { actorId: "U1", name: "Ada" },
      decidedAt: "2026-11-25T00:00:00.000Z",
    });
    expect(kept[0]?.statement).toHaveLength(500);
  });
});
