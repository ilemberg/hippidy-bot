# Slice 3: Supabase as the record

Status: **drafted after slice 2, not started. The questions below need answers first.**

**Demo:** pick any Slack conversation with the bot and read it back from the API alone, in
order: who said what, what the agent replied, which agent version answered, what it cost, and
how each message ended (✅ ❌ 🛑). Nothing is fetched from Slack or Anthropic to do it.

## Where slice 2 left us

Slice 2 built more of the storage than planned (decisions 8, 61 to 70):

| Already there | Still missing for the record |
|---|---|
| `conversations`: thread, session, agent version, status | What each conversation cost (`usage.list_cost`), turns, timings |
| `inbound_messages`: every human message, deduplicated, with sender and outcome | The agent's replies as messages (today only as delivery payloads) |
| `deliveries`: everything sent back, with status and attempts | The agent's raw events (thinking, errors, idles), kept append-only |
| Migrations applied by CI; tests on PGlite; no Data API access | A way to read a conversation back; backups; a retention rule |

So slice 3 is smaller than its sketch in `wave-1.md`: record the agent's side, record cost,
add a read-back route, and decide backups and retention.

## What gets built (draft)

- **`messages`**: one row per message in a conversation, human or agent, in order, channel-
  agnostic (`role`, `actor`, `text`, `created_at`, link to the inbound message or the agent
  event). Human rows come from `inbound_messages`; agent rows from `agent.message` events.
- **`agent_events`**: the raw events of each session, append-only, unique on event id, stored
  as JSON. Written by the existing sync, which already reads them; it can then read only new
  events (`created_at[gt]`) instead of the whole list each time (a known limit from slice 2).
- **Cost**: `usage.list_cost` and active time recorded per conversation after each turn, so
  the wave 1 success measure "cost per merged change" (decision 10) has data from day one.
- **Read-back**: `GET /v1/conversations/{id}` (service token) returning the conversation and
  its messages in order, as a contract in `packages/contracts`. The UI uses it later.
- **Backfill**: one migration that turns slice 2's existing conversations into `messages`
  rows from what is stored.

## Decide before starting

| # | Question | Recommendation |
|---|---|---|
| C1 | What does "source of truth" mean when Anthropic also keeps session history? | The API's own tables are the truth for conversations and messages; Anthropic's raw events are copied append-only into `agent_events` so nothing is lost if a session is deleted there |
| C6 | Retention and privacy: how long are messages and events kept? Names are stored since slice 2 | Keep everything for now. Every row already carries source, actor and conversation, so deleting by person or by channel is one query when it is needed. Revisit if anyone else joins the workspace (decision 12) |
| C7 | Backups. The free plan has none, and from this slice the database is the record | Weekly is enough for now: a scheduled GitHub Action exports the database with the Supabase CLI and keeps it as an encrypted artifact for 30 days. The repo is public, so the export must be encrypted with a key kept in GitHub secrets. The alternative is Supabase Pro ($25 a month, daily backups), a quarter of the $100 budget |
| C8 | How is a conversation read back for the demo? | The `GET /v1/conversations/{id}` route above, plus a tiny script that prints a conversation as a transcript. No UI yet (decision 7) |
| C9 | Record the agent's thinking and tool events, or only its messages? | Everything Anthropic returns goes into `agent_events` (it is cheap); only messages go into `messages` |

C2 to C5 are already answered: Supabase CLI migrations with hand-written Zod row types
(decisions 61 and 65), one free project plus PGlite for tests (63), CI applies migrations
(61), no Docker (62).

## Carried over from slice 2

To do in this slice, because they get harder later:

- **Migrations before code.** Slice 2's last pull request added a column and used it in the
  same deploy. From now on a pull request that needs a schema change ships the migration
  first, and the code that uses it in a later pull request (or tolerates its absence).
- **Pin CI actions by commit** and move the agent sync behind a protected GitHub environment,
  before slice 4 lets the agent open pull requests.

## Done when

- The demo works for a real Slack conversation, including one with a stop and a failure.
- Deleting the Anthropic session does not lose the conversation's record.
- Backups (C7) run, and restoring one into a scratch project is tried once.
- The sync reads only new agent events.
- Lint, typecheck, tests and the Vercel build check pass in CI.

## Not in this slice

The UI, repository access for the agent (slice 4), work items (slice 5).
