import type { Decision } from "@hippidy/contracts";
import {
  reviewCostMicros,
  type PullRequestReviewer,
  type Review,
  type ReviewResult,
} from "../agent/reviewer.ts";
import { DiffTooLargeError, type OpenPullRequest, type PullRequests } from "../github/pulls.ts";
import type { Logger } from "../log.ts";
import { enqueueDelivery, getConversation } from "../store/conversations.ts";
import type { Db } from "../store/db.ts";
import { searchDecisions } from "../store/decisions.ts";
import {
  abandonReview,
  changeOfPullRequest,
  claimReview,
  markReviewFailed,
  markReviewPosted,
  saveWrittenReview,
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

/** Most characters of a posted review, its footer included. */
export const MAX_REVIEW_CHARACTERS = 60_000;

/** Why a head GitHub sends no diff for is given up. */
const TOO_LARGE = "too large to review";

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
}

/** Strips line breaks from text that must stay on one Markdown line. */
function flat(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/** Put after `@`, a zero-width joiner keeps GitHub from reading a mention. */
const ZERO_WIDTH_JOINER = "‍";

/** `[text](url)`, `![alt](url)` and `[text][ref]`, innermost first. */
const LINK = /!?\[([^[\]]*)\](?:\([^()]*\)|\[[^[\]]*\])/g;

/**
 * Model text made safe for one line of a public comment: no mention reaches a person or team,
 * no link or image is shown, no HTML is read. What is left of `[` is escaped, so no reference
 * definition can make a link either.
 */
export function safeText(text: string): string {
  let out = flat(text);
  for (let before = ""; before !== out;) {
    before = out;
    out = out.replace(LINK, "$1");
  }
  return out
    .replaceAll("<", "&lt;")
    .replaceAll("[", "\\[")
    .replaceAll("@", `@${ZERO_WIDTH_JOINER}`);
}

/** Model text inside a code span, where Markdown reads no link, HTML or mention. */
function codeText(text: string): string {
  return flat(text).replaceAll("`", "'").replaceAll("@", `@${ZERO_WIDTH_JOINER}`);
}

/** The review as the Markdown body of a GitHub comment review, at most 60,000 characters. */
export function reviewBody(review: Review): string {
  const parts = [safeText(review.summary)];
  parts.push("", "**Concerns**", "");
  if (review.concerns.length === 0) parts.push("Nothing to add.");
  else {
    for (const concern of review.concerns) {
      const where =
        concern.line === null ? concern.file : `${concern.file}:${String(concern.line)}`;
      parts.push(`- \`${codeText(where)}\` — ${safeText(concern.why)}`);
    }
  }
  parts.push("", "**Try by hand**", "");
  if (review.tryByHand.length === 0) parts.push("Nothing in particular.");
  else parts.push(...review.tryByHand.map((step) => `- ${safeText(step)}`));
  // The footer is always kept: a later try finds the review on GitHub by it.
  const footer = `\n\n---\n_${REVIEW_FOOTER}_`;
  let content = parts.join("\n");
  if (content.length + footer.length > MAX_REVIEW_CHARACTERS) {
    const cut = "\n\n(The rest of the review was cut.)";
    content = content.slice(0, MAX_REVIEW_CHARACTERS - footer.length - cut.length);
    // Never half a character.
    if (/[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1);
    content += cut;
  }
  return content + footer;
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

/** Writes the review with one model call: its body, or the wake that ends without one. */
async function write(
  deps: ReadyDeps,
  db: Db,
  input: { pull: OpenPullRequest; change: ChangeOfPullRequest | undefined; log: Logger },
): Promise<{ kind: "written"; body: string; concerns: number; costMicros: number } | ReviewResult> {
  const { pull, change, log } = input;
  const diff = await deps.pulls.diff(pull.number);
  // Only the public planning log (`docs/planning/decisions.md`): the review is posted on
  // GitHub, so a decision made in a thread or found by listening never goes into it.
  const decisions = await searchDecisions(db, {
    query: decisionQuery(pull.title, diff.files),
    origin: "import",
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
    concerns: result.review.concerns.length,
    costMicros: reviewCostMicros(result.usage),
  };
}

/** The link of this checker's review already on the head commit, if an earlier try posted it. */
async function postedEarlier(pulls: PullRequests, pull: OpenPullRequest) {
  const reviews = await pulls.listReviews(pull.number);
  return reviews.find(
    (posted) => posted.commitId === pull.headSha && posted.body.includes(REVIEW_FOOTER),
  )?.url;
}

/** Queues the change thread's one line about the review, keyed so it posts once. */
async function queueThreadLine(
  db: Db,
  input: { change: ChangeOfPullRequest; claimId: string; text: string },
): Promise<void> {
  const conversation = await getConversation(db, input.change.conversationId);
  await enqueueDelivery(db, conversation.id, `checker:${input.claimId}`, "note", {
    kind: "reply",
    target: targetOf(conversation),
    text: input.text,
    mentions: [],
  });
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
  // What this wake spent, and the part of it not yet on the review's row.
  let cost = 0;
  let unsaved = 0;
  try {
    // A review an earlier try wrote is posted, never written or paid for again.
    let body = claim.body;
    let concerns = claim.concerns ?? 0;
    if (body === null) {
      const written = await write(deps, db, { pull, change, log });
      cost = written.kind === "written" ? written.costMicros : reviewCostMicros(written.usage);
      unsaved = cost;
      if (written.kind === "failed") {
        const why = noReview(written);
        const status = await markReviewFailed(db, claim.id, { error: why, costMicros: cost });
        unsaved = 0;
        log.warn("checker.no_review", { kind: written.kind, status });
        return {
          outcome: "failed",
          summary: `could not review ${name}`,
          costMicros: cost,
          error: why,
        };
      }
      if (written.kind !== "written") {
        // A refusal or a cut-off is the model's answer, not a fault, and another try would
        // meet it again: given up at once, silent, saying why.
        const why = noReview(written);
        await abandonReview(db, claim.id, { error: why, costMicros: cost });
        unsaved = 0;
        log.warn("checker.no_review", { kind: written.kind, status: "abandoned" });
        return { outcome: "silent", summary: `${name}: ${why}`, costMicros: cost };
      }
      // Saved on its own before posting, so a try that dies after the call never pays again.
      await saveWrittenReview(db, claim.id, {
        body: written.body,
        concerns: written.concerns,
        costMicros: cost,
      });
      unsaved = 0;
      body = written.body;
      concerns = written.concerns;
    }
    let url: string;
    try {
      // An earlier try may have died, or timed out, after GitHub took its review.
      const earlier = claim.body === null ? undefined : await postedEarlier(deps.pulls, pull);
      url =
        earlier ??
        (
          await deps.pulls.postReview(
            pull.number,
            { commitId: pull.headSha, body },
            deps.reviewToken,
          )
        ).url;
    } catch (error) {
      const why = `could not post the review: ${error instanceof Error ? error.message : String(error)}`;
      const status = await markReviewFailed(db, claim.id, { error: why, costMicros: 0 });
      log.warn("checker.post_failed", { status, error });
      return {
        outcome: "failed",
        summary: `could not post the review of ${name}`,
        costMicros: cost,
        error: why,
      };
    }
    await markReviewPosted(db, claim.id, url);
    log.info("checker.reviewed", { concerns, costMicros: cost });
    if (change !== undefined) {
      // After the review is marked posted, and never turning it into a failed one; the key
      // keeps the line to one.
      const queued = await queueThreadLine(db, {
        change,
        claimId: claim.id,
        text: `The checker reviewed [${name}](${pull.url}): ${plural(concerns, "concern")}.`,
      }).then(
        () => true,
        (error: unknown) => {
          log.warn("checker.thread_line_failed", { error });
          return false;
        },
      );
      if (queued && deps.conversations !== undefined) {
        await flushSoon(deps.conversations, change.conversationId, log).catch((error: unknown) => {
          log.warn("checker.flush_failed", { error });
        });
      }
    }
    return {
      outcome: "said",
      summary: `reviewed ${name} (${plural(concerns, "concern")})`,
      costMicros: cost,
    };
  } catch (error) {
    if (error instanceof DiffTooLargeError) {
      // GitHub will not send it on a later try either: given up at once, silent.
      await abandonReview(db, claim.id, { error: TOO_LARGE, costMicros: 0 });
      log.warn("checker.too_large");
      return { outcome: "silent", summary: `${name}: ${TOO_LARGE}`, costMicros: 0 };
    }
    // Anything else (the diff, the database): this try failed, and is counted.
    const why = error instanceof Error ? error.message : String(error);
    await markReviewFailed(db, claim.id, { error: why, costMicros: unsaved }).catch(
      (markError: unknown) => {
        log.error("checker.mark_failed", { error: markError });
      },
    );
    return { outcome: "failed", summary: `could not review ${name}`, costMicros: cost, error: why };
  }
}
