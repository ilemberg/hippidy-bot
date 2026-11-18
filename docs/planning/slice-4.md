# Slice 4: the agent gets a development environment

Status: **plan final 2026-11-18, not started** (decision 111). Every question is answered
(decisions 98 to 110). Two answers are confirmed by the experiment that opens the slice: how
the agent picks up the project instructions (D4) and whether the sandbox runs the whole test
suite (D6).

**Demo:** `@hippidy-bot change the 👀 reaction to 🫡`. The agent works in a clone of this repo,
makes the change, runs lint, typecheck and tests, pushes a branch and opens a pull request.
The bot posts the pull request's link in the thread, and ✅ appears only when the checks have
passed.

Facts below come from the current Managed Agents reference (read 2026-11-18). Those marked
_verify_ are checked against the SDK's types and the live API in the experiment that opens
the slice.

## Where slice 3 left things

| Needed for the demo | State |
|---|---|
| An agent runtime behind `AgentRuntime`, with sessions, budgets, stop and reconcile | Done in slice 2 |
| Every agent event, with usage and cost, stored per conversation | Done in slice 3 |
| The agent can read and change the repo | **Not yet.** `agents/hippidy.md` has `tools: []` |
| The sandbox can install packages and reach GitHub | **Not yet.** The environment allows no network at all |
| The agent can open a pull request and read its checks | **Not yet** |
| The agent knows the project's rules and what "done" means | **Not yet.** No `.claude/skills/` in the repo |
| The loop copes with turns that run for many minutes | **Not yet.** See "Carried in" below |

## MCP servers first (decision 98)

Where the agent or the build session needs an outside system, it uses an MCP server when one
exists, unless that makes things worse. "Worse" means one of:

- it goes around the API as the only door (rules 1 and 2 of `wave-1.md`);
- it puts a secret where agent-written code can read it;
- it needs wider rights than the alternative;
- it adds a server no slice needs yet (each one costs tokens on every turn and is one more
  party that sees the agent's work).

| Who | System | Through MCP? | Why |
|---|---|---|---|
| Agent | GitHub: pull requests, checks, CI logs | **Yes** (decision 99): GitHub's own remote server | The documented way to open a pull request; the credential stays in a vault |
| Agent | GitHub: clone, commit, push | No: the repo mount and `git` | There is no MCP alternative that is better. The mount's token never enters the sandbox either |
| Agent | Slack | No | The API posts to Slack. The agent talking to Slack directly would go around the record |
| Agent | Supabase | No | The API is the only door to the database |
| Agent | A library docs server | Not yet | No need shown. Add it when the agent gets a library wrong for lack of current docs |
| Agent | Tickets and documents | Slice 5, by MCP | Already the plan; decision 98 makes it the default |
| Build session | Supabase (read-only) and Vercel (logs, deployments) | **Yes** (decision 101) | Slice 3 took eight screenshots to see what production was doing |

## Facts that shape the slice

- **An MCP server is declared on the agent by URL, with no secret.** Its tools are switched on
  by an `mcp_toolset` entry, tool by tool if wanted. The agent files (`agents/hippidy.md`) can
  hold this; nothing secret goes in the repo.
- **The secret lives in an Anthropic vault**, matched to the server by URL and attached when a
  session is created. A vault cannot be added to a session later.
- **MCP tools ask before they run, by default.** The session goes idle and waits for a
  confirmation. The loop has no approval step, so every tool the agent may use is set to run
  without asking, and every other tool is switched off (D11).
- **With limited networking the environment must allow MCP servers** (`allow_mcp_servers`), or
  creating a session fails. Installing packages needs `allow_package_managers`.
- **The repo is mounted when the session is created**, with a GitHub token the API passes in.
  The token stays outside the sandbox: `git` goes through a proxy that adds it. Threads opened
  before this slice have no repo and stay talk-only.
- **Two GitHub credentials, not one:** the mount's token (held by the API, in Vercel) and the
  MCP server's credential (held in the vault). They can be the same token.
- **Skills load from `.claude/skills/<name>/SKILL.md`** at the root of the mounted repo, when
  the session starts. Loading `CLAUDE.md` is not documented (D4).
- **Tool output over 100,000 characters is written to a file** in the sandbox and the agent
  gets a preview. CI logs read through MCP will hit this; it needs no work from us.
- **A session can be given an outcome with a rubric**, checked by a separate grader before the
  agent stops.
- **GitHub's remote MCP server** (`https://api.githubcopilot.com/mcp/`, read 2026-11-18 from
  its own docs) takes a personal access token as a bearer credential. With no choice made it
  serves its default toolsets (context, repos, issues, pull requests, users): dozens of
  tools, including ones that merge and that write files. A URL path narrows it to one
  toolset (`/x/pull_requests`, `/x/actions`, with `/readonly` after either). Its headers for
  picking single tools cannot be used: an agent declares a server by URL only. So the narrow
  list is made on our side, in the agent's `mcp_toolset` (D11).
