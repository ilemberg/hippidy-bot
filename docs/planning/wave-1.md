# Wave 1: minimum setup

Goal of the wave: `@hippidy-bot` in Slack can take a request, change this repository through a
cloud agent, and get that change merged with enough automated checking that it does not need a
human to read every diff. After slice 4, hippidy-bot is developed through hippidy-bot.

Only the next slice is planned in detail. Everything after it is a sketch and will be rewritten.

**Wave 1 closed on 2026-11-25 with slice 5A (`decisions.md` 179).** Slices 5B, 5C and 6 below
are kept as they were sketched and are not built as designed. What follows is in `wave-2.md`.

## Target shape

```
Slack ──events──▶ Slack adapter ─┐
                                 ├──▶ Core API ──▶ Agent runtime (Claude Managed Agents)
Web UI (later) ──────────────────┘       │                 │
                                         ▼                 ▼
                                   Supabase (record)   GitHub repo / PR
```

Rules that hold for the whole wave:

1. Slack and the UI talk only to the Core API. Neither talks to Anthropic, Supabase or GitHub.
2. The Core API is channel-agnostic. It knows "conversation" and "message", not "Slack thread".
3. Agent runtime, work-item system and knowledge system each sit behind an interface, because
   those are the parts that would change. The product direction is decided (a project moving
   through stages, `decisions.md` 135); which work-item and knowledge systems is not.
4. Where the agent needs an outside system, it uses an MCP server when one exists, unless
   that makes things worse: for one, when it would go around rule 1 (`decisions.md` 98).

## Facts that shape the design

These came from the current Managed Agents docs and Slack/Vercel constraints. They are why some
slices look different from the first description.

- **Slack needs a 2xx within 3 seconds** and retries if it does not get one. Retries carry the
  same event id, so every inbound event must be deduplicated.
- **Agent turns take minutes, serverless functions do not wait that long.** The return path is
  not "hold a connection open". It is: Anthropic calls a webhook on our API when the session
  goes idle, the API fetches the new events, then posts to Slack.
- **Managed Agents webhooks are not durable.** Three delivery attempts, then the event is
  dropped silently, with no ordering guarantee. A reconcile job that polls active sessions is
  required, not optional.
- **An agent is created once and versioned; a session pins the agent version it started with.**
  Changing the agent's prompt or tools does not affect threads that are already open.
- **Repositories and vault credentials attach at session creation only.** A conversation that
  began without a repo cannot be given one later. It needs a new session.
- **The GitHub token never enters the agent's sandbox.** Git traffic goes through a proxy that
  injects it. Opening a PR is documented as needing the GitHub MCP server in addition to the
  repo mount.
- **Mounting a repo loads `.claude/skills/` from its root.** Loading `CLAUDE.md` is not
  documented, so project instructions must reach the agent another way (system prompt, or a
  skill, or an explicit "read CLAUDE.md first" instruction).
- **Sessions can carry a hard dollar budget**, and tool calls can be set to run, ask, or be
  evaluated automatically. Both are available from the first agent slice.
- **Cost model:** tokens at model list price plus $0.08 per session-hour of runtime.

## Slice 1: mention goes to the API, bot reacts

**Demo:** mention the bot in a channel. Within a couple of seconds the message gets an 👀
reaction. The API log shows the message.

Scope:

- Repo scaffold: TypeScript strict, linter, formatter, unit test runner, CI on pull requests.
- Slack app defined by a manifest file in the repo. Scopes: `app_mentions:read`,
  `reactions:write`, `chat:write`.
- Slack adapter built on Bolt for JavaScript with the `@vercel/slack-bolt` adapter (decided).
  Bolt handles signature checks, the URL verification challenge and acknowledging Slack in
  time. Our code: receive `app_mention`, call the Core API, add the reaction when the API
  accepts the message, and drop Slack's retries after a timeout.
- The adapter passes full sender details to the API (user, channel, thread, timestamp,
  workspace), even though nothing stores them yet.
- Core API built with Hono (decided): one endpoint that accepts a channel-agnostic inbound
  message and returns 202.
- Deployed on Vercel, with a preview deployment per pull request.

Exit criteria:

- A request with a bad Slack signature is rejected.
- A Slack retry after a timeout is dropped. Deduplication with storage arrives in slice 2.
- The app starts and `/health` works with no Slack configuration, and the API rejects every
  call when its token is not configured.
