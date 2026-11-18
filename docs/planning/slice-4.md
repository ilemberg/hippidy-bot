# Slice 4: the agent gets a development environment

Status: **plan revised 2026-11-18 after a review against the code (decisions 112 to 124), not
started.** Every question is answered (decisions 98 to 110 and 113 to 122). The experiment
that opens the slice confirms what the docs cannot settle; its list is under "Experiment
first".

**Demo:** `@hippidy-bot change the 👀 reaction to 🫡`. The agent works in a clone of this repo,
makes the change, runs lint, typecheck and tests, pushes a branch and opens a pull request.
The bot posts the pull request's link in the thread, and ✅ appears only when the grader has
found the work done, green checks included (decision 115).

Facts below come from the current Managed Agents reference (read 2026-11-18) and the SDK's
types (`@anthropic-ai/sdk` 1.10.0, read in the review). Those marked _verify_ are checked
against the live API in the experiment that opens the slice.

## Where slice 3 left things

| Needed for the demo | State |
|---|---|
| An agent runtime behind `AgentRuntime`, with sessions, budgets, stop and reconcile | Done in slice 2 |
| Every agent event, with usage and cost, stored per conversation | Done in slice 3 |
| The agent can read and change the repo | **Not yet.** `agents/hippidy.md` has `tools: []` |
| The sandbox can install packages and reach GitHub | **Not yet.** The environment allows no network at all |
| The agent can open a pull request and read its checks | **Not yet** |
| The agent knows the project's rules and what "done" means | **Not yet.** No `.claude/skills/` in the repo |
| A turn can run longer than 30 minutes | **Not yet.** The loop stops every turn at 30 minutes (decision 113) |
| Only a turn's answer reaches the thread | **Not yet.** Every agent message is posted as soon as it is seen (decision 114) |
| ✅ means the work is done | **Not yet.** ✅ follows any normal end of turn (decision 115) |
| The loop copes with long sessions | **Not yet.** See "Carried in" below |

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
| Agent | GitHub: pull requests, checks, CI logs | **Yes** (decisions 99, 116): GitHub's own remote server | The documented way to open a pull request; the credential stays in a vault |
| Agent | GitHub: clone, commit, push | No: the repo mount and `git` | There is no MCP alternative that is better. The mount's token never enters the sandbox either |
| Agent | Slack | No | The API posts to Slack. The agent talking to Slack directly would go around the record |
| Agent | Supabase | No | The API is the only door to the database |
| Agent | A library docs server | Not yet | No need shown. Add it when the agent gets a library wrong for lack of current docs |
| Agent | Tickets and documents | Slice 5, by MCP | Already the plan; decision 98 makes it the default |
| Build session | Supabase and Vercel | **Yes** (decisions 101, 123), used read-only | Slice 3 took eight screenshots to see what production was doing |

## Facts that shape the slice

- **An MCP server is declared on the agent by URL, with no secret** (`mcp_servers`). Each one
  must be used by an `mcp_toolset` entry in the tools, which switches its tools on, tool by
  tool if wanted, and sets each to run `always_allow`, `always_ask` or `auto`. The agent
  files (`agents/hippidy.md`) can hold this; nothing secret goes in the repo.
- **The secret lives in an Anthropic vault**, as a bearer credential matched to the server's
  URL, and the vault is attached when a session is created. A vault cannot be added to a
  session later.
- **MCP tools ask before they run, by default.** The session goes idle on `requires_action`
  and lists the blocked calls; each is answered with `user.tool_confirmation` (`allow` or
  `deny`, with an optional message). The loop has no approval step, so every tool the agent
  may use runs without asking, every other tool is off (D11), and the API denies anything
  that still waits (decision 119).
- **With limited networking the environment must allow MCP servers** (`allow_mcp_servers`), or
  creating a session fails. Installing packages needs `allow_package_managers`. An environment
  can also preinstall packages (apt, npm and others), but cannot pin Node itself.
- **The repo is mounted when the session is created** (`github_repository`: the URL, a token,
  and a branch or commit to check out). For a public repo the token is optional to clone and
  needed to push. It stays outside the sandbox: `git` goes through a proxy that adds it.
  Threads opened before this slice have no repo and stay talk-only.
- **One token, used twice** (decision 122): the API passes it to the mount, and the vault holds
  it for the MCP server.
- **Skills load from `.claude/skills/<name>/SKILL.md`** at the root of the mounted repo, when
  the session starts. Loading `CLAUDE.md` is not documented (D4).
