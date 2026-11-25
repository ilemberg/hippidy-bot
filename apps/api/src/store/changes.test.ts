import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./testing.ts";

// Slice 2.1, part B: the schema for several sessions per conversation and for changes and
// their briefs. Nothing writes these tables yet; these tests hold the constraints the code of
// parts C and D will rely on.

let db: Awaited<ReturnType<typeof createTestDb>>;
let conversationId: string;

beforeEach(async () => {
  db = await createTestDb();
  const [row] = await db.query(
    `insert into conversations (source, workspace_id, channel_id, thread_id)
     values ('slack', 'T1', 'C1', '100.000001') returning id`,
  );
  conversationId = String(row?.id);
});

afterEach(async () => {
  await db.close();
});

async function change(): Promise<string> {
  const [row] = await db.query(
    `insert into changes (conversation_id, requested_by_source, requested_by_workspace_id,
       requested_by_actor_id)
     values ($1, 'slack', 'T1', 'U1') returning id, status`,
    [conversationId],
  );
  expect(row?.status).toBe("waiting_for_start");
  return String(row?.id);
}

function session(kind: string, changeId: string | null = null) {
  return db.query(
    `insert into agent_sessions (conversation_id, kind, change_id) values ($1, $2, $3)
     returning id, session_state`,
    [conversationId, kind, changeId],
  );
}

const brief = {
  title: "Change the reaction",
  what: "Use 🫡 instead of 👀.",
  why: "Asked for in the thread.",
  doneWhen: "The bot reacts with 🫡.",
};

function insertBrief(
  changeId: string,
  toolUseId: string,
  overrides: Partial<{
    what: string;
    links: string;
    startNeeded: boolean;
    startReason: string | null;
    startedAt: string | null;
    startedBy: string | null;
    workerEventId: string | null;
  }> = {},
) {
  return db.query(
    `insert into change_briefs (change_id, custom_tool_use_id, title, what, why, done_when, links,
       start_needed, start_reason, started_at, started_by_actor_id, worker_event_id)
     values ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8, $9, $10, $11, $12)
     returning id, seq`,
    [
      changeId,
      toolUseId,
      brief.title,
      overrides.what ?? brief.what,
      brief.why,
      brief.doneWhen,
      overrides.links ?? '["SCRUM-12"]',
      overrides.startNeeded ?? false,
      overrides.startReason ?? null,
      overrides.startedAt ?? null,
      overrides.startedBy ?? null,
      overrides.workerEventId ?? null,
    ],
  );
}

describe("agent_sessions", () => {
  it("allows one session a thread talks to, and one worker per change", async () => {
    expect(await session("teammate")).toEqual([
      { id: expect.any(String) as string, session_state: "active" },
    ]);
    await expect(session("teammate")).rejects.toThrow();
    await expect(session("legacy")).rejects.toThrow();

    const first = await change();
    const second = await change();
    await session("worker", first);
    await expect(session("worker", first)).rejects.toThrow();
    await session("worker", second);
  });

  it("ties a worker to a change, and nothing else", async () => {
    await expect(session("worker")).rejects.toThrow();
    await expect(session("teammate", await change())).rejects.toThrow();
    await expect(session("engineer")).rejects.toThrow();
  });
});

describe("change_briefs", () => {
  it("keeps a change's briefs in order, one per tool call", async () => {
    const changeId = await change();
    const [first] = await insertBrief(changeId, "toolu_1");
    const [second] = await insertBrief(changeId, "toolu_2");
    expect(Number(second?.seq)).toBeGreaterThan(Number(first?.seq));
    await expect(insertBrief(changeId, "toolu_1")).rejects.toThrow();
  });

  it("caps the text a person reads at 4,000 characters", async () => {
    const changeId = await change();
    await expect(insertBrief(changeId, "toolu_1", { what: "x".repeat(4000) })).rejects.toThrow();
    await insertBrief(changeId, "toolu_2", { what: "x".repeat(3900) });
  });

  it("takes links only as a JSON array", async () => {
    const changeId = await change();
    await expect(insertBrief(changeId, "toolu_1", { links: '"SCRUM-12"' })).rejects.toThrow();
    await insertBrief(changeId, "toolu_2", { links: "[]" });
  });

  it("says why a start is needed exactly when one is", async () => {
    const changeId = await change();
    await expect(insertBrief(changeId, "toolu_1", { startNeeded: true })).rejects.toThrow();
    await expect(
      insertBrief(changeId, "toolu_2", { startReason: "called getJiraIssue" }),
    ).rejects.toThrow();
    await insertBrief(changeId, "toolu_3", {
      startNeeded: true,
      startReason: "called getJiraIssue",
    });
  });

  it("records who started a brief that needed a person, and hands it over only once started", async () => {
    const changeId = await change();
    const needed = { startNeeded: true, startReason: "called getJiraIssue" };
    const now = "2026-11-25T12:00:00Z";
    // Started with no person, although one was needed.
    await expect(insertBrief(changeId, "toolu_1", { ...needed, startedAt: now })).rejects.toThrow();
    // A person without a time.
    await expect(insertBrief(changeId, "toolu_2", { startedBy: "U2" })).rejects.toThrow();
    // Handed to the worker before it was started.
    await expect(insertBrief(changeId, "toolu_3", { workerEventId: "sevt_1" })).rejects.toThrow();

    await insertBrief(changeId, "toolu_4", { ...needed, startedAt: now, startedBy: "U2" });
    await insertBrief(changeId, "toolu_5", { startedAt: now, workerEventId: "sevt_2" });
    await expect(
      insertBrief(changeId, "toolu_6", { startedAt: now, workerEventId: "sevt_2" }),
    ).rejects.toThrow();
  });

  it("goes with its change and its conversation", async () => {
    const changeId = await change();
    await insertBrief(changeId, "toolu_1");
    await session("worker", changeId);
    await db.query(`delete from conversations where id = $1`, [conversationId]);
    for (const table of ["changes", "change_briefs", "agent_sessions"]) {
      expect(await db.query(`select count(*)::int as n from ${table}`)).toEqual([{ n: 0 }]);
    }
  });
});
