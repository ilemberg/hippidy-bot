import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureApp } from "../compose.ts";
import type { ApiEnv } from "./types.ts";
import { FakeAgentRuntime } from "../agent/fake.ts";
import { FakeReviewer } from "../agent/reviewer.ts";
import {
  DiffTooLargeError,
  type OpenPullRequest,
  type PostedReview,
  type PullRequestDiff,
  type PullRequests,
  type PullRequestState,
} from "../github/pulls.ts";
import { createBrief } from "../store/changes.ts";
import { findOrCreateConversation } from "../store/conversations.ts";
import type { Db } from "../store/db.ts";
import { recordDecision, searchDecisions } from "../store/decisions.ts";
import { createTestDb } from "../store/testing.ts";
import { memoryLogger } from "../testing.ts";
import {
  MAX_REVIEW_CHARACTERS,
  REVIEW_FOOTER,
  runChecker,
  reviewBody,
  type CheckerDeps,
} from "./checker.ts";
import type { ConversationDeps } from "./conversations.ts";
import { runJobs } from "./jobs.ts";
import { PERSON_WORKSPACE, RecordingDeliverer } from "./testing.ts";

// Slice 4.3 (decision 219): the checker reviews each new head commit of the repository's open
// pull requests once, as a comment, skipping drafts and forks; a failed post is tried twice
// more; a pull request that belongs to a change gets one line in its thread. GitHub and the
// model are faked.

let db: Awaited<ReturnType<typeof createTestDb>>;
const place = { source: "slack" as const, workspaceId: PERSON_WORKSPACE };
const REVIEW_TOKEN = "github_pat_review_secret";

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.close();
});

/** The repository's pull requests, in memory. */
class FakePulls implements PullRequests {
  readonly repository = "ilemberg/hippidy-bot";
  open: OpenPullRequest[] = [];
  diffs: Record<number, PullRequestDiff> = {};
  /** Every review GitHub took, whether or not its answer came back. */
  posted: { number: number; commitId: string; body: string; token: string; url: string }[] = [];
  /** Number of upcoming posts that fail before GitHub takes them. */
  failPosts = 0;
  /** Number of upcoming posts GitHub takes whose answer never comes back (a timeout). */
  loseAnswers = 0;
  /** Posts never settle, as when the wake's process is killed. */
  hangPosts = false;
  /** Pull requests whose diff GitHub will not send (HTTP 406). */
  tooLarge = new Set<number>();
  /** Times the reviews were listed. */
  listed = 0;
  /** Where each pull request is, for goals (slice 4.4); open unless set. */
  states: Record<number, PullRequestState> = {};

  pullState(number: number): Promise<PullRequestState> {
    return Promise.resolve(this.states[number] ?? "open");
  }

  listOpen(): Promise<OpenPullRequest[]> {
    return Promise.resolve(this.open.map((pull) => ({ ...pull })));
  }

  diff(number: number): Promise<PullRequestDiff> {
    if (this.tooLarge.has(number)) return Promise.reject(new DiffTooLargeError(number));
    return Promise.resolve(
      this.diffs[number] ?? {
        text: "diff --git a/apps/api/src/search.ts b/apps/api/src/search.ts\n+x\n",
        files: ["apps/api/src/search.ts"],
        omitted: [],
      },
    );
  }

  listReviews(number: number): Promise<PostedReview[]> {
    this.listed++;
    return Promise.resolve(
      this.posted
        .filter((review) => review.number === number)
        .map((review) => ({ commitId: review.commitId, body: review.body, url: review.url })),
    );
  }

  postReview(
    number: number,
    review: { commitId: string; body: string },
    token: string,
  ): Promise<{ url: string }> {
    if (this.hangPosts) return new Promise(() => undefined);
    if (this.failPosts > 0) {
      this.failPosts--;
      return Promise.reject(new Error(`GitHub answered 502 for POST /pulls/${String(number)}`));
    }
    const url = `https://github.com/ilemberg/hippidy-bot/pull/${String(number)}#pullrequestreview-${String(this.posted.length + 1)}`;
    this.posted.push({ number, ...review, token, url });
    if (this.loseAnswers > 0) {
      this.loseAnswers--;
      return Promise.reject(new Error("The operation was aborted due to timeout"));
    }
    return Promise.resolve({ url });
  }
}