- **Tool output over 100,000 characters is written to a file** in the sandbox and the agent
  gets a preview. CI logs read through MCP will hit this; it needs no work from us.
- **A session can be given outcomes**, each a `user.define_outcome` event with a description
  and a rubric (3 revision cycles by default, 20 at most), sent at creation or later. A
  separate grader checks the work and reports a `span.outcome_evaluation_end` event whose
  verdict is `satisfied`, `needs_revision`, `max_iterations_reached`, `failed` (the rubric
  does not apply) or `interrupted`. After `max_iterations_reached` the agent takes one last
  turn and the session ends its turn normally, so the API must read the verdict.
- **Events can be listed after a time** (`created_at[gt]`), compared against `processed_at`.
  Whether a message still waiting in the queue is included is the experiment's question for
  decision 95.
- **GitHub's remote MCP server** (`https://api.githubcopilot.com/mcp/`, read 2026-11-18 from
  its own docs) takes a personal access token as a bearer credential. With no choice made it
  serves its default toolsets (context, repos, issues, pull requests, users): dozens of
  tools, including ones that merge and that write files, but not the actions tools, where
  `get_job_logs` is. A URL path narrows it to one toolset (`/x/pull_requests`, `/x/actions`,
  with `/readonly` after either). Its headers for picking single tools cannot be used: an
  agent declares a server by URL only. So the narrow list is made on our side, in the
  agent's `mcp_toolset` (D11, decision 116).
- **CI results come from check runs.** `pull_request_read` reads them with `get_check_runs`;
  its `get_status` shows commit statuses only, which GitHub Actions does not use. A check
  run's id is the job id that `get_job_logs` takes.
- **The token can merge.** Write access to contents and pull requests is enough to merge
  through GitHub's API. Merging is stopped by the tool list and by the token staying outside
  the sandbox, not by the token's rights (decision 117).
- _Verify:_ that a fine-grained token works for the mount and as the MCP credential.
- _Verify:_ a fine-grained token without the Workflows permission cannot push a change to
  `.github/workflows`.

## What gets built

### Agent and environment

- `agents/hippidy.md`: the sandbox toolset (shell, file tools; web search and fetch off), the
  GitHub MCP server at the address the experiment confirms (decision 116) with the four tools
  of decision 105 running without asking, and a prompt that says it works in this repo and
  must read `CLAUDE.md` first.
- `environments/hippidy.yaml`: package managers and MCP servers allowed, the hosts `git`
  needs, and whatever the experiment shows Node 26 needs. Still no general web access.
- The agent sync (`apps/api/scripts/sync-agent.ts` and `agent-files.ts`) learns MCP servers,
  allowed hosts and packages, and makes the vault `hippidy-bot` with its credential from
  `AGENT_GITHUB_TOKEN` (decisions 121, 122). It also stops making a new agent version when
  nothing changed, if the experiment shows it does.
- `.claude/skills/`: one skill for changing this repo: the definition of done, how to name a
  branch, what a pull request says, how to wait for CI (`get_check_runs`) and read a failed
  job's log (`get_job_logs` with the check run's id). It points at `CLAUDE.md` instead of
  copying it.

### API

- Starting a session mounts the repo with `AGENT_GITHUB_TOKEN` and attaches the vault, found
  by name like the agent and environment. A missing token or vault fails closed with a note
  in the thread, like every other missing setting.
- Every message is sent with an outcome and the rubric of decision 115. ✅ when the latest
  verdict is `satisfied`; otherwise ❌ and the grader's explanation in the thread.
- Made fit for long turns (pull request B):
  - a turn is given up on only after 30 minutes with no new event (decision 113);
  - only a turn's last message is posted, when the turn ends (decision 114);
  - a tool call that waits for approval is denied, so the session carries on (decision 119);
  - the sync lease is owner-checked (a slow sync can free a lease another sync holds); its
    column ships first, in pull request A3;
  - sync reads only new events (decision 95), after the experiment has probed the live API.
- Everything is still kept (decision 120). The database size is read at each slice's close;
  a response or event page too large for Vercel is dealt with when it happens.
- Progress notes in the thread on the schedule of decision 103, posted by reconcile and never
  while the conversation's sync lease is held.
- Each request is kept as a candidate eval case, as a view: the prompt, the base commit and
  the pull request, all already in the record. The view is made once the experiment shows how
  a pull request appears in the events; your verdict on each case waits for slice 6.

### Build session

- Supabase and Vercel connectors, used read-only, so "done when" checks (decision 96) are run
  by the session and not by screenshot. Both work (checked 2026-11-18).

