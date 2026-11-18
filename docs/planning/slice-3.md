# Slice 3: Supabase as the record

Status: **built and deployed 2026-11-18; not closed yet.** Pull requests A to D are merged
(ilemberg/hippidy-bot 10 to 13). Two live checks are open, both yours: see "Open before the
slice closes" below. Reading only new events (pull request E) is carried forward to slice 4
(decision 95). Retro in `wave-1.md`.

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
| E | Read only new events | Carried forward to slice 4 (decision 95) |
| - | Close: retro, re-sketch slice 4 | All of the above |

## What you will need to do by hand

| When | Step |
|---|---|
| After A merges | Check the "Database migrations" workflow went green. Nothing else: no new secrets |
| After B deploys | Ask the bot something, then look at `agent_events` and `conversation_transcript` in the Supabase table editor |
| For D | Create the `release` environment in GitHub, restrict it to `main`, and move the four CI secrets into it (README, "Slice 3 setup: keep the CI secrets to `main`") |
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

## As built (pull request B)

- Decision 89: storing sits beside the loop and never fails it. `agents/` and the contract are
  unchanged; the only visible difference is `backfilled` in the reconcile route's answer.
- Usage is read from the session object after the deliveries have gone out and the
  conversation's lease is released, so it never delays an answer, the next sync or a stop.
  The "verify" above (usage events in the history) did not need answering.
- Backfill: three conversations per reconcile run, picked at random so one that keeps failing
  cannot hold up the rest. A session Anthropic no longer has is marked as visited. A
  conversation younger than ten minutes is left to its own first sync.
- After the independent review (decision 91): two must-fix findings and five smaller ones,
  all addressed except the two listed under known limits. The worst: once payloads were
  stored as real JSON, a reply containing a null character would have blocked its thread for
  good. Text Postgres cannot hold is now cleaned before anything is stored.
- The transcript view gained a `position` column to break ties: order by
  `(occurred_at, recorded_at, position)`.
- Found on the way (decision 90): the production client stored delivery payloads as JSON
  strings, so the transcript view from pull request A showed no text for notes. Fixed by a
  second migration (`20261118000500_transcript_notes.sql`) and a cast in the SQL. The tests
  that matter for this now run through the production client, not PGlite alone.
- Known limits, accepted for now:
  - Every sync still reads the session's whole event list (pull request E). Events that have
    not changed are no longer written again.
  - An event that cannot be stored for a reason not yet seen fails its batch of 200. The
    conversation is then retried by the backfill every minute, with an error in the log, and
    there is no cap on those retries.
  - A sync that runs longer than its 120 second lease can release a lease another sync has
    taken since. This was already so in slice 2; not changed here.
  - Usage is read at each sync, so the last turn's figures can lag until the next sync of
    that conversation.
  - The fake agent's clock in tests is not the messages' clock, so tests do not show a
    realistic interleaving of people and agent in the transcript.

## As built (pull request C)

- Decision 92: three read routes (list, one conversation with transcript, raw events), with
  their shapes in `packages/contracts/src/conversations.ts`. No migration.
- The proof of the demo is a test: a conversation is built, then read through the API as
  deployed with an agent runtime whose every call fails.
- Counts are stored as `bigint`, which the production client returns as strings; the reads
  cast them, and a test runs the reads through the production client.
- The independent review found nothing that had to be fixed. Its smaller points are in
  decision 93; the tests now also show people and agent interleaved in a transcript.
- Known limits, accepted for now:
  - A transcript is returned whole, not in pages, and an event page has no size budget in
    bytes. Fine for chat threads; revisit in slice 4, when tool output makes both large
    (Vercel limits a response to a few megabytes).
  - Events are paged in the order they were first stored, which is not always the order they
    happened in: a message queued during a turn is stored ahead of the rest of that turn.
  - No index serves the two listings yet. Fine at this size.
  - Times in the API are to the millisecond (JavaScript dates); the database keeps
    microseconds and orders by them.

## As built (pull request D)

- Decision 94: actions pinned by commit; the secret-using jobs run in the `release`
  environment. This goes further than "protect the agent sync": the same weakness applied to
  the Supabase secrets, and a protected dry run would not have closed it.
- The workflows work before and after the manual steps: until the environment's secrets
  exist, GitHub falls back to the repository secrets.
- By hand (README, "Slice 3 setup: keep the CI secrets to `main`"): create the environment,
  restrict it to `main`, add the four secrets, delete the repository ones. The protection only
  holds once the repository secrets are deleted.

## Open before the slice closes

Checked live on 2026-11-18, after the write path deployed: events, usage and cost are stored
for a new conversation, the transcript reads correctly, and no note has an empty text. Two
things were not right, and neither is in this slice's code:

- **The slice 2 conversation was not backfilled**, and the log shows no backfill line of any
  kind. The backfill runs from `/v1/reconcile`, so the likeliest cause is that Supabase is
  not calling it (missing Vault secrets, or a token that does not match). If so, the safety
  net for lost webhooks is not running either. To check: in Vercel's logs, look for one
  `POST /v1/reconcile` a minute; in Supabase, the query in the retro's "to do" list.
- **The bot does not know the sender's name** (`actor_name` is null). Most likely the Slack
  app was not updated and reinstalled after slice 2's "names and stop" (README).

The slice closes when the first is fixed and the backfill has run (`not_yet_stored` is 0).
The second is slice 2's and does not hold the slice.

Also yours, any time before slice 4: move the CI secrets into the `release` environment
(README, "Slice 3 setup: keep the CI secrets to `main`").

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
