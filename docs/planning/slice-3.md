# Slice 3: Supabase as the record

Status: **started 2026-11-18.** Pull request A (this plan, the decisions and the migration) is
the first step. Nothing that writes or reads the record is built yet.

**Demo:** ask `@hippidy-bot` a question and get an answer, as in slice 2. Then read the whole
conversation back from the API with Anthropic out of the picture: who wrote what, what the
agent answered, every raw agent event, and what the session cost.

## Where slice 2 left things

Slice 2 built more of this slice than planned, so it was re-planned from what exists (retro in
`wave-1.md`).

| Wave 1 exit criterion for slice 3 | State |
|---|---|
| Schema lives in migrations and is applied by CI | Done in slice 2 (decision 61) |
| Only the API can reach the database; row level security on, no policies | Done in slice 2 |
| The reconcile job repairs a conversation whose webhook was dropped | Done in slice 2 (decision 54) |
| Database tests run without Docker | Done in slice 2 (decision 62) |
| A conversation can be reconstructed from the database alone | **Not yet: this slice** |

What is missing today:

- **Agent replies** are stored only as a side effect, inside the outbound delivery queue.
- **Agent events** are not stored at all. The runtime keeps six event types and discards the
  rest (tool use, thinking, model requests, usage).
- **Cost and token usage** are not recorded, though the success measure (decision 10) and the
  model choice (decision 20) both depend on measured cost per session.

## Facts checked in the SDK (`@anthropic-ai/sdk` 1.10.0)

- An event has an id, a type and `processed_at`. There is no separate created time; lists are
  ordered and filtered by `processed_at`.
- **An event can change after it is first listed.** A `user.message` has no `processed_at`
  while it waits in the session's queue and gains one later. So the event log is "never
  deleted", not "never updated": writers upsert on the event id.
- A session reports cumulative usage (tokens, active seconds, list cost) on the session
  object, and as periodic `session.usage` events. Money is an integer string in minor units
  ("50" is fifty cents).
- *Verify in pull request B:* whether `session.usage` events appear in the event history or
  only on the live stream. If not, usage is read from the session object.

## What gets built

### Storage (pull request A, migration `20261118000400_record.sql`)

| Object | Holds |
|---|---|
| `agent_events` (new table) | Every event of a conversation's agent session: the runtime's id and type, the raw payload, and what the API makes of it (`kind`, and `text` for an agent message). Unique on `(conversation_id, event_id)` |
| `conversations` (new columns) | Cumulative usage (tokens, active seconds, list cost), the budget the session started with, and when its events were last stored |
| `conversation_transcript` (new view) | One conversation as people saw it: what they wrote, what the agent answered, the notes the API posted. Built from `inbound_messages`, `agent_events` and `deliveries`, so it cannot drift from them |

No `messages` table and no `agent_sessions` table (decisions 77 and 78). `inbound_messages`
and the conversation loop's settling logic are not touched.

### Write path (pull request B)

- `AgentRuntime.listEvents` returns every event, with its raw payload, type and processed
  time, not only the six kinds the API acts on.
- Each sync stores the events (upsert) before acting on them. The loop's decisions stay as
  they are; storing is added beside them.
- Usage is recorded on the conversation at each sync, and the budget when the session starts.
- Backfill (decision 80): reconcile also picks up a few conversations per run that have a
  session but were never stored (`agent_events_synced_at` is null), and marks them done even
  when Anthropic no longer has the session, so it does not try for ever.

### Read path (pull request C)

- Contract first: a conversation summary and a transcript in `packages/contracts`.
- `GET /v1/conversations` (recent first) and `GET /v1/conversations/:id` (summary, usage and
  transcript), behind the service token.
- A test rebuilds a conversation with the agent runtime switched off: the proof of the demo.

### Housekeeping (pull request D, decision 82)

- CI actions pinned by commit, not by tag.
- The agent sync runs in a protected GitHub environment, so a pull request's own script never
  runs with the Anthropic key without approval.

### Read only new events (pull request E, decision 81)

Only if the write path landed clean. Sync reads events processed since the newest one stored,
instead of the whole list. Carried forward otherwise.

## Order of work

Each pull request is its own session and branch (decision 83). The migration merges before any
code that uses it: the rule slice 2 broke once.

| # | Pull request | Depends on |
|---|---|---|
| A | Plan, decisions, migration and schema tests | - |
| B | Write path and backfill | A merged and applied |
| C | Read path | B |
| D | Housekeeping | Nothing; any time |
| E | Read only new events | B, and only if B was clean |
| - | Close: retro, re-sketch slice 4 | All of the above |

## What you will need to do by hand

| When | Step |
|---|---|
| After A merges | Check the "Database migrations" workflow went green. Nothing else: no new secrets |
| After B deploys | Ask the bot something, then look at `agent_events` and `conversation_transcript` in the Supabase table editor |
| For D | Create the protected environment in GitHub and move `ANTHROPIC_API_KEY` into it (steps will be in the README) |
| Any time | Still open from slice 2: check names and stop live |

## Decisions

All answered on 2026-11-18 ("go with your picks").

| # | Question | Answer |
|---|---|---|
| C1 | What is the source of truth when Anthropic also keeps session history? | **Decided** (75): Supabase owns conversations and messages; raw agent events are kept as a log |
| C2 to C5 | Schema tooling, environments, who applies migrations, tests without Docker | Already answered in slice 2 (decisions 61 to 63 and 65) |
| C6 | Retention | **Decided** (76): keep everything for now |
| C7 | A `messages` table, or a view? | **Decided** (77): a view |
| C8 | Split `agent_sessions` out? | **Decided** (78): no; usage columns on `conversations` |
| C9 | Read routes, or SQL only? | **Decided** (79): two read routes, plus the view for the table editor |
| C10 | Backfill slice 2 conversations? | **Decided** (80): yes, through reconcile |
| C11 | Read only new events? | **Decided** (81): yes, last, and only if the write path lands clean |
| C12 | Do the "before slice 4" housekeeping here? | **Decided** (82): yes, as its own small pull request |
| C13 | One branch per pull request | **Decided** (83): a fresh session per pull request |

## Done when

- The demo works: a conversation is read back through the API with the agent runtime off.
- Every event of a session is in `agent_events`, including the ones the API does not act on.
- A conversation's usage and list cost can be read from the database.
- Slice 2's conversations are backfilled, as far as Anthropic still has them.
- Lint, typecheck, tests and the Vercel build check pass in CI.

## Risks

- **Events that change.** Covered by upserting (see the facts above). It is also why reading
  only new events is a separate, last step: a filter on processed time must not miss a
  message that was queued when it was first seen.
- **Storage size.** Raw events are small now. Slice 4's tool output will be large against the
  free plan's 500 MB; retention (C6) is revisited then.

## Not in this slice

Tools or a repo for the agent (slice 4); the UI; live progress updates (decision 57); raw
Slack payloads; a work-item table; deletion or retention tooling; the fix for a long reply
being re-posted from the start after a partial failure (still carried forward).
