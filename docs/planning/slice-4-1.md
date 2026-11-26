# Slice 4.1: the job record and its scheduler

Status: **planned 2026-11-26 (decision 215).** The wave is in `wave-4.md`.

**Demo:** capture and briefs, which reconcile has run by hand since 2.5 and 3.4, run as the
first two jobs. `GET /v1/jobs` lists them with their schedule, state and this month's spend
against their cap; `GET /v1/jobs/capture` shows the last wakes: most say "silent: no quiet
thread was due", one says "said: 2 proposals" with its cost. A job paused in the database
does not wake; a job past its cap pauses itself and says so once.

## What it needs

| Part | What | Live behaviour changes? |
|---|---|---|
| A | **Schema**: `jobs` (name, kind, goal, owner, schedule, state, cap, notes, version), `job_wakes` (each wake: when, outcome, what it said or why not, cost), `job_events` (each change a person makes, before and after) | No |
| B | **The scheduler**: reconcile makes the built-in jobs if missing, asks which jobs are due, takes each due one once, checks its cap, runs its kind and logs the wake | **Yes**: capture and briefs now run through it, and are logged |
| C | **Reading**: `GET /v1/jobs` and `GET /v1/jobs/:name` for the service and anyone signed in | No |

## A job

- **Name** (lowercase, unique in the workspace), **kind** (`capture` or `briefs` in 4.1;
  `checker` and `goal` come in 4.3 and 4.4), an optional **goal** in words, an **owner** (the
  fallback for the built-in ones).
- **Schedule:** every N minutes, 1 to 1,440. Capture and briefs: every minute, as today; each
  decides within its wake whether anything is due (a quiet thread, a person's morning).
- **State:** `active`, `paused` (by a person) or `capped` (by itself, at its cap; it becomes
  active again when the month turns or a person raises the cap).
- **Cap:** dollars a month, kept in cents. Capture: $30 (its $1 a day of decision 199, for a
  month). Briefs: $1 (they use no model). New jobs: $10 (rule 17).
- **Notes:** what the job keeps between wakes (rule 14), written only by the job; empty for
  capture and briefs, whose state lives in their own tables.

## Waking

- Each reconcile makes the built-in jobs if they are missing, then lists the active jobs whose
  last wake is at least their interval ago.
- A due job is taken by one run only (its `last_wake_at` is moved forward atomically), so
  overlapping runs never wake it twice.
- Before it runs, its spend this calendar month (UTC), summed from its wakes, is checked
  against its cap; at the cap it becomes `capped` and one wake says so (`skipped`).
- It runs, and the wake is logged: `said` (it posted, proposed or sent something), `silent`
  (nothing to do, and why in a few words), `failed` (with the error) or `skipped`; with its
  cost in millionths of a dollar. A wake that throws never fails reconcile.
- Silent and skipped wakes are kept 14 days; the others are kept.

## Done when

Each line gets its query or test before its pull request merges (96).

- Capture and briefs run only through the scheduler, each wake logged with its outcome and
  cost, a silent wake included.
- A paused job does not wake; a job at its cap pauses itself, says so once, and wakes again
  next month.
- Two overlapping reconcile runs wake a job once.
- `GET /v1/jobs` and `GET /v1/jobs/:name` return the jobs, their spend and their last wakes.

## Not in 4.1

- Changing a job (pause, cap, schedule, goal) in the web app: 4.2.
- New kinds of job: 4.3 and 4.4.
