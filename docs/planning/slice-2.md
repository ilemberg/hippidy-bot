# Slice 2: talk to one managed agent

Status: **drafted after slice 1, not started.** Six questions are answered (decisions 51 to 55); seven are still open.

**Demo:** mention `@hippidy-bot` with a question. 👀 appears at once. Within a minute or so the
bot replies in a thread under your message, and 👀 becomes ✅. Reply in that thread (mentioning
the bot) and it answers with the earlier context. The agent has no tools and no repo.

Facts marked *verify* come from the Managed Agents docs as summarized in `wave-1.md` and are
checked against the current docs and SDK when the slice starts.

## How a message flows

```
Slack ─▶ adapter ─▶ POST /v1/messages ─▶ store inbound event (dedupe)
                                        ├─ thread has a session? ─ no ─▶ start session
                                        └─ send the message to the session      (202, 👀)

Anthropic ─▶ POST /v1/webhooks/agent (session idle) ─▶ fetch new agent events since cursor
                                        └─▶ deliver reply (once) ─▶ Slack adapter posts in thread, ✅

Scheduled reconcile ─▶ sessions waiting too long ─▶ same fetch-and-deliver path, or ❌ after a limit
```

The API stays channel-agnostic in both directions: it knows conversations, messages and
deliveries. Posting to Slack is done by the Slack adapter, behind a delivery interface the API
defines (decision 53).

## What gets built

### Agent

- One agent and one environment, defined as files in the repo (`agents/hippidy/`): system
  prompt, model (Claude Opus 5.5, decision 20), no tools. Synced to Anthropic by a script, so
  prompt changes go through pull requests (B7). *Verify* the current sync tool (`ant` CLI or the
  SDK).
- The system prompt tells the agent who it is, that it is talking in Slack, and how to address
  people (by name, from the sender lookup below).
- An `AgentRuntime` interface in the API (`start`, `send`, `interrupt`, `fetchEventsSince`), with
  Managed Agents as the only implementation and a fake for tests.

### Storage (decision 8: minimal)

Supabase Postgres, only what Vercel needs to remember between requests:

| Table | Holds | Unique on |
|---|---|---|
| `inbound_events` | Every accepted inbound message | `(source, source_event_id)` and `(source, workspace, channel, message_id)` |
| `conversations` | One per thread: source ids, agent session id, agent version, status, event cursor | `(source, workspace, channel, thread_id)` |
| `deliveries` | Each reply sent back, with status | `(conversation_id, agent_event_id)` |

Duplicate inbound events are acknowledged and ignored, which replaces slice 1's "drop retries
after a timeout" with real deduplication. Slice 3 adds `messages` and `agent_events` (the full
record).

### API

- `POST /v1/messages` (exists): now stores the event, finds or starts the session, sends the
  message, returns 202. Same contract; the response may gain the conversation id.
- `POST /v1/webhooks/agent`: receives Anthropic's "session idle" webhook, checks its signature,
  then fetches new agent events since the conversation's cursor and delivers each new agent
  message exactly once.
- `POST /v1/reconcile` (service token): for conversations waiting longer than a threshold,
  runs the same fetch-and-deliver; after a hard limit, marks them failed so ❌ is shown. Called
  about every minute by Supabase `pg_cron` (decision 54).
- Two messages in quick succession: the second is sent only when the session is idle again,
  so answers come back in order. *Verify* whether a session accepts a message while it is
  running; if it does not, the API queues it in `conversations`.
- Per-session budget cap of about $2 (decision 55).

### Slack adapter

- Implements the API's outbound delivery interface: post a reply in the thread, then set the
  reaction on the user's message (👀 received, ✅ answered, ❌ failed).
- Converts the agent's Markdown to Slack's format and splits long replies.
- Looks up the sender's display name (adds the `users:read` scope and a reinstall; decision 34)
  and passes it in the message, so the agent can address people.

### Tests

- The whole flow against a fake `AgentRuntime` and a fake Slack, including: a webhook
  delivered twice posts once; a lost webhook is repaired by reconcile; two quick messages are
  answered in order; a failure shows ❌.
- Database logic against PGlite, a real Postgres in-process, so tests need no Docker (decision
  17). Migrations applied from scratch in each test run.

## What you will need to do by hand

| When | Step |
|---|---|
| Before work starts | Answer the questions below |
| Early | Create a Supabase project (free tier) and give its database URL to Vercel, Production only |
| Early | Create an Anthropic API key for this project, set a monthly spend limit on its workspace (decision 55), and add the key to Vercel |
| After the agent PR | Point Anthropic's webhook at `https://hippidy-bot.vercel.app/v1/webhooks/agent` and add its signing secret to Vercel |
| After the Slack PR | Reinstall the Slack app for the new `users:read` scope |

## Decide before starting

Each question has a recommendation; "go with your picks" is a valid answer. B2 to B9 are in
`open-questions.md`; B10 to B14 are new from slice 1.

| # | Question | Recommendation, or the answer |
|---|---|---|
| B2 | What is one conversation? | **Decided** (51): one Slack thread = one conversation = one agent session. A top-level mention starts a new one |
| B3 | Must replies in a thread mention the bot? | **Decided** (52): yes, at first |
| B4 | Backup for lost "finished" webhooks | **Decided** (54): a scheduled reconcile, as in the plan above |
| B5 | Final answer only, or progress? | Final answer only, with reactions as status |
| B6 | Cost cap | **Decided** (55): about $2 per session, plus a monthly spend limit on the Anthropic workspace |
| B7 | Agent prompt and config | Files in the repo, synced by script, changed by pull request |
| B8 | Open threads when the agent changes | Accept that old threads keep the old version; record the version per conversation |
| B9 | Can you stop it? | A "stop" reaction (🛑) on the user's message sends an interrupt. Small; could slip to slice 3 |
| B10 | How does the API post back without knowing Slack? | **Decided** (53): the API defines a delivery interface keyed by source; `compose.ts` registers the Slack implementation; the API calls it in-process |
| B11 | What runs the reconcile on a schedule? | **Decided** (54): Supabase `pg_cron` calls `/v1/reconcile` about every minute. Vercel's free plan limits cron jobs (*verify*) |
| B12 | Migrations: Supabase CLI or Drizzle, and who applies them? (C2, C4 pulled forward) | Supabase CLI migrations with generated types, applied by CI on merge to `main`, never by hand |
| B13 | Supabase environments (C3 pulled forward) | One hosted project for production; PGlite for tests; no separate dev project yet |
| B14 | Testing split details (decision 17 said "revisit before implementing") | Unit and database tests (PGlite) run everywhere; CI also builds and smoke-tests as now; no Docker yet |

## Done when

- The demo above works in Slack, including a follow-up in the thread.
- A reply always arrives, or ❌ is shown. Removing a webhook delivery by hand is repaired by
  reconcile.
- Two quick messages in one thread are answered in order.
- A webhook delivered twice posts once.
- A Slack event delivered twice starts one session.
- Lint, typecheck, tests and the Vercel build check pass in CI.

## Not in this slice

Tools for the agent, the repo mount (slice 4), the full record of messages and agent events
(slice 3), live progress updates, the UI.