- _Verify:_ that a fine-grained token (not only a classic one) works as that credential.
- _Verify:_ a fine-grained token without the Workflows permission cannot push a change to
  `.github/workflows`.

## What gets built

### Agent and environment

- `agents/hippidy.md`: the sandbox toolset (shell, file tools; web search and fetch off), the
  GitHub MCP server with a short list of enabled tools, and a prompt that says it works in
  this repo and must read the project instructions first.
- `environments/hippidy.yaml`: package managers and MCP servers allowed, plus the hosts
  `git` needs. Still no general web access.
- `.claude/skills/`: one skill for changing this repo (the definition of done, how to name a
  branch, what a pull request says). It points at `CLAUDE.md` instead of copying it.

### API

- Starting a session mounts the repo and attaches the vault. A missing token or vault fails
  closed with a note in the thread, like every other missing setting.
- A session that goes idle waiting for an approval is shown as failed with a note, not left
  waiting for ever. Approvals in Slack are a later slice.
- Carried in from slice 3, before coding turns make them hurt:
  - the sync lease is owner-checked (a slow sync can free a lease another sync holds);
  - sync reads only new events (decision 95), after the experiment has probed the live API;
  - transcripts and event pages get a size budget, and retention is looked at again
    (decision 76) against the free plan's 500 MB.
- Progress notes in the thread on the schedule of decision 103, posted by reconcile and never
  while the conversation's sync lease is held.
- Each request is kept as a candidate eval case: the prompt, the base commit, the pull
  request and, later, your verdict. Most of it is already in the record.

### Build session

- Supabase and Vercel connectors, read-only, so "done when" checks (decision 96) are run by
  the session and not by screenshot.

## Experiment first

One throwaway session, started by hand with the real agent settings. It needs the GitHub token, so it runs when the token exists (decision 112), not necessarily before the first code. It answers what cannot be decided from the docs:

| Question | What the experiment shows |
|---|---|
| D4 | Whether the agent sees `CLAUDE.md` and the skill without being told |
| D6 | Node and pnpm versions, install time, and whether lint, typecheck and every test pass in the sandbox |
| D11 | The GitHub MCP server's tool names, and that the token works as its credential |
| D13 | What a small change costs in dollars and minutes |
| Decision 95 | Whether a list of events filtered by time includes messages still waiting in the queue |

The build session cannot call the live API, so the experiment runs as a workflow started by
hand in the `release` environment, or from your machine.

## Decide before starting

