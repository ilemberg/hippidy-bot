import type { Decision } from "@hippidy/contracts";
import {
  reviewCostMicros,
  type PullRequestReviewer,
  type Review,
  type ReviewResult,
} from "../agent/reviewer.ts";
import type { OpenPullRequest, PullRequests } from "../github/pulls.ts";
import type { Logger } from "../log.ts";
import { enqueueDelivery, getConversation } from "../store/conversations.ts";
import type { Db } from "../store/db.ts";
import { searchDecisions } from "../store/decisions.ts";
import {
  changeOfPullRequest,
  claimReview,
  markReviewFailed,
  markReviewPosted,
  settledHeads,
  type ChangeOfPullRequest,
  type ReviewClaim,
} from "../store/reviews.ts";
import { flushSoon, targetOf, type ConversationDeps } from "./conversations.ts";
import type { WakeResult } from "./jobs.ts";

// The checker (slice 4.3, decision 219), a built-in job: each wake lists the repository's open
// pull requests (G15), takes the newest head commit not yet reviewed, writes a review with one
// model call and posts it as a comment (G20). It never approves; only a person merges (rule 18).

/** What the checker needs; with any part missing it wakes silent and says which. */
export interface CheckerDeps {
  /** The repository's pull requests, read with the token that reads CI checks (decision 132). */
  pulls: PullRequests | undefined;
  /** `GITHUB_REVIEW_TOKEN`: it can only comment on pull requests. */
  reviewToken: string | undefined;
  reviewer: PullRequestReviewer | undefined;
  /** To post the line in a change's thread now; without it, a later flush posts it. */
  conversations?: ConversationDeps | undefined;
}

/** What compose builds for the checker; reconcile adds the conversations. */
export type CheckerServices = Omit<CheckerDeps, "conversations">;

/** Most decisions put before the model with a pull request. */
export const DECISIONS_PER_REVIEW = 5;

export const REVIEW_FOOTER = "Review by hippidy-bot's checker. It comments only; a person merges.";

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
}