- The API contract is written down as a schema that the future UI can use.
- Lint, typecheck and tests run in CI and block merge.

Full specification, manual steps and working method: `slice-1.md`. Nothing is left to decide.

Known hard parts: Slack sends events to one public URL per app. With a single Slack app,
trying new code against Slack means deploying it to the real bot. Accepted for now; the
problem is recorded in `decisions.md` under "Deferred on purpose".

## Slice 2: talk to one managed agent

**Demo:** mention the bot with a question. It replies in a thread. Reply in the thread and it
answers with the earlier context. The agent has no tools and no repo.

Scope:

- One agent and one environment, defined as files in the repo and synced to Anthropic.
- Top-level mention starts a session. A message in an existing bot thread continues it.
- Return path: webhook on session idle, fetch new agent messages, post to the Slack thread.
- Reaction lifecycle on the user's message: 👀 received, ✅ answered, ❌ failed.
- Look up the sender's name from their Slack ID so the agent knows who it is talking to
  (adds the `users:read` scope; `decisions.md` 34).
- Per-session budget cap.
- Slack formatting: convert the agent's Markdown to Slack's format, split long replies.

Exit criteria:

- A reply always arrives or a failure is shown. No silent drops when a webhook is lost.
- Two messages sent in quick succession are answered in order.
- A webhook delivered twice posts once.

**Storage (decided):** this slice includes a minimal Supabase with only what Vercel needs to
remember between requests: the thread-to-session mapping and the event dedupe table. Slice 3
expands it into the full record.

**The async loop (decided):** acknowledge at once in Slack, then the API updates the thread
when the agent asks a question or finishes. An agent question and a finished answer look the
same to the API (the session goes idle with a message), so one path covers both.

Done 2026-11-18: see `slice-2.md` and the retro below.

## Slice 3: Supabase as the record

**Demo:** every conversation, message and agent event from slices 1 and 2 can be read back
from Supabase, and a conversation can be reconstructed from the database alone.

Sketch of the model (to be refined when the slice starts):

| Table | Purpose |
|---|---|
| `conversations` | One per thread of work. Channel, external reference, status, creator |
| `messages` | Human and agent messages, channel-agnostic, in order |
| `agent_sessions` | Session id, agent id and version, environment, budget, cost, status |
| `agent_events` | Raw event log from the agent runtime, append-only, unique on event id |
| `inbound_events` | Every Slack or UI event received, unique on source event id (dedupe) |
| `deliveries` | Outbound posts to Slack or UI, with status, so a reply is sent exactly once |

Exit criteria:

