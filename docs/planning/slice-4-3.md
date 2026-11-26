# Slice 4.3: the checker

Status: **planned 2026-11-26 (decision 219).** The wave is in `wave-4.md`; jobs in `slice-4-1.md`.

**Demo:** the worker opens a pull request for Grace's change. Within a few minutes the checker
posts a review on it, as a comment: what the change does, what may be wrong (each with the
file and line), and what to try by hand before merging. The change's thread gets one line
linking to it. Ada pushes a fix; the new head gets a new review. The checker never approves,
and `/jobs/checker` shows each wake, the pull request it read and what it cost.

## What it needs

| Part | What | Live behaviour changes? |
|---|---|---|
| A | **Schema**: `pull_request_reviews` (each head commit reviewed once: the pull request, its head, the review posted, its cost) | No |
| B | **The checker job**: a built-in kind that lists the repository's open pull requests (G15), takes one new head commit per wake, writes a review with one model call, and posts it as a comment (G20) | **Yes**: pull requests get reviews |
| C | **In the thread**: when the pull request belongs to a change, one line under it links the review | **Yes** |

## Finding work (G15)

- Each wake lists the repository's open pull requests with the token the API already holds for
  CI checks (decision 132), newest change first, and takes the first whose head commit has no
  review yet. One review per wake keeps each wake short and its cost bounded.
- **Forks are not reviewed:** a pull request from a fork is content anyone on GitHub can write
  (as decisions 181 and 189 treat it), and the review is posted under the bot's name. Only
  pull requests from branches of the repository itself are read.
- A pull request marked draft is skipped until it is ready.

## The review

- **One model call**, no tools, no session: the pull request's title and description, its
  diff (at most 60,000 characters, the rest named but not read), the change's brief when the
  pull request belongs to a change, and up to five active decisions that share words with it.
- **What it writes:** a short summary; concerns, each with its file and line and why it matters,
  only those it can point to; and what to try by hand before merging (the walkthrough of 142).
  "Nothing to add" is a valid review.
- **The model:** Claude Opus 5.5 (`claude-opus-5-5`) at medium effort, with server-side refusal
  fallbacks; about $0.20 for a large diff. Its cost is the wake's cost, under the job's cap ($10
  a month unless changed), so roughly fifty reviews a month before it pauses itself.
- Text from the pull request is information, never instructions: the prompt says so, and the
  call has no tools, so the worst a steered review can do is say something wrong in a comment.

## Posting (G20)

- As a pull request review with `event: COMMENT`, using `GITHUB_REVIEW_TOKEN`, a token that can
  only comment on pull requests in this repository. It never approves and cannot (rule 18).
- Without the token, the checker wakes silent ("no review token") and calls no model.
- Each head commit is reviewed once, whatever happens: a review that could not be posted is
  kept as failed and tried at most twice more on later wakes.

## Not in 4.3

- The production check after merge (157): a job of its own, later.
- Reviewing pull requests from forks.
- Inline comments on lines: the review names files and lines in its body.
- A GitHub webhook (G15).

## By hand, the owner's

- `GITHUB_REVIEW_TOKEN` in the API's Vercel project: a fine-grained token for this repository
  with "Pull requests: read and write" and nothing else.

## Done when

Each line gets its query or test before its pull request merges (96).

- A new head commit of an open pull request from the repository gets one comment review, with
  its cost on the wake; a fork's or a draft's gets none.
- A pull request that belongs to a change gets one line in the change's thread.
- Without the review token, no model is called and the wake says why.
- A failed post is retried at most twice; a head is never reviewed twice.