function pullRequest(number: number, overrides: Partial<OpenPullRequest> = {}): OpenPullRequest {
  return {
    number,
    title: `Search change ${String(number)}`,
    body: "",
    draft: false,
    headSha: `${String(number)}aaaaaaa`,
    fromFork: false,
    url: `https://github.com/ilemberg/hippidy-bot/pull/${String(number)}`,
    updatedAt: "2026-11-26T10:00:00Z",
    ...overrides,
  };
}

function checker(overrides: Partial<CheckerDeps> = {}) {
  const pulls = new FakePulls();
  const reviewer = new FakeReviewer();
  const deps: CheckerDeps = { pulls, reviewToken: REVIEW_TOKEN, reviewer, ...overrides };
  return { pulls, reviewer, deps };
}

async function reviews() {
  return db.query(
    `select number, head_sha, status, attempts, cost_micros::float8 as cost, concerns,
       review_url, error
     from pull_request_reviews order by created_at, number`,
  );
}

async function checkerWakes() {
  return db.query(
    `select w.outcome, w.summary, w.cost_micros::float8 as cost from job_wakes w
     join jobs j on j.id = w.job_id where j.name = 'checker' order by w.started_at`,
  );
}

const { log } = memoryLogger();

describe("the checker", () => {
  it("reviews a new head once, as a comment with the review token, with its cost on the wake", async () => {
    const { pulls, reviewer, deps } = checker();
    pulls.open = [pullRequest(7)];
    reviewer.answer({
      kind: "ok",
      review: {
        summary: "It changes search.",
        concerns: [{ file: "apps/api/src/search.ts", line: 3, why: "Empty input throws." }],
        tryByHand: ["Search for nothing."],
      },
      usage: { inputTokens: 10_000, outputTokens: 1_000 },
    });
    expect(await runJobs({ db, place, checker: deps }, log)).toMatchObject({ said: 1 });
    // $4 and $20 per million tokens: 40,000 + 20,000 micros.
    expect(await checkerWakes()).toEqual([
      { outcome: "said", summary: "reviewed #7 (1 concern)", cost: 60_000 },
    ]);
    expect(pulls.posted).toHaveLength(1);
    expect(pulls.posted[0]).toMatchObject({ number: 7, commitId: "7aaaaaaa", token: REVIEW_TOKEN });
    expect(pulls.posted[0]?.body).toContain("`apps/api/src/search.ts:3` — Empty input throws.");
    expect(await reviews()).toEqual([
      {
        number: 7,
        head_sha: "7aaaaaaa",
        status: "posted",
        attempts: 1,
        cost: 60_000,
        concerns: 1,
        review_url: "https://github.com/ilemberg/hippidy-bot/pull/7#pullrequestreview-1",
        error: null,
      },
    ]);
    // A first try posts what it just wrote without listing the reviews first.
    expect(pulls.listed).toBe(0);
    // A second wake has nothing to do.
    expect(await runChecker(deps, db, log)).toEqual({
      outcome: "silent",
      summary: "no new pull request to review",
      costMicros: 0,
    });
    expect(reviewer.calls).toHaveLength(1);
  });

  it("reviews a new head of the same pull request again", async () => {
    const { pulls, reviewer, deps } = checker();
    pulls.open = [pullRequest(7)];
    await runChecker(deps, db, log);
    pulls.open = [pullRequest(7, { headSha: "7bbbbbbb" })];
    expect(await runChecker(deps, db, log)).toMatchObject({
      outcome: "said",
      summary: "reviewed #7 (0 concerns)",
    });
    expect(pulls.posted.map((p) => p.commitId)).toEqual(["7aaaaaaa", "7bbbbbbb"]);
    expect(reviewer.calls).toHaveLength(2);
  });

  it("skips drafts and forks, and takes the newest change first", async () => {
    const { pulls, reviewer, deps } = checker();
    pulls.open = [pullRequest(9, { draft: true }), pullRequest(8, { fromFork: true })];
    expect(await runChecker(deps, db, log)).toMatchObject({
      outcome: "silent",
      summary: "no open pull request to review",
    });
    pulls.open = [...pulls.open, pullRequest(6), pullRequest(5)];
    await runChecker(deps, db, log);
    await runChecker(deps, db, log);
    expect(pulls.posted.map((p) => p.number)).toEqual([6, 5]);
    expect(reviewer.calls.map((call) => call.number)).toEqual([6, 5]);
  });

  it("calls no model without the review token, GitHub or the agent, and says why", async () => {
    const { pulls, reviewer, deps } = checker({ reviewToken: undefined });
    pulls.open = [pullRequest(7)];
    expect(await runJobs({ db, place, checker: deps }, log)).toMatchObject({ failed: 0 });
    expect(await checkerWakes()).toEqual([
      { outcome: "silent", summary: "no review token", cost: 0 },
    ]);
    expect(await runChecker({ ...deps, pulls: undefined }, db, log)).toMatchObject({
      summary: "GitHub is not configured",
    });
    expect(
      await runChecker({ ...deps, reviewToken: REVIEW_TOKEN, reviewer: undefined }, db, log),
    ).toMatchObject({ summary: "the agent is not configured" });
    expect(await runChecker(undefined, db, log)).toMatchObject({ outcome: "silent" });
    expect(reviewer.calls).toHaveLength(0);
    expect(await reviews()).toEqual([]);
  });

  it("tries a failed post twice more, posting the same review, then abandons it", async () => {
    const { pulls, reviewer, deps } = checker();
    pulls.open = [pullRequest(7)];
    pulls.failPosts = 3;
    const first = await runChecker(deps, db, log);
    expect(first).toMatchObject({
      outcome: "failed",
      summary: "could not post the review of #7",
      costMicros: 60_000,
    });
    expect(await reviews()).toMatchObject([{ status: "failed", attempts: 1, cost: 60_000 }]);
    expect(await runChecker(deps, db, log)).toMatchObject({ outcome: "failed", costMicros: 0 });
    expect(await runChecker(deps, db, log)).toMatchObject({ outcome: "failed" });
    expect(await reviews()).toMatchObject([
      { status: "abandoned", attempts: 3, error: expect.stringContaining("502") as string },
    ]);
    // Written once, not paid for again on each try; then never tried again.
    expect(reviewer.calls).toHaveLength(1);
    expect(await runChecker(deps, db, log)).toMatchObject({
      outcome: "silent",
      summary: "no new pull request to review",
    });
    expect(pulls.posted).toHaveLength(0);
  });

  it("posts on a later try after a failed one, once", async () => {
    const { pulls, deps } = checker();
    pulls.open = [pullRequest(7)];
    pulls.failPosts = 1;
    await runChecker(deps, db, log);
    expect(await runChecker(deps, db, log)).toMatchObject({ outcome: "said" });
    expect(await reviews()).toMatchObject([{ status: "posted", attempts: 2, cost: 60_000 }]);
    expect(await runChecker(deps, db, log)).toMatchObject({ outcome: "silent" });
    expect(pulls.posted).toHaveLength(1);
  });

  it("abandons a head at once on a refusal or a cut-off, silent on the wake, with its cost", async () => {
    const { pulls, reviewer, deps } = checker();
    pulls.open = [pullRequest(7)];
    reviewer.answer({ kind: "refused", usage: { inputTokens: 1_000, outputTokens: 0 } });
    expect(await runChecker(deps, db, log)).toEqual({
      outcome: "silent",
      summary: "#7: the model declined to review it",
      costMicros: 4_000,
    });
    expect(await reviews()).toMatchObject([
      { status: "abandoned", attempts: 1, cost: 4_000, error: "the model declined to review it" },
    ]);
    // Not tried again: it would be refused again.
    expect(await runChecker(deps, db, log)).toMatchObject({
      summary: "no new pull request to review",
    });
    pulls.open = [pullRequest(8)];
    reviewer.answer({ kind: "cut_off", usage: { inputTokens: 1_000, outputTokens: 8_000 } });
    expect(await runChecker(deps, db, log)).toEqual({
      outcome: "silent",
      summary: "#8: the review was cut off",
      costMicros: 164_000,
    });
    expect(await runChecker(deps, db, log)).toMatchObject({
      summary: "no new pull request to review",
    });
    expect(await reviews()).toMatchObject([
      { number: 7, status: "abandoned" },
      { number: 8, status: "abandoned", attempts: 1, cost: 164_000 },
    ]);
    expect(reviewer.calls).toHaveLength(2);
    expect(pulls.posted).toHaveLength(0);
  });

  it("abandons a head whose diff GitHub refuses as too large, silent, calling no model", async () => {
    const { pulls, reviewer, deps } = checker();
    pulls.open = [pullRequest(7)];
    pulls.tooLarge.add(7);
    expect(await runJobs({ db, place, checker: deps }, log)).toMatchObject({ failed: 0 });
    expect(await checkerWakes()).toEqual([
      { outcome: "silent", summary: "#7: too large to review", cost: 0 },
    ]);
    expect(await reviews()).toMatchObject([
      { status: "abandoned", attempts: 1, cost: 0, error: "too large to review" },
    ]);
    expect(await runChecker(deps, db, log)).toMatchObject({
      summary: "no new pull request to review",
    });
    expect(reviewer.calls).toHaveLength(0);
  });

  it("does not post a review twice when GitHub took it but its answer was lost", async () => {
    const { pulls, reviewer, deps } = checker();
    pulls.open = [pullRequest(7)];
    pulls.loseAnswers = 1;
    expect(await runChecker(deps, db, log)).toMatchObject({
      outcome: "failed",
      summary: "could not post the review of #7",
    });
    expect(pulls.posted).toHaveLength(1);
    // The next try finds it on GitHub by its commit and footer, and marks it posted.
    expect(await runChecker(deps, db, log)).toEqual({
      outcome: "said",
      summary: "reviewed #7 (0 concerns)",
      costMicros: 0,
    });
    expect(pulls.listed).toBe(1);
    expect(pulls.posted).toHaveLength(1);
    expect(reviewer.calls).toHaveLength(1);
    expect(await reviews()).toMatchObject([
      {
        status: "posted",
        attempts: 2,
        cost: 60_000,
        review_url: pulls.posted[0]?.url,
        error: null,
      },
    ]);
  });

  it("does not take another bot's review or one on another commit for its own", async () => {
    const { pulls, deps } = checker();
    pulls.open = [pullRequest(7)];
    pulls.failPosts = 1;
    await runChecker(deps, db, log);
    pulls.posted.push(
      { number: 7, commitId: "7aaaaaaa", body: "Looks fine.", token: "x", url: "u1" },
      { number: 7, commitId: "0ldc0mmit", body: `_${REVIEW_FOOTER}_`, token: "x", url: "u2" },
    );
    expect(await runChecker(deps, db, log)).toMatchObject({ outcome: "said" });
    expect(pulls.posted).toHaveLength(3);
    expect(await reviews()).toMatchObject([{ review_url: pulls.posted[2]?.url }]);
  });

  it("posts a review whose try died after writing it, without calling the model again", async () => {
    const { pulls, reviewer, deps } = checker();
    pulls.open = [pullRequest(7)];
    reviewer.answer({
      kind: "ok",
      review: {
        summary: "It changes search.",
        concerns: [{ file: "apps/api/src/search.ts", line: 3, why: "Empty input throws." }],
        tryByHand: [],
      },
      usage: { inputTokens: 10_000, outputTokens: 1_000 },
    });
    // The wake's process is killed while it posts: its review was saved before.
    pulls.hangPosts = true;
    void runChecker(deps, db, log);
    await vi.waitFor(async () => {
      expect(await reviews()).toMatchObject([
        { status: "pending", cost: 60_000, concerns: 1, review_url: null },
      ]);
    });
    await db.query(`update pull_request_reviews set updated_at = now() - interval '11 minutes'`);
    pulls.hangPosts = false;
    expect(await runChecker(deps, db, log)).toEqual({
      outcome: "said",
      summary: "reviewed #7 (1 concern)",
      costMicros: 0,
    });
    expect(reviewer.calls).toHaveLength(1);
    expect(pulls.posted).toHaveLength(1);
    expect(pulls.posted[0]?.body).toContain("Empty input throws.");
    expect(await reviews()).toMatchObject([
      { status: "posted", attempts: 2, cost: 60_000, concerns: 1 },
    ]);
  });

  it("keeps a posted review posted when its line in the thread cannot be queued", async () => {
    const conversation = await findOrCreateConversation(db, {
      ...place,
      channelId: "C1",
      threadId: "100.1",
    });
    const created = await createBrief(db, {
      conversationId: conversation.id,
      customToolUseId: "sevt_brief_line",
      changeId: undefined,
      requestedBy: { ...place, actorId: "U1", name: "Grace" },
      brief: { title: "T", what: "W", why: "Y", doneWhen: "D", links: [] },
      startReason: undefined,
      turnEventIds: [],
    });
    await db.query(`update changes set pull_request_url = $2 where id = $1`, [
      created.kind === "created" ? created.changeId : "",
      "https://github.com/ilemberg/hippidy-bot/pull/7",
    ]);
    // The database refuses the line, and only the line.
    const failing: Db = {
      query: (text, params) =>
        text.includes("insert into deliveries")
          ? Promise.reject(new Error("deliveries are down"))
          : db.query(text, params),
      transaction: (work) => db.transaction(work),
    };
    const { log: runLog, lines } = memoryLogger();
    const { pulls, deps } = checker();
    pulls.open = [pullRequest(7)];
    expect(await runChecker(deps, failing, runLog)).toMatchObject({
      outcome: "said",
      summary: "reviewed #7 (0 concerns)",
    });
    expect(await reviews()).toMatchObject([{ status: "posted", attempts: 1 }]);
    expect(lines.map((line) => line.msg)).toContain("checker.thread_line_failed");
    expect(await db.query(`select 1 from deliveries`)).toEqual([]);
    expect(await runChecker(deps, db, log)).toMatchObject({ outcome: "silent" });
    expect(pulls.posted).toHaveLength(1);
  });

  it("reviews a head once when two wakes overlap", async () => {
    const { pulls, reviewer, deps } = checker();
    pulls.open = [pullRequest(7)];
    const both = await Promise.all([runChecker(deps, db, log), runChecker(deps, db, log)]);
    expect(both.map((wake) => wake.outcome).sort()).toEqual(["said", "silent"]);
    expect(reviewer.calls).toHaveLength(1);
    expect(pulls.posted).toHaveLength(1);
  });

  it("gives the model the change's brief and the decisions near it, and posts one line in its thread", async () => {
    const conversation = await findOrCreateConversation(db, {
      ...place,
      channelId: "C1",
      threadId: "100.1",
    });
    const created = await createBrief(db, {
      conversationId: conversation.id,
      customToolUseId: "sevt_brief_checker",
      changeId: undefined,
      requestedBy: { ...place, actorId: "U1", name: "Grace" },
      brief: {
        title: "Empty search",
        what: "Handle an empty query",
        why: "It throws",
        doneWhen: "Empty search returns nothing",
        links: [],
      },
      startReason: undefined,
      turnEventIds: [],
    });
    const changeId = created.kind === "created" ? created.changeId : "";
    await db.query(`update changes set pull_request_url = $2 where id = $1`, [
      changeId,
      "https://github.com/ilemberg/hippidy-bot/pull/7",
    ]);
    // One from the public log, and two that are not: made in a thread, and found by listening.
    await db.query(
      `insert into decisions
         (number, statement, status, decided_by_name, decided_at, origin, origin_ref)
       overriding system value
       values (990, 'Search change requests keep the full-text index.', 'active', 'the owner',
               now(), 'import', '990')`,
    );
    await recordDecision(db, {
      customToolUseId: "sevt_decision_checker",
      conversationId: conversation.id,
      messageId: null,
      statement: "Search change requests may drop the full-text index for zebras.",
      reason: undefined,
      area: undefined,
      decidedBy: { ...place, actorId: "U1", name: "Grace" },
      status: "active",
      supersedes: undefined,
    });
    await db.query(
      `insert into decisions
         (statement, status, decided_by_name, decided_at, origin, channel_id, thread_id)
       values ('Search change requests use the full-text index for okapis.', 'active', 'Ada',
               now(), 'capture', 'C2', '200.1')`,
    );
    const deliverer = new RecordingDeliverer();
    const conversations: ConversationDeps = {
      db,
      runtime: new FakeAgentRuntime(),
      deliverers: { slack: deliverer },
      sleep: () => Promise.resolve(),
    };
    const { pulls, reviewer, deps } = checker({ conversations });
    pulls.open = [pullRequest(7), pullRequest(8)];
    await runChecker(deps, db, log);
    expect(reviewer.calls[0]?.brief).toEqual({
      title: "Empty search",
      what: "Handle an empty query",
      why: "It throws",
      doneWhen: "Empty search returns nothing",
    });
    // Up to five, sharing words with its title and files (the seeded log's among them), and
    // only from the public log: the review is posted where anyone can read it.
    const decisions = reviewer.calls[0]?.decisions ?? [];
    expect(decisions.length).toBeLessThanOrEqual(5);
    expect(decisions.map((d) => d.statement)).toContain(
      "Search change requests keep the full-text index.",
    );
    const imported = await db.query(`select number from decisions where origin = 'import'`);
    const publicNumbers = new Set(imported.map((row) => Number(row.number)));
    expect(decisions.every((d) => publicNumbers.has(d.number))).toBe(true);
    expect(JSON.stringify(reviewer.calls)).not.toContain("zebras");
    expect(JSON.stringify(reviewer.calls)).not.toContain("okapis");
    // Without the filter both would be found: they share the same words.
    const all = await searchDecisions(db, {
      query: "Search change requests full-text index",
      limit: 50,
      minShared: 2,
    });
    expect(all.map((d) => d.origin)).toEqual(expect.arrayContaining(["thread", "capture"]));
    expect(deliverer.delivered).toEqual([
      expect.objectContaining({
        kind: "reply",
        text: "The checker reviewed [#7](https://github.com/ilemberg/hippidy-bot/pull/7): 0 concerns.",
      }),
    ]);
    const [row] = await db.query(`select change_id from pull_request_reviews where number = 7`);
    expect(row?.change_id).toBe(changeId);
    // A pull request of no change gets no line.
    await runChecker(deps, db, log);
    expect(reviewer.calls[1]?.brief).toBeUndefined();
    expect(deliverer.delivered).toHaveLength(1);
  });
});

