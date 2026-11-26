# Wave 4: standing jobs

Status: **planned 2026-11-26 (decisions 214 and 215).** Wave 3 is in `wave-3.md`; the idea in
`team-layer.md`, "Standing responsibilities". G15, G16 and the new G20 and G21 are answered
(214).

**Goal:** the bot holds responsibilities, not only requests. A request ends when it is done; a
responsibility stays open: keep the memory true, review every pull request, carry a feature
until it ships.

## Where wave 3 ended

- Areas have owners; briefs, pull requests and decisions that touch an area name its owner, and
  replacing someone else's decision waits for them (3.1, 3.2).
- Tasks come from Jira or the built-in tracker; who waits on whom is recorded (3.3).
- Each person gets at most one brief a day by direct message (3.4).
- Two jobs already run on their own from reconcile, capture (2.5) and briefs (3.4), but nobody
  can see their wakes, pause them or cap them; each was wired in by hand.

## Rules that hold in wave 4

The rules of waves 1 to 3 stay. Added:

14. **Persistent means the records, not the session.** Each wake is short: it reads the job's
    notes and the records, acts, writes its notes back and ends. No session is kept open
    between wakes.
15. **Silence is a result.** Most wakes say nothing. Every wake is logged, with what it did,
    what it cost and why it said nothing, so silence can be checked.
16. **People own the goal (G16).** A job never changes its own goal, scope, schedule or cap. A
    person changes them in the web app, and each change is kept with who and when. A job may
    suggest a change in its notes.
17. **Every job has a cap (G21).** A monthly cap in dollars, set when it is made ($10 unless
    said otherwise); a job that reaches it pauses itself until the month turns or a person
    raises it. All jobs together stay inside the $100 a month of decision 11.
18. **Only a person merges** (decision 117, restated): the checker comments; it never approves.
    GitHub has no comment-only permission, so what stops an approval is that the code only ever
    sends a comment (220), as 117 found for merging.

## Slices

| # | Slice | Demo | Needs |
|---|---|---|---|
| 4.1 | The job record and its scheduler | Capture and briefs run as jobs: each wake is logged with its cost, a silent wake included; pausing one stops it | `jobs`, `job_wakes`, `job_events`; reconcile asks which jobs are due; capture and briefs become the first two kinds |
| 4.2 | Job management page | A person pauses a job, raises its cap, and reads its wakes | `/jobs` and `/jobs/<name>` in the web app; the jobs routes |
| 4.3 | The checker | Every pull request gets a review its author did not write, posted as a comment, with the walkthrough and the production check | Open pull requests read on reconcile (G15); a review session per new head; a comment-only GitHub token (G20) |
| 4.4 | A feature goal | The bot carries a feature across its tickets, and stops at the limit on pull requests waiting for review | A goal job that reads its tickets, starts changes through briefs, and waits on review |
| 4.5 | Dashboard home | Your brief, the jobs and their spend, and the team's scorecard | The web app's home page from the records |

Order: 4.1 first, since every other slice is a job. 4.2 next, so people can see and stop what
4.3 and 4.4 do. 4.3 before 4.4, since a goal's pull requests are reviewed by the checker. 4.5
last.

## Slice 4.1

Planned in detail in `slice-4-1.md` (decision 215).

## Slice 4.2 (outline)

- `/jobs`: each job with its kind, owner, schedule, state, this month's spend against its cap,
  and its last wakes; `/jobs/<name>`: its wakes (said, silent, failed, skipped), notes and
  history.
- A person may pause or resume a job, change its schedule or cap, and (for kinds that take one)
  its goal, as themselves; each change is kept (rule 16). Anyone signed in may (174).

## Slice 4.3 (outline)

- **Finding work (G15):** on reconcile, the checker job lists the repository's open pull
  requests with the token the API already holds for checks, and takes each new head commit
  once. No webhook yet.
- **The review:** a short session of its own, with the diff, the change's brief and the
  decisions near it, that writes a review: what changed, what may be wrong, what to try by
  hand (the walkthrough, 142), and, once merged and deployed, whether production answers
  (157). It never sees Slack threads, and the session that writes cannot push.
- **Posted (G20)** as a comment review on the pull request with a token that can only comment,
  linked from the change's thread. One review per head commit; a new push gets a new one.

## Slice 4.4

Planned in detail in `slice-4-4.md` (decision 221).

### The outline it came from

- A goal job owns one feature: its tickets (Jira or the built-in tracker), its owner and its
  limit on pull requests waiting for review (two unless said).
- Each wake it reads the tickets and the changes it started; when under the limit, it writes a
  brief for the next ticket (as 2.1, so a person starts it when the start rule says so); when
  a pull request is merged it marks the ticket. It says what it did in the goal's thread.

## Slice 4.5 (outline)

- The web app's home: your brief (3.4), the jobs and their spend this month, and the team's
  scorecard (decisions made, conflicts settled, waits ended, pull requests reviewed and merged,
  this week against last).

## By hand, the owner's

- Before 4.3: a GitHub token that can comment on pull requests in the repository and nothing
  else, set as `GITHUB_REVIEW_TOKEN` in the API's Vercel project.

## Not in wave 4

- A GitHub webhook (G15): when a minute's delay costs something.
- Jobs that act for a person in shared spaces (G13).
- More than one workspace, repository or team (wave 5).

## Retros
