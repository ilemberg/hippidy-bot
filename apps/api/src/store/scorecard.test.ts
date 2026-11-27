import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.ts";
import { readScorecard, scorecardWeeks } from "./scorecard.ts";
import { createTestDb } from "./testing.ts";

// Slice 4.5, part A (decision 223): the scorecard counts each kind in the right week, Monday
// 00:00 UTC to Monday, and nothing from another workspace.

let db: Awaited<ReturnType<typeof createTestDb>>;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.close();
});

const A = { source: "slack" as const, workspaceId: "TA" };
const B = { source: "slack" as const, workspaceId: "TB" };

/** A Wednesday; its week started on Monday 15 March 2027, clear of the seeded decision log. */
const now = new Date("2027-03-17T12:00:00.000Z");
/** The first moment of this week, and the last of last week. */
const MONDAY = "2027-03-15T00:00:00.000Z";
const SUNDAY_NIGHT = "2027-03-14T23:59:59.999Z";
/** Two weeks back, and after now: in neither week. */
const TOO_OLD = "2027-03-07T23:59:59.999Z";
const LATER = "2027-03-17T13:00:00.000Z";
/** The times every kind gets a record at, in workspace A. */
const TIMES = [MONDAY, SUNDAY_NIGHT, TOO_OLD, LATER];

describe("scorecardWeeks", () => {
  it("starts this week on Monday 00:00 UTC and last week seven days before", () => {
    expect(scorecardWeeks(now)).toEqual({
      lastWeekStart: new Date("2027-03-08T00:00:00.000Z"),
      thisWeekStart: new Date(MONDAY),
      now,
    });
  });

  it("puts Monday 00:00 UTC in the new week, and Sunday's last moment in the old", () => {
    expect(scorecardWeeks(new Date(MONDAY)).thisWeekStart).toEqual(new Date(MONDAY));
    expect(scorecardWeeks(new Date(SUNDAY_NIGHT)).thisWeekStart).toEqual(
      new Date("2027-03-08T00:00:00.000Z"),
    );
    // Sunday evening in UTC is still Sunday's week, wherever the server is.
    expect(scorecardWeeks(new Date("2027-03-21T23:00:00.000Z")).thisWeekStart).toEqual(
      new Date(MONDAY),
    );
  });
});

let threads = 0;
async function conversation(db: Db, place: typeof A): Promise<string> {
  threads += 1;
  const [row] = await db.query(
    `insert into conversations (source, workspace_id, channel_id, thread_id)
     values ($1, $2, 'C1', $3) returning id`,
    [place.source, place.workspaceId, `100.${String(threads)}`],
  );
  return String(row?.id);
}

async function decision(
  db: Db,
  place: typeof A | undefined,
  at: string,
  options: { status?: string; confirmedAt?: string; origin?: string } = {},
): Promise<void> {
  const origin = options.origin ?? "thread";
  await db.query(
    `insert into decisions (statement, status, decided_by_source, decided_by_workspace_id,
       decided_by_actor_id, decided_by_name, decided_at, origin, origin_ref, confirmed_at,
       confirmed_by_actor_id)
     values ('Use Postgres', $1, $2, $3, $4, 'Ada', $5::timestamptz, $6, $7, $8::timestamptz, $9)`,
    [
      options.status ?? "active",
      place?.source ?? null,
      place?.workspaceId ?? null,
      place === undefined ? null : "U1",
      at,
      origin,
      origin === "import" ? `i-${at}` : null,
      options.confirmedAt ?? null,
      options.confirmedAt === undefined ? null : "U2",
    ],
  );
}

async function conflict(db: Db, place: typeof A, at: string): Promise<void> {
  await db.query(
    `insert into conflicts (source, workspace_id, kind, summary, status, outcome, settled_at,
       settled_by_actor_id)
     values ($1, $2, 'raised', 'Postgres or not', 'settled', 'kept', $3::timestamptz, 'U1')`,
    [place.source, place.workspaceId, at],
  );
}

async function wait(db: Db, place: typeof A, at: string): Promise<void> {
  await db.query(
    `insert into waits (source, workspace_id, waiter_actor_id, waiting_on_actor_id, what,
       recorded_by_actor_id, ended_by_actor_id, ended_at)
     values ($1, $2, 'U1', 'U2', 'the review', 'U1', 'U1', $3::timestamptz)`,
    [place.source, place.workspaceId, at],
  );
}

async function brief(db: Db, place: typeof A, at: string | null): Promise<void> {
  const conversationId = await conversation(db, place);
  const [change] = await db.query(
    `insert into changes (conversation_id, requested_by_source, requested_by_workspace_id,
       requested_by_actor_id)
     values ($1, $2, $3, 'U1') returning id`,
    [conversationId, place.source, place.workspaceId],
  );
  await db.query(
    `insert into change_briefs (change_id, custom_tool_use_id, title, what, why, done_when,
       start_needed, start_reason, started_at)
     values ($1, $2, 'A change', 'what', 'why', 'done', $3, $4, $5::timestamptz)`,
    [
      String(change?.id),
      `toolu_${String(threads)}`,
      at === null,
      at === null ? "a person starts it" : null,
      at,
    ],
  );
}