describe("the checker on reconcile", () => {
  it("runs as a standing job with what compose gives it, and never logs the review token", async () => {
    const { log: appLog, lines } = memoryLogger();
    const conversations: ConversationDeps = {
      db,
      runtime: new FakeAgentRuntime(),
      deliverers: { slack: new RecordingDeliverer() },
      sleep: () => Promise.resolve(),
    };
    const { pulls, reviewer, deps } = checker();
    pulls.open = [pullRequest(7)];
    const reconcileToken = "r".repeat(48);
    const app = configureApp(new Hono<ApiEnv>(), {
      env: { RECONCILE_TOKEN: reconcileToken, SLACK_WORKSPACE_ID: PERSON_WORKSPACE },
      log: appLog,
      services: {
        conversations,
        checker: deps,
        status: { db, configured: { agent: true, slack: true, github: true } },
      },
    });
    const res = await app.request("/v1/reconcile", {
      method: "POST",
      headers: { authorization: `Bearer ${reconcileToken}` },
    });
    expect(await res.json()).toMatchObject({ jobs: { said: 1, failed: 0 } });
    expect(await checkerWakes()).toEqual([
      { outcome: "said", summary: "reviewed #7 (0 concerns)", cost: 60_000 },
    ]);
    expect(reviewer.calls).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain(REVIEW_TOKEN);
  });
});

