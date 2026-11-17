# Wave 1: minimum setup

Goal of the wave: `@hippidy-bot` in Slack can take a request, change this repository through a
cloud agent, and get that change merged with enough automated checking that it does not need a
human to read every diff. After slice 4, hippidy-bot is developed through hippidy-bot.

Only the next slice is planned in detail. Everything after it is a sketch and will be rewritten.

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
   the product direction (software factory, AI employee, or knowledge and task system) is not
   decided yet and those are the parts that would change.

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

Decide before starting: questions B1 to B8.

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

## Slice 5: work from a ticket instead of a sentence

**Demo:** `@hippidy-bot pick up HB-12`. The agent reads the ticket and linked docs, does the
work, opens the PR, and updates the ticket.

Sketch: a work-item provider and a knowledge provider behind interfaces, each backed by an
MCP server where one exists. Candidates and tradeoffs are in `stack-and-tools.md`. The opinion
to form by then: for each system, is the agent the only writer, a collaborator, or read-only.

Decide before starting: questions E1 to E5.

## Slice 6: auto-merge with confidence

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
- Multiple agents or agent personas.
- More than one repository or more than one Slack workspace.

## Retros

Appended after each slice: what was learned, what changed in the slices that follow.