- Schema lives in migrations in the repo and is applied by CI, not by hand.
- Only the API can reach the database. Row level security is on with no public policies.
- The reconcile job repairs a conversation whose webhook was dropped.
- Database tests run without Docker (the agent's sandbox in slice 4 probably cannot run it).

Decide before starting: questions C1 to C6.

Re-planned 2026-11-18 from what slice 2 built: see `slice-3.md`. The sketch above is kept as
it was; what was built is a raw event log (`agent_events`), usage on `conversations`, a
transcript view instead of `messages` and `agent_sessions` tables, and three read routes
(`decisions.md` 75 to 97).

Done 2026-11-18: see `slice-3.md` and the retro below.

## Slice 4: the agent gets a development environment

**Demo:** `@hippidy-bot change the 👀 reaction to 🫡`. The agent clones this repo, makes the
change, runs lint, typecheck and tests, pushes a branch and opens a pull request. The bot
posts the PR link in the thread.

Sketch:

- Every session mounts this repo (decided). Environment has Node and the package manager, with network
  limited to package registries and GitHub.
- The agent gets what the local Claude Code setup has: project instructions, skills under
  `.claude/skills/`, the same lint and test commands, and a definition of done.
- PR creation by the GitHub MCP server, or by the API itself after the agent pushes a branch.
- The request is framed as an outcome with a rubric (tests pass, diff is minimal, PR opened)
  so a separate grader checks the work before the bot claims success.
- From this slice on, every request is saved as a candidate eval case: prompt, base commit,
  resulting diff, and the human verdict on it.

Risks to design for:

- The agent is changing the system that runs it. A bad merge can break the bot. There must be
  a way to work that does not depend on the bot (plain Claude Code on the repo) and a fast
  rollback (Vercel instant rollback).
- Single user in a personal workspace, so no allowlist (decided). Revisit if others join.
- The repo is public. Skills and instructions in it are part of the trust boundary.
- Preview deployments run agent-written code, so they hold no production secrets
  (`decisions.md` 39).
- Trying changes in real Slack without touching the real bot: per-preview Slack apps are the
  leading candidate, but they put a Vercel token into preview builds. Decide before this
  slice (`decisions.md`, "Deferred on purpose").

Decide before starting: questions D1 to D9.

Carried into this slice from slice 3:

- Give the build session a way to see production (see the slice 3 retro): slice 3 found
  the reconcile job had been rejected for a whole slice without anyone noticing.
- Move the CI secrets into the `release` environment and delete the repository ones
  (decision 94). Until then a pull request, including the agent's, can add a workflow that
  reads them.
- Make the sync lease owner-checked: a sync that outlives its 120 seconds can free a lease
  another sync holds. Coding turns run long, so this stops being rare.
- Read only new events on each sync (decision 95), after a probe of the live API. A coding
  session lists thousands of events; today every sync reads them all.
- Give transcripts and event pages a size budget: tool output makes both large, and Vercel
  limits a response to a few megabytes. Revisit retention (decision 76) against the free
  plan's 500 MB at the same time.
- The record is what progress updates and eval cases can be built from: tool use and model
  requests are already stored per conversation.

Planned 2026-11-18 in `slice-4.md` (final, not started). The sketch above is kept as it was;
what changed (`decisions.md` 98 to 111):

- MCP servers first. The agent opens the pull request through the GitHub MCP server (D3), and
  the answers to D2 and D7 changed with it: one fine-grained token instead of a GitHub App,
  and the agent reads its own CI results through MCP instead of a GitHub webhook to the API.
- The two "bot develops itself" items no longer block the slice: D9, and trying changes in
  real Slack without touching the real bot.
- The build session gets its eyes on production from Supabase and Vercel connectors.
- Three questions were added: which GitHub tools the agent gets (D11), progress in the thread
  (D12, since answered: notes on a fixed schedule, decision 103) and the budget of a coding
  session (D13).

Revised 2026-11-18 after the plan was checked against the code and the SDK
(`decisions.md` 112 to 124). Still not started:

- The loop is made fit for long turns: a turn is stopped only once it has gone quiet for 30
  minutes, and only its last message is posted, beside the progress notes.
- Every message goes with an outcome, and ✅ comes from the grader's verdict, not from the
  turn ending.
- The GitHub MCP server's address must include its actions tools. The token can merge, so the
  tool list is what stops a merge.
- The experiment gets its own pull request and runs in `release`, with a throwaway agent.
- Everything is kept; the database size is read at each slice's close (13 MB at the start).
- Every step by hand before the experiment is done: CI secrets in `release`, the Slack app,
  the connectors, the GitHub token as `AGENT_GITHUB_TOKEN`, no bypass on `main`, and a
  monthly spend limit on the workspace.

Done 2026-11-19: see `slice-4.md` (its live checks at close) and the retro below.

## Slice 5: a feature moves through a project

Closed 2026-11-25 (`decisions.md` 179): 5A is built and live; 5B and 5C are not built as
designed, because stages and approvals were removed (173). The walkthrough and the production
check of 5C carry to slice 4.3 of `wave-2.md`. Retro at the end of this file.

Re-sketched 2026-11-19 (`decisions.md` 135 to 158). The sketch before that was "work from a
ticket instead of a sentence": `@hippidy-bot pick up HB-12`, with a work-item provider and a
knowledge provider behind interfaces. That is now only the last stage of a longer workflow,
described in `projects.md`: a project goes from a plan document, to an epic and tickets, to
shipped changes, with two approvals on the way and two agents behind the one bot.

Three parts, each a slice of its own size. None is planned in detail and none has started.

**5A. Plan and discovery.** Planned in `slice-5a.md`; started 2026-11-19 (decision 163). Demo: a product manager starts a project in Slack; several
people and the bot write its plan document in a thread; the product manager and the
engineering manager approve it. Needs: projects, roles and approvals in the database; the
product agent; threads tied to a project; the bot reading what was said since its last turn;
the document system.

**5B. Roadmap.** Demo: the bot turns the approved plan into an epic and tickets; they are
iterated in a thread and approved by both; after that they take comments only, until an
approval is withdrawn. Needs: the ticket system; freezing; notes in every active thread of
the project when something changes.

**5C. Ship and iterate.** Demo: `@hippidy-bot start development on HB-12` on an approved
roadmap ends with a pull request, a walkthrough with screenshots in the thread and an
updated ticket; after a person merges, the bot checks production; when everyone is done, the
project is ended and its tickets are closed. Needs: the engineer agent reading and updating
tickets; the API's reference page; images from the sandbox to Slack; finding the merge; the
production check.

Every question in group E is answered. Two answers wait for a probe, like slice 4's
experiment: whether Atlassian's MCP server accepts a token our vault can hold on a free site
(E1, before 5A), and how screenshots leave the sandbox (E11, before 5C).

Slice 4 closed on 2026-11-19 (retro below), with four live checks still to run in Slack
(`slice-4.md`, "Live checks at close"). The Atlassian probe is a workflow run by hand
(decision 159).

## Slice 6: auto-merge with confidence

Parked 2026-11-25 (`decisions.md` 179). The independent review step carries to slice 4.3 of
`wave-2.md`; the rest waits until that reviewer has run on real pull requests.

**Demo:** a low-risk request goes from Slack message to merged and deployed with no human
touching GitHub, and a deliberately bad request is stopped by the checks.

Sketch:

- Branch protection with required checks, and GitHub auto-merge when they pass.
- An independent review step (a second agent or the Claude Code review action).
- Risk tiers by path: docs and tests auto-merge first; migrations, CI config, agent config,
  auth and the eval suite always need a human.
- An eval suite built from the cases collected since slice 4, run when the agent's prompt,
  model or tools change.
- Post-deploy smoke test, automatic rollback, and a kill switch for the bot.

Decide before starting: questions F1 to F6.

## Testing strategy

Decided in outline: as much testing as possible in the agent sandbox, the rest in GitHub
Actions. The details below are the starting point and are revisited before implementing. The
problem: the agent's
sandbox probably cannot run Docker (to be confirmed by experiment), and local Supabase needs
Docker. So tests are split by where they can run.

| Tier | Runs where | What | Feedback time |
|---|---|---|---|
| 1. Inner loop | Agent sandbox and your machine | Lint, typecheck, unit tests. Slack, Anthropic and GitHub replaced by fakes. Database logic tested against PGlite, a real Postgres that runs in-process with no Docker | Seconds |
| 2. Integration | GitHub Actions on every PR | Full local Supabase (Docker is available there), migrations applied from scratch, API tested against it with recorded Slack and agent payloads | Minutes |
| 3. End to end | Against the PR's Vercel preview | A signed fake Slack event sent to the live preview URL; later, browser tests for the UI (see `stack-and-tools.md`, "Browser access for the agent") | Minutes |

What makes this work for an agent:

- The agent runs tier 1 itself before pushing, so most mistakes never reach a PR.
- Tier 2 and 3 results come back to the same agent session (GitHub tells the API, the API
  tells the agent), so it fixes failures it could not see in its sandbox.
- Recorded payloads from real Slack events and real agent sessions are the fixtures. Slice 1
  captures one real Slack event by hand from the log, since Vercel keeps logs only briefly;
  from slice 2, storage keeps them at no extra cost.
- If tier 1 proves too thin, the fallback is running the agent where Docker exists (a
  self-hosted sandbox, or the Agent SDK inside GitHub Actions). That is a runtime swap behind
  the `AgentRuntime` interface, not a redesign.

## Not in wave 1

- Web UI. Until then, the Anthropic Console session viewer and the Supabase table editor.
- More than two agents, or agent personas. Slice 5 has two agents behind the one bot, and
  people do not see which one answered (`decisions.md` 139).
- More than one repository or more than one Slack workspace.

## Retros

Appended after each slice: what was learned, what changed in the slices that follow.

### Slice 1 (finished 2026-11-18)

**Shipped:** ilemberg/hippidy-bot pull requests 2 (scaffold, CI, API) and 3 (Slack adapter),
plus a last one with the real recorded event as a fixture and this retro. Demo done:
`@hippidy-bot did it work?` got 👀 in about two seconds, and the API logged the message with
sender, channel, thread and correlation id.

**What was learned:**

- **Local `vercel build` was the most valuable check of the slice.** Run on a copy of the repo
  and then loaded the way Vercel loads it, it caught three problems that would each have broken
  the first deploy:
  - Vercel picks `src/app.ts` over `src/index.ts` as the entry, and only accepts an entry file
    that creates the Hono app itself.
  - Vercel cannot run a workspace package that exports raw `.ts`, so packages export source
    under a `source` condition and compiled `dist/` by default.
  - Vercel's build type-checks with an empty global `Response` type, unlike `tsc`.
- **Libraries do things the docs do not mention.** With a plain `token`, Bolt calls Slack's
  `auth.test` before acknowledging the first event on every cold start, which eats into
  Slack's 3 second limit. Every Events API body also carries Slack's legacy verification
  token, which would have been logged and committed as a fixture.
- **Independent review agents earned their cost.** Given the code and not the author's
  summary, they found four must-fix problems across the two pull requests.
- **Setup friction was in the dashboards, not the code.** Slack's manifest editor opens on the
  JSON tab; Vercel's `git-main` address sits behind a login wall, so Slack needs the production
  domain. The README now says both.
- **This build session cannot reach `*.vercel.app`**, so live checks are done by you. Fine
  for now; it matters more from slice 4.

**What changes for the next slices:**

- Slice 2 is drafted in `slice-2.md`, with B10 to B14 added from what slice 1 showed: outbound
  delivery without Slack knowledge in the API, scheduling the reconcile on the free plans,
  and migration tooling and environments pulled forward from slice 3, since storage arrives
  in slice 2.
- Keep the local `vercel build` check for any change to entry files, packaging or types;
  consider adding it to CI.
- Real deduplication with storage in slice 2 replaces "drop retries after a timeout".

**Carried forward:** pin CI actions to commit SHAs (before slice 4); lazy-load Bolt to cut
about 280 ms from cold starts (when it matters); turn on Dependabot alerts.

### Slice 2 (finished 2026-11-18)

**Shipped:** ilemberg/hippidy-bot pull requests 5 (decisions B2 to B14), 6 (storage), 7 (the
agent loop) and 8 (names and stop). Demo done: `@hippidy-bot what is agile?` was answered in
the thread by the Claude agent, with Slack formatting, and 👀 became ✅. Names and stop are
deployed; their live check (a stop mid-answer, the bot using your name) is still to do.

**What was learned:**

- **Independent reviews found real bugs in every pull request: 11 must-fix in slice 2**, almost
  all about concurrency and ordering. Examples: a queued message marked ✅ before it was
  answered, two overlapping syncs reordering replies, a failed stop being handed to the agent
  as a question. Our own tests had missed them because the fakes answered instantly; the
  test helpers now stall and race on purpose.
- **Read the SDK, not the mental model.** Settling messages correctly depended on two facts
  found in the SDK's types: events are listed by when they were processed, and a queued
  message has no processed time yet. The first design, built on how it "should" work, was
  wrong.
- **Vercel's own type check differs from `tsc` in three more ways** (the SDK's default
  export, empty `Request` and `Response` types, no strict null checks). CI now runs a second
  check that behaves like Vercel's, and the rules are in `CLAUDE.md`.