let reviews = 0;
async function review(db: Db, at: string, status = "posted"): Promise<void> {
  reviews += 1;
  await db.query(
    `insert into pull_request_reviews (repository, number, head_sha, status, updated_at)
     values ('team/app', $1, 'abcdef1', $2, $3::timestamptz)`,
    [reviews, status, at],
  );
}

async function job(db: Db, place: typeof A, name: string, kind: string): Promise<string> {
  const [row] = await db.query(
    `insert into jobs (source, workspace_id, name, kind, cap_cents)
     values ($1, $2, $3, $4, 100) returning id`,
    [place.source, place.workspaceId, name, kind],
  );
  return String(row?.id);
}

let tickets = 0;
async function ticket(db: Db, goalJobId: string, at: string, state = "merged"): Promise<void> {
  tickets += 1;
  await db.query(
    `insert into goal_tickets (job_id, key, position, title, state, settled_at)
     values ($1, $2, $3, 'A ticket', $4, $5::timestamptz)`,
    [goalJobId, `SCRUM-${String(tickets)}`, tickets, state, at],
  );
}

async function goal(db: Db, place: typeof A): Promise<string> {
  const jobId = await job(db, place, `goal-${place.workspaceId.toLowerCase()}`, "goal");
  await db.query(`insert into goals (job_id, conversation_id) values ($1, $2)`, [
    jobId,
    await conversation(db, place),
  ]);
  return jobId;
}

const counts = async (place: typeof A) =>
  Object.fromEntries(
    (await readScorecard(db, place, now)).counts.map((c) => [c.kind, [c.thisWeek, c.lastWeek]]),
  );

describe("readScorecard", () => {
  it("counts each kind in its week, by Monday 00:00 UTC, and nothing from another workspace", async () => {
    await job(db, A, "checker", "checker");
    const goalA = await goal(db, A);
    const goalB = await goal(db, B);
    for (const at of TIMES) {
      await decision(db, A, at);
      await conflict(db, A, at);
      await wait(db, A, at);
      await brief(db, A, at);
      await review(db, at);
      await ticket(db, goalA, at);
    }
    // Workspace B's records, all this week.
    await decision(db, B, MONDAY);
    await conflict(db, B, MONDAY);
    await wait(db, B, MONDAY);
    await brief(db, B, MONDAY);
    await ticket(db, goalB, MONDAY);
    // Not counted anywhere: a brief not started, a review not posted, a ticket settled
    // otherwise than merged.
    await brief(db, A, null);
    await review(db, MONDAY, "abandoned");
    await ticket(db, goalA, MONDAY, "closed");

    const scorecard = await readScorecard(db, A, now);
    expect(scorecard).toMatchObject({
      lastWeekStart: "2027-03-08T00:00:00.000Z",
      thisWeekStart: MONDAY,
      readAt: now.toISOString(),
    });
    expect(scorecard.counts).toEqual([
      { kind: "decisions_made", thisWeek: 1, lastWeek: 1 },
      { kind: "conflicts_settled", thisWeek: 1, lastWeek: 1 },
      { kind: "waits_ended", thisWeek: 1, lastWeek: 1 },
      { kind: "changes_started", thisWeek: 1, lastWeek: 1 },
      { kind: "pull_requests_reviewed", thisWeek: 1, lastWeek: 1 },
      { kind: "tickets_merged", thisWeek: 1, lastWeek: 1 },
    ]);
    // B has no checker job, so the repository's reviews are not its.
    expect(await counts(B)).toEqual({
      decisions_made: [1, 0],
      conflicts_settled: [1, 0],
      waits_ended: [1, 0],
      changes_started: [1, 0],
      pull_requests_reviewed: [0, 0],
      tickets_merged: [1, 0],
    });
  });

  it("counts a decision when it became active, superseded since or not, imports for everyone", async () => {
    // Proposed last week, confirmed this week: made this week.
    await decision(db, A, SUNDAY_NIGHT, { confirmedAt: MONDAY });
    // Active last week, replaced since.
    await decision(db, A, SUNDAY_NIGHT, { status: "superseded" });
    // Never active.
    await decision(db, A, MONDAY, { status: "proposed" });
    await decision(db, A, MONDAY, { status: "rejected" });
    // From the decision log: the team's, in no workspace.
    await decision(db, undefined, MONDAY, { origin: "import" });
    // Recorded in a thread of A's by someone whose own record names no workspace.
    const conversationId = await conversation(db, A);
    await db.query(
      `insert into decisions (statement, status, decided_by_name, decided_at, origin,
         conversation_id)
       values ('Use Redis', 'active', 'Ada', $1::timestamptz, 'capture', $2)`,
      [MONDAY, conversationId],
    );
    expect((await counts(A)).decisions_made).toEqual([3, 1]);
    expect((await counts(B)).decisions_made).toEqual([1, 0]);
  });

  it("reads zero for a workspace with no records", async () => {
    expect(Object.values(await counts(B))).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
  });
});
