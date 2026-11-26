# Slice 4.4: a feature goal

Status: **planned 2026-11-26 (decision 221).** The wave is in `wave-4.md`; jobs in `slice-4-1.md`
and `slice-4-2.md`; the checker in `slice-4-3.md`.

**Demo:** Grace mentions the bot in a thread about the export feature, then opens the web app,
pastes the thread's link into "New goal", and lists the feature's tickets: T-4, T-5, T-6, T-7,
with a limit of two. Within a few minutes the goal posts a brief for T-4 in that thread, with a
Start button; Ada presses it and the worker opens a pull request. The goal posts T-5's brief
too, then waits: two changes are open. When T-4's pull request merges, the goal marks T-4 done,
says so in the thread and posts T-6's brief. `/jobs/export` shows each ticket, its change and
its pull request, and each wake, most of them silent.

## What it needs

| Part | What | Live behaviour changes? |
|---|---|---|
| A | **Schema**: `goals` (a goal job's thread and limit) and `goal_tickets` (its tickets in order, each with its state, change and brief); `goal` added to the job kinds | No |
| B | **The routes**: `POST /v1/goals` and `PATCH /v1/goals/:jobId` from a signed-in person; `GET /v1/jobs/:name` adds the goal | Only the web app |
| C | **The goal job**: each wake settles its open changes, then, under the limit, writes the next ticket's brief with one model call and posts it in the thread for a person to start | **Yes**: briefs appear in the goal's thread |
| D | **The pages**: "New goal" at `/jobs/new-goal`, and the goal's tickets on `/jobs/<name>` | Only the web app |

## Making a goal

- **Who:** anyone signed in, as themselves (174); never the service token, never a job (G16).
  The person who makes it owns it.
- **Where it speaks:** the thread whose link is pasted. The bot must already be in it (it has a
  conversation for that thread); otherwise the form says to mention the bot there first. One
  goal per thread.
- **What:** a name (as job names), the goal in words (up to 2,000 characters), its tickets in
  order (1 to 30 keys of the configured tracker, each checked to exist when it is added), the
  limit on open changes (1 to 5, two unless said), and the cap ($10 unless said, as rule 17).
  It wakes every 10 minutes unless changed.
- **Changing it:** the tickets (add, remove a ticket not yet briefed, reorder) and the limit,
  on the version seen, through `PATCH /v1/goals/:jobId`; state, cap, interval and goal through
  `PATCH /v1/jobs/:jobId` (4.2). Each change is kept in `job_events` (rule 16).

## Each wake

1. **Settle what it started.** For each ticket with a change:
   - the change was stopped in its thread: the ticket is `stopped`, and is not briefed again;
   - the change has a pull request: its state is read from GitHub with the checks token (as
     G15). Merged: the ticket is `merged`; a built-in task is marked done, as the goal (kept in
     the task's history); a Jira ticket is left for a person to close, since the API only reads
     Jira (3.3), and the thread line says so. Closed without merging: `closed`, not briefed
     again.
2. **Count what is open:** tickets `briefed` (waiting for Start, started, or with a pull request
   not yet merged or closed). A brief nobody starts holds its place: the limit is on open
   changes, not on merged work.
3. **Under the limit**, take the first ticket still `pending`. If its task is already done in
   the tracker, it is `done_elsewhere` and the next is taken. Otherwise one model call writes
   its brief, and the brief is posted in the thread, with a Start button. At most one brief per
   wake, so each wake stays short.
4. **Say what happened**, in one line per event, in the thread: a ticket merged, stopped or
   closed. A wake with nothing to say is silent (rule 15); one where every ticket is settled
   says so once.

## The brief

- **One model call**, no tools, no session (as the checker, 219): Claude Opus 5.5 at medium
  effort, with server-side refusal fallbacks. It is given the goal in words, the ticket's key,
  title and description, and the titles of the goal's other tickets; it writes the brief's
  title, what, why and "done when" (2.1's fields). The ticket's link is added by the code.
- **A person always starts it.** The ticket is text that anyone with access to the tracker can
  write (2.1, "Who can write what a session reads"), and the goal read it, so every goal brief
  needs Start, with that reason. This keeps rule 3 of 2.1: the only path from untrusted text to
  the worker is a brief a person has seen.
- The brief is the change's first brief, in the goal's thread, requested by the goal's owner.
  Writing it twice is impossible: it is keyed on the goal and the ticket.
- Its cost is the wake's cost, under the goal's cap. A refusal or a cut-off leaves the ticket
  `pending` and the wake `failed`; the third failure in a row on one ticket makes it `skipped`,
  said in the thread.

## Not in 4.4

- Writing to Jira (closing tickets, comments). A goal names the tickets for a person to close.
- A goal that finds its own tickets (by a Jira query or an epic): people list them (G16).
- Starting briefs without a person, whatever the start rule would say.
- Goals across repositories.

## By hand, the owner's

- Nothing new. Before rolling the API back past this slice, pause or delete the goal jobs.

## Done when

Each line gets its query or test before its pull request merges (96).

- A goal made in the web app posts its first brief in its thread, needing Start, with its cost
  on the wake.
- With the limit reached, a wake posts no brief and is silent.
- A merged pull request marks the ticket `merged` (and a built-in task done), says so once, and
  frees a place for the next brief.
- A stopped change or a closed pull request settles its ticket without a new brief.
- No ticket is briefed twice; the service token cannot make or change a goal.
