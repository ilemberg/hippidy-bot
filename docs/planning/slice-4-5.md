# Slice 4.5: the dashboard home

Status: **built 2026-11-26, not merged (decision 223).** The wave is in `wave-4.md`.

**Demo:** Ada signs in to the web app. The home page shows, from top to bottom: her brief for
today (what is new for her, as the direct message of 3.4 would say it), the jobs with this
month's spend against their caps and their last wakes, the team's scorecard for this week
against last, and the agents at work, as today. Every number links to the page it comes from.

## What it needs

| Part | What | Live behaviour changes? |
|---|---|---|
| A | **The scorecard route**: `GET /v1/scorecard`, from the records only: this week's and last week's counts | No |
| B | **The home page**: your brief, the jobs, the scorecard and the agents at work, each read on its own so one failing does not blank the page | Only the web app |

## The scorecard

- **Weeks** are Monday to Sunday in UTC: "this week" is from Monday 00:00 UTC to now, "last
  week" the seven days before it. The page says so.
- **Counted, each from a record with a time:**
  - decisions made: decisions that became active in the week (`decided_at`), of any origin;
  - conflicts settled (`settled_at`);
  - waits ended (`ended_at`);
  - changes started: briefs started in the week (`started_at`), by a person or the start rule;
  - pull requests reviewed: checker reviews posted in the week;
  - tickets merged: goal tickets settled as merged in the week.
- **Not counted:** pull requests merged outside goals. Nothing records when a pull request
  merges unless a goal reads it (4.4); a count that misses most merges would mislead, so it
  waits for a record that holds them.
- Only the workspace's own records (the person's workspace, as every route). One query per
  count, each cheap and indexed by its time; no call to Slack, GitHub or the tracker.

## The home page

- **Your brief:** the same text `GET /v1/briefs/me` gives `/brief` (3.4), built for now; if
  nothing is new, it says so. A link to `/brief` for the settings.
- **Jobs:** each job's name, state, spend this month against its cap, and its last wake's
  outcome and time, from `GET /v1/jobs`; the sum of the caps against decision 11's $100. A link
  to `/jobs`.
- **Scorecard:** each count, this week against last, with the difference.
- **Agents at work:** as today, below the rest.
- Each part is read on its own: a part whose route fails says the API did not answer, and the
  rest of the page still shows.

## Not in 4.5

- Charts over more than two weeks.
- Per-person scorecards: the scorecard is the team's (`team-layer.md`, "Dashboard"), and a count per person would rank people.
- Pull requests merged outside goals (above).

## Done when

Each line gets its query or test before its pull request merges (96).

- The scorecard counts each kind in the right week, and nothing from another workspace.
- The home page shows the four parts for a signed-in person, and still shows the rest when one
  route fails.

## As built

What the build decided that the plan did not say, or decided differently:

- **`GET /v1/scorecard`** is read by the service and anyone signed in, for the caller's
  workspace, like `GET /v1/jobs`. It answers both weeks' starts, when it was read, and each
  count (`decisions_made`, `conflicts_settled`, `waits_ended`, `changes_started`,
  `pull_requests_reviewed`, `tickets_merged`) with this week's and last week's numbers. The
  week is computed in one place (`scorecardWeeks` in `apps/api/src/store/scorecard.ts`), from a
  `now` passed in.
- **A decision made** is counted when it became active: when it was recorded active, or, for a
  proposal, when it was confirmed (`confirmed_at`, else `decided_at`). One superseded since
  still counts in the week it became active; proposed and rejected ones never count. Imports
  from the decision log belong to no workspace; they are the team's, as on the decisions page,
  so they count for every workspace. Every other decision is its thread's workspace, or its
  decider's when it has no thread.
- **Changes started** counts briefs started in the week, as the plan says, so a change whose
  brief was revised and started again counts again.
- **Pull requests reviewed** counts reviews with status `posted`, by their `updated_at`: a posted
  review is never updated again, so that is when it was posted (said in `reviews.ts`). Reviews
  are of the deployment's repository, not of a thread, so they belong to the workspace whose
  checker job posts them: they are counted for a workspace that has the checker job, and for no
  other.
- **Tickets merged** counts goal tickets in state `merged` by `settled_at`, through the goal's
  job and its workspace.
- **Indexes**: one partial index per count on its time column
  (`20261127191329_scorecard_indexes.sql`), additive only.
- **A job's last wake's outcome** is new on the job (`lastWakeOutcome`, from its latest kept
  wake; a wake still running reads as silent), so the home page shows it from `GET /v1/jobs`
  without a call per job.
- **The home page** reads its four parts at once, each on its own: a part whose route fails or
  throws says "The API did not answer" with why, and the rest shows. Each count links to its
  page where there is one: decisions to `/decisions`, conflicts to `/conflicts`, waits to
  `/waits`, reviews to `/jobs/checker`, goal tickets to `/jobs`; changes started have no page
  yet. Each job's spend links to its page. The brief's sections are one component shared with
  `/brief`.
