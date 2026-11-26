import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureApp } from "../compose.ts";
import type { ApiEnv } from "./types.ts";
import { FakeAgentRuntime } from "../agent/fake.ts";
import { FakeReviewer } from "../agent/reviewer.ts";
import type { OpenPullRequest, PullRequestDiff, PullRequests } from "../github/pulls.ts";
import { createBrief } from "../store/changes.ts";
import { findOrCreateConversation } from "../store/conversations.ts";
import { recordDecision } from "../store/decisions.ts";
import { createTestDb } from "../store/testing.ts";
import { memoryLogger } from "../testing.ts";
import { REVIEW_FOOTER, concernsIn, runChecker, reviewBody, type CheckerDeps } from "./checker.ts";
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
  posted: { number: number; commitId: string; body: string; token: string }[] = [];
  /** Number of upcoming posts that fail. */
  failPosts = 0;

  listOpen(): Promise<OpenPullRequest[]> {
    return Promise.resolve(this.open.map((pull) => ({ ...pull })));
  }

  diff(number: number): Promise<PullRequestDiff> {
    return Promise.resolve(
      this.diffs[number] ?? {
        text: "diff --git a/apps/api/src/search.ts b/apps/api/src/search.ts\n+x\n",
        files: ["apps/api/src/search.ts"],
        omitted: [],
      },
    );
  }

  postReview(
    number: number,
    review: { commitId: string; body: string },
    token: string,
  ): Promise<{ url: string }> {
    if (this.failPosts > 0) {
      this.failPosts--;
      return Promise.reject(new Error(`GitHub answered 502 for POST /pulls/${String(number)}`));
    }
    this.posted.push({ number, ...review, token });
    return Promise.resolve({
      url: `https://github.com/ilemberg/hippidy-bot/pull/${String(number)}#pullrequestreview-${String(this.posted.length)}`,
    });
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
    `select number, head_sha, status, attempts, cost_micros::float8 as cost, review_url, error
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
        review_url: "https://github.com/ilemberg/hippidy-bot/pull/7#pullrequestreview-1",
        error: null,
      },
    ]);
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

  it("keeps a refusal or a cut-off as a failed try, silent on the wake, with its cost", async () => {
    const { pulls, reviewer, deps } = checker();
    pulls.open = [pullRequest(7)];
    reviewer.answer({ kind: "refused", usage: { inputTokens: 1_000, outputTokens: 0 } });
    expect(await runChecker(deps, db, log)).toEqual({
      outcome: "silent",
      summary: "#7: the model declined to review it",
      costMicros: 4_000,
    });
    reviewer.answer({ kind: "cut_off", usage: { inputTokens: 1_000, outputTokens: 16_000 } });
    expect(await runChecker(deps, db, log)).toMatchObject({
      outcome: "silent",
      summary: "#7: the review was cut off",
    });
    expect(await reviews()).toMatchObject([{ status: "failed", attempts: 2, cost: 328_000 }]);
    expect(pulls.posted).toHaveLength(0);
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
    await recordDecision(db, {
      customToolUseId: "sevt_decision_checker",
      conversationId: conversation.id,
      messageId: null,
      statement: "Search change requests keep the full-text index.",
      reason: undefined,
      area: undefined,
      decidedBy: { ...place, actorId: "U1", name: "Grace" },
      status: "active",
      supersedes: undefined,
    });
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
    // Up to five, sharing words with its title and files (the seeded log's among them).
    const decisions = reviewer.calls[0]?.decisions ?? [];
    expect(decisions.length).toBeLessThanOrEqual(5);
    expect(decisions.map((d) => d.statement)).toContain(
      "Search change requests keep the full-text index.",
    );
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
    expect(concernsIn(body)).toBe(2);
  });

  it("says when there is nothing to add", () => {
    const body = reviewBody({ summary: "Small.", concerns: [], tryByHand: [] });
    expect(body).toContain("**Concerns**\n\nNothing to add.");
    expect(body).toContain("**Try by hand**\n\nNothing in particular.");
    expect(concernsIn(body)).toBe(0);
  });
});
