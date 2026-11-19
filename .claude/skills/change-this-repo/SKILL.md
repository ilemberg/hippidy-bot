---
name: change-this-repo
description: How the hippidy-bot agent delivers a code change to this repository, and what "done" means. Use whenever a message in the thread asks to change the code, docs or config.
---

# Changing this repo

The project's own rules are in `CLAUDE.md` at the root of the repo. Read it first and follow
it; this skill does not repeat it. This skill says how a change is delivered and when it is
done (decisions 109 and 132 in `docs/planning/decisions.md`).

## Done means

The thread shows ✅ only when all of these hold. The API checks the last one itself: if you
pushed or opened a pull request in a turn, it reads that pull request's CI checks when the
turn ends, and anything but all passed shows ❌.

1. Lint, format check, typecheck and tests pass in your sandbox
   (`pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`).
2. A pull request against `main` holds the change, and nothing unrelated.
3. Its description says what changed and how you checked it.
4. Every one of its CI checks has finished and passed.

If you cannot get there, say so plainly in your last message: what is left and why.

## Steps

1. **Node 26.** The sandbox has Node 22. Once per session, download the latest `v26`
   linux-x64 tarball from `https://nodejs.org/dist/` into `~/.local/node26`, put
   `~/.local/node26/bin` first on `PATH`, then `pnpm install --frozen-lockfile`.
2. **Branch.** For a new request: `git fetch origin main` and branch from `origin/main`,
   named `hippidy/<a-few-words>` (lowercase, hyphens). For a follow-up in a thread that
   already has a pull request: keep working on that pull request's branch.
3. **Change, then check.** Make the change, with tests where `CLAUDE.md` asks for them. Run
   the four checks above and fix what fails. Do not weaken or skip a test to get green.
4. **Commit and push.** One clear commit message (what and why). `git push -u origin <branch>`.
   You cannot push to `main`, and you cannot change files under `.github/workflows`: the
   token refuses both. If a change needs either, say so instead.
5. **Pull request.** For a new branch, `create_pull_request` against `main`. Its body has
   two parts: `## What changed` and `## How it was checked` (the commands you ran and their
   results). For a follow-up, the push updates the existing pull request; update its body
   with `update_pull_request` if what it says is no longer true.
6. **Wait for CI.** Call `pull_request_read` with method `get_check_runs` about once a
   minute (`sleep 60` between calls), for up to about ten minutes. When every run is
   `completed`:
   - all `success` (or `skipped`/`neutral`): done.
   - one failed: read its log with `get_job_logs`, passing the check run's `id` as
     `job_id`. Fix the cause, run the checks again, push, and wait again. Give up after
     three rounds and say what is failing.
7. **Last message.** Only your last message of the turn is posted in the thread. Make it
   stand on its own: one or two sentences on what changed, and the pull request's link.
   Never merge: a person reviews and merges.