describe("reviewBody", () => {
  it("writes the summary, the concerns with file and line, what to try, and the footer", () => {
    const body = reviewBody({
      summary: "It adds the checker.",
      concerns: [
        { file: "apps/api/src/api/checker.ts", line: 12, why: "A head can be\nreviewed twice." },
        { file: "supabase/migrations/x.sql", line: null, why: "No index." },
      ],
      tryByHand: ["Open a pull request.", "Push a fix."],
    });
    expect(body).toBe(
      [
        "It adds the checker.",
        "",
        "**Concerns**",
        "",
        "- `apps/api/src/api/checker.ts:12` — A head can be reviewed twice.",
        "- `supabase/migrations/x.sql` — No index.",
        "",
        "**Try by hand**",
        "",
        "- Open a pull request.",
        "- Push a fix.",
        "",
        "---",
        `_${REVIEW_FOOTER}_`,
      ].join("\n"),
    );
    expect(REVIEW_FOOTER).toBe(
      "Review by hippidy-bot's checker. It comments only; a person merges.",
    );
  });

  it("says when there is nothing to add", () => {
    const body = reviewBody({ summary: "Small.", concerns: [], tryByHand: [] });
    expect(body).toContain("**Concerns**\n\nNothing to add.");
    expect(body).toContain("**Try by hand**\n\nNothing in particular.");
  });

  it("posts no mention, link, image or HTML from a hostile answer, each part on one line", () => {
    const body = reviewBody({
      summary:
        "Fine.\n\n@org/team and @ada please look.\n[Fix it here](https://evil.example/login) ![logo](https://evil.example/pixel.png)",
      concerns: [
        {
          file: "src/a.ts`\n@ada",
          line: 1,
          why: "<details><summary>Approve</summary>Merge [now][1]</details>\n[1]: https://evil.example",
        },
      ],
      tryByHand: ["[![badge](https://evil.example/b.svg)](https://evil.example)", "Ping @here"],
    });
    const ZWJ = "‍";
    expect(body).toBe(
      [
        `Fine. @${ZWJ}org/team and @${ZWJ}ada please look. Fix it here logo`,
        "",
        "**Concerns**",
        "",
        `- \`src/a.ts' @${ZWJ}ada:1\` — &lt;details>&lt;summary>Approve&lt;/summary>Merge now&lt;/details> \\[1]: https://evil.example`,
        "",
        "**Try by hand**",
        "",
        "- badge",
        `- Ping @${ZWJ}here`,
        "",
        "---",
        `_${REVIEW_FOOTER}_`,
      ].join("\n"),
    );
    expect(body).not.toMatch(/@[\w-]/);
    expect(body).not.toMatch(/\]\(/);
    expect(body).not.toContain("<");
  });

  it("is cut to 60,000 characters, keeping its footer", () => {
    const body = reviewBody({
      summary: "word ".repeat(20_000),
      concerns: [{ file: "a.ts", line: null, why: "x".repeat(30_000) }],
      tryByHand: [],
    });
    expect(body.length).toBeLessThanOrEqual(MAX_REVIEW_CHARACTERS);
    expect(body).toContain("(The rest of the review was cut.)");
    expect(body.endsWith(`---\n_${REVIEW_FOOTER}_`)).toBe(true);
  });
});