## Experiment first

One throwaway session, started by a workflow you run by hand in the `release` environment
(decision 118). The script and workflow ship in pull request A2. It makes its own agent,
environment and vault (named `hippidy-bot-experiment`) with the settings planned for C,
asks for the demo change, prints what it finds, and removes what it made. The agent's pull
request is closed without merging.

| Question | What the experiment shows |
|---|---|
| D4 | Whether the agent sees `CLAUDE.md` and the skill without being told |
| D6 | Node and pnpm versions, install time, and whether lint, typecheck and every test pass in the sandbox. If Node is older than 26, what it takes to get 26 |
| D11, 116 | The GitHub MCP server's tool names, and which address serves both the pull request and the actions tools |
| 122 | That the fine-grained token works for the mount and as the MCP credential, the exact permission names it needs, and that it cannot push a change to `.github/workflows` |
| 121 | That `git commit` has an identity in the sandbox |
| D13, 115 | What a small change costs in dollars and minutes, and what the grader adds on the demo and on a plain question |
| Decision 95 | Whether a list of events filtered by time includes messages still waiting in the queue |
| 121 | Whether the agent sync makes a new agent version when nothing changed |

## Decide before starting

| # | Question | Pick, or the answer |
|---|---|---|
| D1 | Which runtime? | Already answered: Managed Agents behind `AgentRuntime` (decision 4, built in slice 2). Reopens only if D6 fails |
| D2 | GitHub identity | **Decided** (104, 122): one fine-grained personal access token on your account, this repo only (contents and pull requests: read and write; Actions, commit statuses and metadata: read; nothing else). Saved as `AGENT_GITHUB_TOKEN` in Vercel (Production) and the `release` environment; the agent sync makes the vault from it. Done by hand on 2026-11-18. If the experiment shows something we need does not accept it, the next simplest that does is used (a classic token first) and recorded. Cost: pull requests appear as you, so you cannot approve them; that matters in slice 6 |
| D3 | Who opens the pull request? | **Decided** (99): the agent, through the GitHub MCP server |
| D4 | How does the agent get the project instructions? | **Decided** (110): one source, `CLAUDE.md`. The prompt tells the agent to read it, and a skill under `.claude/skills/` holds the definition of done. The experiment confirms how the agent picks them up |
| D5 | What is "done"? | **Decided** (109, 115): lint, format check, typecheck and tests pass in the sandbox; the pull request says what changed and how it was checked; CI is green. Every message goes with an outcome whose rubric asks for this only when the message asked for a change. ✅ only on a `satisfied` verdict |
| D6 | Can the sandbox run the whole suite? | **Decided** (110): expected yes (no Docker is needed since slice 2), confirmed by the experiment; what cannot run there is left to CI |
| D7 | How do CI results reach the agent? | **Decided** (108, 116): the agent reads them itself through the GitHub MCP server (`get_check_runs`, then `get_job_logs` for a failed job). After opening the pull request it waits for the checks in the same turn (a limit of about ten minutes), reads the log of a failed job, fixes and pushes again. No GitHub webhook in this slice; one that wakes the session is planned for slice 6, where review, merge and deploy happen after the turn. Until then, anything that happens after the turn ends reaches the agent only when someone mentions it in the thread |
| D8 | Does the thread keep going? | **Decided** (109): yes. One thread is one session (decision 51), so "also rename X" continues on the same branch and pull request. A new top-level mention starts from the latest `main` |
| D9 | Not bricking the thing that fixes itself | **Set aside** (100). The fallback stays what it is today: this build session and Vercel's rollback |
| D11 | Which GitHub MCP tools, and do they ask first? | **Decided** (105, 116, 117): four tools on, each running without asking: `create_pull_request`, `update_pull_request`, `pull_request_read` (the pull request, its diff, comments and check runs) and `get_job_logs` (the log of a failed CI job). Everything else is off, among them `merge_pull_request`, `actions_run_trigger`, `push_files`, `create_or_update_file`, `delete_file`, `create_branch`, the review tools and the issue tools. No call waits for approval, so a thread cannot hang on one. The token's rights stop pushes to `main` and changes to workflows; the tool list is what stops a merge |
| D12 | What does the thread show during a long turn? | **Decided** (103, 106, 114): 👀 as now, and a note in the thread with the latest on what the agent is doing when a turn is still running after 15 minutes, 1 hour, 2 hours, 4 hours and 8 hours, then every 4 hours. Nothing before 15 minutes, and nothing else the agent writes until the turn ends. Each note is a new message; its text comes from the stored events (the agent's latest own words, else its latest step) with no extra model call; reconcile posts it, so it is right to the minute |
| D13 | Budget for a coding session | **Decided** (107): about $5 to start (it is $2 for a talk-only thread, decision 55), raised when real turns need more. The long end of the progress schedule is there just in case, not a target. The workspace's monthly limit stays the backstop |

## Order of work

Schema ships before the code that uses it (decision 86); one branch per pull request (88).

| # | Pull request | Depends on |
|---|---|---|
| A | This plan and its decisions (done, ilemberg/hippidy-bot 16), then the review's revisions | - |
| A2 | The experiment's script and its workflow, run by hand in `release` | - |
| A3 | Migration only: the sync lease's owner column | - |
| - | The experiment | A2 merged; the token saved (done) |
| B | The loop for long turns: lease owner check, read only new events, give up on silence, post only the last message, deny a call that waits | A3 merged and applied; the experiment (for decision 95) |
| C | The agent gets the repo, the sandbox tools and the GitHub MCP server; the agent sync learns MCP servers, hosts, packages and the vault; sessions mount the repo and attach the vault | B |
| D | Instructions, the skill, an outcome with every message, ✅ from the verdict | C |
| E | Progress in the thread; the eval-case view (its migration first) | C |
| - | Close: live checks, database size, retro, re-sketch slice 5 | All of the above |

## What you will need to do by hand

| When | Step | State |
|---|---|---|
| Before anything | Move the CI secrets into the `release` environment and delete the repository ones (README) | Done (decision 123) |
| Before anything | Update and reinstall the Slack app, so the bot gets the sender's name | Done; checked in the record |
| Before anything | Add the Supabase and Vercel connectors to the build session | Done; both checked from the build session |
| Before the experiment | Create the GitHub token (D2) and save it as `AGENT_GITHUB_TOKEN` in Vercel (Production) and in the `release` environment (README, "Slice 4 setup: the GitHub token") | Done; seen in Vercel (sensitive, Production only) |
| Before the experiment | Make sure the rule on `main` (pull request and CI required) allows no bypass, including for you: the token acts as you | To confirm |
| Before the experiment | Make sure the Anthropic workspace has a monthly spend limit | To confirm |
| After A2 merges | Actions, the experiment's workflow, **Run workflow** on `main` | - |
| After C | Mention the bot with the demo request | - |

## Done when

Each line gets its exact query or log search before its pull request merges (decision 96).

- The demo works: a request in Slack ends with a pull request whose checks are green, its
  link in the thread, and ✅ from a `satisfied` verdict.
- A follow-up in the same thread lands on the same pull request.
- A change that fails CI is fixed by the agent without anyone telling it, or the thread says
  plainly that it gave up (❌ with the grader's explanation).
- The agent cannot push to `main` or change a workflow (the token's rights and the rule on
  `main`), and has no tool that merges; its token, which could, never enters the sandbox.
- A turn that keeps working past 30 minutes is not stopped, and the thread shows only the
  progress notes and the turn's last message.
- A stop during a coding turn still answers at once.
- A coding session's events, cost and pull request can be read back from the record.
- The database size is read and written down in the retro.
- Lint, typecheck, tests and the Vercel build check pass in CI.

## Risks

- **Untrusted text meets the right to push.** A Slack message, a web page or a file in the
  repo can carry instructions. The limits are the token's rights (this repo only, no
  workflows, no administration), the short tool list (nothing that merges), a sandbox with
  no general web access, and `main` taking changes only by pull request.
- **The repo is public, and its skills are instructions to the agent.** Anything merged into
  `.claude/skills/` is loaded by the next session without review.
- **Cost.** A coding turn costs many times a chat turn, and the grader runs on every message,
  chat included. The session budget and the monthly limit hold it; D13 is set from
  measurements, not guesses.
- **Storage.** Everything is kept (decision 120), and a coding session's tool output could be
  tens of MB against the free plan's 500 MB. Read at each slice's close.
- **Waiting for CI inside the turn** (D7) keeps the thread on 👀 for minutes, with no note
  before the 15 minute mark (decision 103). Stop still works.
- **Set aside, not solved** (decision 100): a merged change can break the bot, and new code
  cannot be tried against Slack without deploying it to the real bot.

## Not in this slice

Approving tool calls from Slack; a GitHub webhook; merging by the bot (slice 6); a reviewer
agent (slice 6); tickets and documents (slice 5); a Slack app per preview; the UI.