/** Strips line breaks from text that must stay on one Markdown line. */
function flat(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/** The review as the Markdown body of a GitHub comment review. */
export function reviewBody(review: Review): string {
  const parts = [review.summary.trim()];
  parts.push("", "**Concerns**", "");
  if (review.concerns.length === 0) parts.push("Nothing to add.");
  else {
    for (const concern of review.concerns) {
      const where =
        concern.line === null ? concern.file : `${concern.file}:${String(concern.line)}`;
      parts.push(`- \`${flat(where).replaceAll("`", "'")}\` — ${flat(concern.why)}`);
    }
  }
  parts.push("", "**Try by hand**", "");
  if (review.tryByHand.length === 0) parts.push("Nothing in particular.");
  else parts.push(...review.tryByHand.map((step) => `- ${flat(step)}`));
  parts.push("", "---", `_${REVIEW_FOOTER}_`);
  return parts.join("\n");
}

/** Words to find decisions near a pull request: its title and its files' names. */
export function decisionQuery(title: string, files: readonly string[]): string {
  const names = files.flatMap((file) => file.split(/[/._-]+/)).filter((word) => word.length >= 3);
  return [title, ...new Set(names)].join(" ").slice(0, 2000);
}

/** Why a model call gave no review, in a few words. */
function noReview(result: ReviewResult): string {
  if (result.kind === "refused") return "the model declined to review it";
  if (result.kind === "cut_off") return "the review was cut off";
  // Read by shape: Vercel's check, without strict null checks, does not narrow this union.
  return `the model call failed: ${"error" in result ? result.error : "no answer"}`;
}

/** One wake of the checker. Throws only for what makes the wake a failure. */
export async function runChecker(
  deps: CheckerDeps | undefined,
  db: Db,
  log: Logger,
): Promise<WakeResult> {
  const pulls = deps?.pulls;
  if (pulls === undefined) {
    return { outcome: "silent", summary: "GitHub is not configured", costMicros: 0 };
  }
  if (deps?.reviewToken === undefined) {
    return { outcome: "silent", summary: "no review token", costMicros: 0 };
  }
  if (deps.reviewer === undefined) {
    return { outcome: "silent", summary: "the agent is not configured", costMicros: 0 };
  }
  const open = await pulls.listOpen();
  // Forks' text is anyone's on GitHub, and drafts are not ready (slice 4.3).
  const candidates = open.filter((pull) => !pull.draft && !pull.fromFork);
  if (candidates.length === 0) {
    return { outcome: "silent", summary: "no open pull request to review", costMicros: 0 };
  }
  const settled = await settledHeads(
    db,
    candidates.map((pull) => ({
      repository: pulls.repository,
      number: pull.number,
      headSha: pull.headSha,
    })),
  );
  // The newest change first (GitHub lists them so); one review per wake.
  for (const pull of candidates) {
    if (settled.has(`${String(pull.number)}@${pull.headSha}`)) continue;
    const change = await changeOfPullRequest(db, pull.url);
    const claim = await claimReview(db, {
      repository: pulls.repository,
      number: pull.number,
      headSha: pull.headSha,
      changeId: change?.changeId ?? null,
    });
    // Another wake took it, or it has no tries left.
    if (claim === undefined) continue;
    const ready: ReadyDeps = {
      pulls,
      reviewToken: deps.reviewToken,
      reviewer: deps.reviewer,
      conversations: deps.conversations,
    };
    return review(ready, db, {
      pull,
      change,
      claim,
      log: log.child({ pullRequest: pull.number, attempt: claim.attempts }),
    });
  }
  return { outcome: "silent", summary: "no new pull request to review", costMicros: 0 };
}

/** The checker's needs, all there. */
interface ReadyDeps {
  pulls: PullRequests;
  reviewToken: string;
  reviewer: PullRequestReviewer;
  conversations?: ConversationDeps | undefined;
}

/** The number of concerns in a review body `reviewBody` wrote. */
export function concernsIn(body: string): number {
  const start = body.indexOf("**Concerns**");
  const end = body.indexOf("**Try by hand**");
  if (start === -1 || end === -1) return 0;
  return body
    .slice(start, end)
    .split("\n")
    .filter((line) => line.startsWith("- ")).length;
}

/** Writes the review with one model call: its body, or the wake that ends without one. */
async function write(
  deps: ReadyDeps,
  db: Db,
  input: { pull: OpenPullRequest; change: ChangeOfPullRequest | undefined; log: Logger },
): Promise<{ kind: "written"; body: string; costMicros: number } | ReviewResult> {
  const { pull, change, log } = input;
  const diff = await deps.pulls.diff(pull.number);
  const decisions = await searchDecisions(db, {
    query: decisionQuery(pull.title, diff.files),
    limit: DECISIONS_PER_REVIEW,
    minShared: 2,
  }).catch((error: unknown): Decision[] => {
    log.warn("checker.decisions_failed", { error });
    return [];
  });
  const result = await deps.reviewer.review({
    repository: deps.pulls.repository,
    number: pull.number,
    title: pull.title,
    description: pull.body,
    diff: { text: diff.text, omitted: diff.omitted },
    brief: change?.brief,
    decisions: decisions.map((d) => ({ number: d.number, statement: d.statement })),
  });
  if (result.kind !== "ok") return result;
  return {
    kind: "written",
    body: reviewBody(result.review),
    costMicros: reviewCostMicros(result.usage),
  };
}

async function review(
  deps: ReadyDeps,
  db: Db,
  input: {
    pull: OpenPullRequest;
    change: ChangeOfPullRequest | undefined;
    claim: ReviewClaim;
    log: Logger;
  },
): Promise<WakeResult> {
  const { pull, change, claim, log } = input;
  const name = `#${String(pull.number)}`;
  let cost = 0;
  try {
    // A review an earlier try wrote but could not post is posted again, not paid for again.
    let body = claim.body;
    if (body === null) {
      const written = await write(deps, db, { pull, change, log });
      cost = written.kind === "written" ? written.costMicros : reviewCostMicros(written.usage);
      if (written.kind !== "written") {
        const why = noReview(written);
        const status = await markReviewFailed(db, claim.id, { error: why, costMicros: cost });
        log.warn("checker.no_review", { kind: written.kind, status });
        if (written.kind === "failed") {
          return {
            outcome: "failed",
            summary: `could not review ${name}`,
            costMicros: cost,
            error: why,
          };
        }
        // A refusal or a cut-off is the model's answer, not a fault: silent, saying why.
        return { outcome: "silent", summary: `${name}: ${why}`, costMicros: cost };
      }
      body = written.body;
    }
    let posted: { url: string };
    try {
      posted = await deps.pulls.postReview(
        pull.number,
        { commitId: pull.headSha, body },
        deps.reviewToken,
      );
    } catch (error) {
      const why = `could not post the review: ${error instanceof Error ? error.message : String(error)}`;
      const status = await markReviewFailed(db, claim.id, { error: why, costMicros: cost, body });
      log.warn("checker.post_failed", { status, error });
      return {
        outcome: "failed",
        summary: `could not post the review of ${name}`,
        costMicros: cost,
        error: why,
      };
    }
    const concerns = concernsIn(body);
    const posting = { url: posted.url, body, costMicros: cost };
    // Marked posted and the thread's line queued together, keyed so it posts once.
    await db.transaction(async (tx) => {
      await markReviewPosted(tx, claim.id, posting);
      if (change === undefined) return;
      const conversation = await getConversation(tx, change.conversationId);
      await enqueueDelivery(tx, conversation.id, `checker:${claim.id}`, "note", {
        kind: "reply",
        target: targetOf(conversation),
        text: `The checker reviewed [${name}](${pull.url}): ${plural(concerns, "concern")}.`,
        mentions: [],
      });
    });
    log.info("checker.reviewed", { concerns, costMicros: cost });
    if (change !== undefined && deps.conversations !== undefined) {
      await flushSoon(deps.conversations, change.conversationId, log).catch((error: unknown) => {
        log.warn("checker.flush_failed", { error });
      });
    }
    return {
      outcome: "said",
      summary: `reviewed ${name} (${plural(concerns, "concern")})`,
      costMicros: cost,
    };
  } catch (error) {
    // Anything else (the diff, the database): this try failed, and is counted.
    const why = error instanceof Error ? error.message : String(error);
    await markReviewFailed(db, claim.id, { error: why, costMicros: cost }).catch(
      (markError: unknown) => {
        log.error("checker.mark_failed", { error: markError });
      },
    );
    return { outcome: "failed", summary: `could not review ${name}`, costMicros: cost, error: why };
  }
}