- **The build session could not run Anthropic's `ant` binary**, so the agent is synced by a
  small SDK script in CI. It worked first time: the merge created the agent and environment.
- **Setup is the heavy part for you:** about ten settings across Anthropic, Supabase, Vercel,
  GitHub and Slack, and the Anthropic Console's menus did not match its docs (webhooks).
  Screenshots got us through each one.
- **One branch for several pull requests caused friction:** finished work had to wait,
  unpushed, until the previous pull request merged.
- **A new column was used in the same deploy that added it** (pull request 8), breaking the
  rule that a migration must work with the old and the new code. Harmless this time; the
  rule needs following: ship the migration first, the code that uses it later.

**What changes for the next slices:**

- Slice 2 built much of what slice 3 sketched (migrations in CI, row level security, the
  reconcile job, tests without Docker), so slice 3 should be re-planned from what exists
  before it starts.
- Before slice 4: pin CI actions by commit, put the agent sync behind a protected GitHub
  environment, and allow one branch per pull request.

**Carried forward:** check names and stop live; read only new agent events instead of the
whole list on every sync; a long reply that fails partway is re-posted from the start.

### Slice 3 (finished 2026-11-18)

**Shipped:** ilemberg/hippidy-bot pull requests 10 (plan, decisions, schema), 11 (write path),
12 (read path) and 13 (pinned actions, CI secrets kept to `main`). Checked live: a new
conversation's events, usage and cost are stored, its transcript reads back, reconcile
answers 200 every minute, and no conversation with a session is left unstored.