| # | Question | Pick, or the answer |
|---|---|---|
| D1 | Which runtime? | Already answered: Managed Agents behind `AgentRuntime` (decision 4, built in slice 2). Reopens only if D6 fails |
| D2 | GitHub identity | **Decided** (104): the simplest that works. A fine-grained personal access token on your account, limited to this repo (contents and pull requests: write; read access to CI results; no workflows, no administration; exact permission names checked in the experiment). It serves both the repo mount and the MCP server. If the experiment shows something we need does not accept it, the next simplest that does is used (a classic token first) and recorded. Cost: pull requests appear as you, so you cannot approve them; that matters in slice 6 |
| D3 | Who opens the pull request? | **Decided** (99): the agent, through the GitHub MCP server |
| D4 | How does the agent get the project instructions? | **Decided** (110): one source, `CLAUDE.md`. The prompt tells the agent to read it, and a skill under `.claude/skills/` holds the definition of done. The experiment confirms how the agent picks them up |
| D5 | What is "done"? | **Decided** (109): lint, format check, typecheck and tests pass in the sandbox; the pull request says what changed and how it was checked; CI is green. Given to the session as an outcome with a rubric, so a grader checks it before the bot says ✅ |
| D6 | Can the sandbox run the whole suite? | **Decided** (110): expected yes (no Docker is needed since slice 2), confirmed by the experiment; what cannot run there is left to CI |
| D7 | How do CI results reach the agent? | **Decided** (108): the agent reads them itself through the GitHub MCP server. After opening the pull request it waits for the checks in the same turn (a limit of about ten minutes), reads the log of a failed job, fixes and pushes again. No GitHub webhook in this slice; one that wakes the session is planned for slice 6, where review, merge and deploy happen after the turn. Until then, anything that happens after the turn ends reaches the agent only when someone mentions it in the thread |
| D8 | Does the thread keep going? | **Decided** (109): yes. One thread is one session (decision 51), so "also rename X" continues on the same branch and pull request. A new top-level mention starts from the latest `main` |
| D9 | Not bricking the thing that fixes itself | **Set aside** (100). The fallback stays what it is today: this build session and Vercel's rollback |
| D11 | Which GitHub MCP tools, and do they ask first? | **Decided** (105): four tools on, each running without asking: `create_pull_request`, `update_pull_request`, `pull_request_read` (the pull request, its diff, comments and check results) and `get_job_logs` (the log of a failed CI job). Everything else is off, among them `merge_pull_request`, `actions_run_trigger`, `push_files`, `create_or_update_file`, `delete_file`, `create_branch`, the review tools and the issue tools. No call waits for approval, so a thread cannot hang on one. The token's rights are the hard limit; the tool list is the second one |
| D12 | What does the thread show during a long turn? | **Decided** (103, 106): 👀 as now, and a note in the thread with the latest on what the agent is doing when a turn is still running after 15 minutes, 1 hour, 2 hours, 4 hours and 8 hours, then every 4 hours. Nothing before 15 minutes. Each note is a new message; its text comes from the stored events (the agent's latest own words, else its latest step) with no extra model call; reconcile posts it, so it is right to the minute |
| D13 | Budget for a coding session | **Decided** (107): about $5 to start (it is $2 for a talk-only thread, decision 55), raised when real turns need more. The long end of the progress schedule is there just in case, not a target. The workspace's monthly limit stays the backstop |

## Order of work

Schema ships before the code that uses it (decision 86); one branch per pull request (88).

| # | Pull request | Depends on |
|---|---|---|
| A | This plan and its decisions (done); then any migration, on its own | - |
| - | The experiment | The GitHub token (decision 112) |
| B | Loop hardening: lease owner check, size budgets; reading only new events waits for the experiment (decision 95) | - |
| C | The agent gets the repo, the sandbox tools and the GitHub MCP server; sessions mount the repo and attach the vault | B |
| D | Instructions, the skill, the outcome and its rubric | C |
| E | Progress in the thread; eval cases | C |
| - | Close: live checks, retro, re-sketch slice 5 | All of the above |

## What you will need to do by hand

None of these is a prerequisite for starting this slice (decision 112). They are prerequisites
of slice 6, the last slice of the wave, and are listed in `wave-1.md` under it.

What that means here: the slice is built and tested against fakes, as every slice has been.
Two things cannot happen without the GitHub token, whenever it is created: the experiment
below, and the live demo. Until then D4 and D6 stay "expected, not confirmed", and the "done
when" lines that need production stay unchecked (decision 96 still decides when the slice
closes).

| Step | Needed for |
|---|---|
| Create the GitHub token (D2). Save it in Vercel, Production only, and as the GitHub MCP credential in an Anthropic vault | The experiment and the live demo: without it the agent cannot clone, push or open a pull request |
| Make sure the rule on `main` (pull request and CI required) allows no bypass, including for you: the token acts as you | Safe use of the token |
| ~~Move the CI secrets into the `release` environment and delete the repository ones~~ | **Done 2026-11-18** (confirmed by the owner): "Database migrations" ran green on `main` from the environment's secrets. The Anthropic key is exercised by the next "Agent sync" run |
| ~~Update and reinstall the Slack app~~ | **Done 2026-11-18** (tested by the owner): the bot gets the sender's name. Stop mid-answer, open since slice 2, was tested live the same day |
| Add the Supabase (read-only) and Vercel connectors to the build session | Live checks without screenshots |

## Done when

Each line gets its exact query or log search before its pull request merges (decision 96).

- The demo works: a request in Slack ends with a pull request whose checks are green, and its
  link in the thread.
- A follow-up in the same thread lands on the same pull request.
- A change that fails CI is fixed by the agent without anyone telling it, or the thread says
  plainly that it gave up.
- The agent cannot push to `main`, change a workflow, or merge.
- A stop during a coding turn still answers at once.
- A coding session's events, cost and pull request can be read back from the record.
- Lint, typecheck, tests and the Vercel build check pass in CI.

## Risks

- **Untrusted text meets the right to push.** A Slack message, a web page or a file in the
  repo can carry instructions. The limits are the token's rights, the short tool list, a
  sandbox with no general web access, and `main` taking changes only by pull request.
- **The repo is public, and its skills are instructions to the agent.** Anything merged into
  `.claude/skills/` is loaded by the next session without review.
- **Cost.** A coding turn costs many times a chat turn. The session budget and the monthly
  limit hold it; D13 is set from measurements, not guesses.
- **Waiting for CI inside the turn** (D7) keeps the thread on 👀 for minutes, with no note
  before the 15 minute mark (decision 103). Stop still works.
- **Set aside, not solved** (decision 100): a merged change can break the bot, and new code
  cannot be tried against Slack without deploying it to the real bot.

## Not in this slice

Approving tool calls from Slack; a GitHub webhook; merging by the bot (slice 6); a reviewer
agent (slice 6); tickets and documents (slice 5); a Slack app per preview; the UI.