**What was learned:**

- **Re-planning from what exists cut the slice to about a third.** Four of the five exit
  criteria were already met. A view and one table replaced the four tables of the sketch, and
  the conversation loop's tables were not touched.
- **The test database is not the production client.** postgres.js stored a string bound to a
  `jsonb` parameter as a JSON string; PGlite alone does not, so every test passed while
  production held strings. It surfaced as empty note texts in a view nothing read yet.
  Anything touching JSON or number types now has a test through the production client.
- **A fix can open the next hole.** Storing payloads as real JSON meant a reply containing a
  null character would have blocked its thread for good. The independent review found it by
  running old and new code side by side. It found two must-fix problems in the write path
  and none in the read path.
- **Checking the SDK's types before designing paid off twice:** events change after they are
  first listed (so the log is "never deleted", not "never updated"), and Anthropic reports
  cost itself, in cents.
- **Migration first worked.** The schema merged and applied before any code used it. A second
  migration shipped with code, safely, because both old and new code read both forms.
- **One session carried four pull requests** by restarting its branch from `main` after each
  merge (decision 88). The friction of slice 2 did not come back.
- **The build session cannot see production.** It took eight screenshots from you to learn
  that the write path worked and the backfill did not, and why. The cause was a slice 2
  leftover nobody had noticed: Supabase had called `/v1/reconcile` every minute since slice
  2 and been answered 401 every time, because in Vercel the token had been saved under the
  wrong name. The safety net for lost webhooks was never on. The API said so in its log at
  every cold start (`config.reconcile_token_missing`), where nobody was looking. "Merged and
  green" had been standing in for "works".
- **Secrets end up in chat when the steps leave room for it.** Two tokens were pasted here
  while debugging and had to be replaced. The steps that worked kept the token in a shell
  variable, copied it without printing it, and compared fingerprints instead of values.
- **A repository secret is open to any workflow a pull request adds.** Protecting the agent
  sync's dry run, as planned, would not have closed that. The secrets now belong in an
  environment only `main` may use, which needs your hands to finish.

**What changes for the next slices:**

- Every "done when" line gets a live check, written as the exact query or log search to run,
  and the slice does not close until it has been run (decision 96).
- Give the build session read-only eyes on production before slice 4: a Supabase or Vercel
  connector, or a read-only database role. From slice 4 the agent's work has to be checked
  against what actually happened.
- Slice 4's list of things carried in is in its section above.

**Carried forward:** read only new events (decision 95); the sync lease owner check; a long
reply that fails partway is re-posted from the start; lazy-load Bolt; Dependabot alerts.

**Done by hand to close the slice:** a new reconcile token, saved as `RECONCILE_TOKEN` in
Vercel (Production) and as `hippidy_reconcile_token` in Supabase Vault, then checked three
ways: the API called directly with the token, Supabase's own record of its calls, and the
count of conversations left unstored.

**Still to do by hand:** move the CI secrets into the `release` environment before slice 4;
update and reinstall the Slack app so the bot gets the sender's name (both in the README).

### Slice 4 (finished 2026-11-19)

**Shipped:** ilemberg/hippidy-bot pull requests 16 and 17 (plan, revised), 18 (the
experiment), 19 (lease owner column), 20 (a CI log probe), 21 (the loop for long turns), 23
(the repo, the sandbox and GitHub), 24 (read only new events), 25 (done means green CI, and
the skill), 26 (progress notes, eval cases) and 27 (a Vercel build fix). Demo done, for real
rather than the planned 🫡: in Slack, "can you add a /status route" got a clarifying
question, then pull request 28 with CI green, its link in the thread and ✅; "can you merge
this" was refused; the owner merged it and
production `/status` answers 200. The session cost $0.75 for 7 active minutes over four turns.

**What was learned:**

- **The bot built a real feature of itself end to end on its first try.** It asked before
  building (the prompt's "ask one short clarifying question"), and that question changed the
  design: public, with no reasons in the response (decision 134).
- **The experiment paid for itself again.** About $1 settled the questions of "Experiment
  first" (decisions 127 to 129) and dropped the grader (132): it caught nothing, cost about $0.33 a question and
  changed what the thread read.
- **"Merged and green" still is not "works".** D merged green and the production deploy
  failed on Vercel's type check (`Response` is empty there), so Vercel kept serving B2 until
  27. CI's Vercel-like check did not catch a global `Response` read through a parameter type.
  It was found by looking at the deployment, not by a test.
- **The agent cannot see production.** Asked "make sure it's working" after the merge, it
  could not reach `*.vercel.app` and said so plainly, with the command to run. Decision 157
  (one more allowed host) is the answer for 5C; until then the check is a person's.
- **The record carried the close.** Every "done when" line that could be checked was
  checked from the database and Vercel by the build session, with no screenshots (the slice 3
  retro asked for exactly this). The eval-case view already links requests to pull requests.
- **Size is not a worry yet.** A coding session is about 150 events and 220 kB of
  `agent_events`; the database went from 13 to 14 MB.
- **A second reviewer checked this close against the record**, and found two "done when"
  lines marked done on weaker evidence than they claimed: the follow-up, and the date of
  the last rejected reconcile call. Checking a close is worth an independent pass too.

**What changes for the next slices:**

- Four "done when" lines need a person in Slack (a failing check, a follow-up on an open
  pull request, a stop mid-turn, a turn past 30 minutes); they are written as one message each in `slice-4.md` and run before 5A
  depends on them.
- A deploy is not done until Vercel has built it: the production check of decision 157 waits
  for the deployment's success, which would have caught D.
- The plan for slice 5 (`projects.md`, 5A to 5C) starts with the Atlassian probe (159).

**Carried forward:** a long reply that fails partway is re-posted from the start; lazy-load
Bolt; Dependabot alerts; the GitHub token's expiry date (README).

### Slice 5A (built 2026-11-19; wave 1 closed 2026-11-25)

**Shipped:** ilemberg/hippidy-bot pull requests 34 and 35 (the schema and routes for
projects, roles and approvals), 37 (reading the thread), 38 (role and project told to the
agent), 40 to 43 (custom tool calls, the product agent and routing), 46 (Jira and
Confluence) and 47 (several roles for one person); the Atlassian probe in 30, 33, 39, 44 and
45. The demo ran in Slack on 2026-11-19, with the owner in both roles: the bot created the
project Dashboard v1, wrote its plan in Confluence over four versions, recorded the plan's
approval, created the epic SCRUM-6 with six tickets, and recorded the roadmap's approval.

**What was learned** (read from the record of that thread on 2026-11-20):

- **The bot plans well.** It read the repo first and grounded the plan in what exists: the
  read routes, the progress notes, decision 22. It named the real gaps (no web app, no way to
  accept a signed-in person, no record of which ticket a thread works on).
- **The approval chain cost more than it protected.** The thread ran for almost four hours
  and $2.88, and took three approval messages. The owner had to be given a second role to
  approve alone (decision 170). It ended with a frozen plan, seven Jira issues and no code.
- **Recording is not moving.** After both approvals the bot said the project "should now
  move" to `ship`; in the database its stage is still `plan`, because nothing moves it (146).
- **Questions for engineering had no owner.** The plan left the stack and sign-in "for
  engineering to settle", and nobody was asked.
- **The next step it asked for was a new thread per ticket**, started by one of four roles,
  each mention by hand.
- **A project is created by name with no check for one that exists.** Two projects named
  Dashboard v1 are in the database, from an earlier test thread and from the demo.
- **Atlassian's server has gaps.** The bot cannot comment on a Confluence page (171).

**What changes for the next slices:** the direction. hippidy-bot becomes the team layer:
no stages, no approvals, one agent, everyone trusted, and a shared memory of decisions
(decisions 172 to 180, `team-layer.md`). Wave 2 is planned in `wave-2.md`.

**Carried forward:** 5A's "done when" lines were not checked one by one at this close; the
demo is the evidence. Slice 4's four live checks in Slack are still owed (decision 160). The
second Dashboard v1 project is left as it is. The probe of decision 150 (Chromium in the
sandbox, files out of a session) is still to run, and now blocks slice 4.3.
