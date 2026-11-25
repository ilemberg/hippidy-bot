# Slice 2.2: decisions, stored, recalled and cited

Status: **started 2026-11-25 (decisions 190 to 193). Parts A and B are in ilemberg/hippidy-bot 51; C to E are built and wait for review.** The wave is in `wave-2.md`; the
direction in `team-layer.md`, "Its records".

**Demo:** in one thread someone says "we'll use Postgres full-text search, not a vector store;
record that". In another thread, a different person asks how search should work. The bot
answers from the decision and cites it: who decided, when, and a link to the message.

## What it needs

| Part | What | Live behaviour changes? |
|---|---|---|
| A | **Schema**: `decisions` (below), with a full-text index. Additive (86) | No |
| B | **Seed**: `pnpm decisions:seed` turns `decisions.md` into a migration of active decisions, origin `decisions.md`, reference the entry's number (191) | No: nothing reads them until C |
| C | **The API**: the custom tools `record_decision` and `recall_decisions`; the decisions that bear on a message put before it; the Confirm route; `GET /v1/decisions` | No: no agent has the tools until E |
| D | **Slack**: a recorded decision posted in the thread, with a Confirm button when it is proposed | No: nothing posts one until E |
| E | **The teammate**: the two tools and how to record and cite | **Yes**: every teammate thread |

## A decision

- **Statement:** one sentence, at most 500 characters: what was decided.
- **Reason:** why, at most 2,000 characters; optional.
- **Area:** a free label (`search`, `slack`, `billing`) until wave 3 gives areas owners.
- **Status:** `proposed`, `active`, `superseded` or `rejected`. A decision that replaces another
  names it, and the old one becomes `superseded` when the new one becomes active.
- **Who decided:** a person (source, workspace, id, name). Imported decisions name the owner as
  "the owner" with no id.
- **When:** the time it was decided; for an import, the entry's date.
- **Where:** the thread and the message it was decided in, or the origin and reference of an
  import (`decisions.md`, `172`).
- **Who confirmed it, and when**, for a proposal that became active.
- Keyed on the call that recorded it, so answering the call again records nothing twice (167).

## The rules (192)

`record_decision` is the teammate's custom tool: statement, reason, area, the Slack user id of
who decided, whether they asked for it to be recorded, and the decision it supersedes, if any.
The API decides the status:

- **Active** only when all hold: the person who decided is the sender of the message the turn
  is answering (as `start_change` finds who asked); the agent says they asked for it to be
  recorded; and the session read nothing untrusted before the call (the start rule of 181
  and 189).
- **Proposed** otherwise. The API posts it with a Confirm button; anyone in the workspace may
  press it until slice 2.6 (G11). Confirming records who and when, and makes it active.

The decided-by person must have written in the thread (`hasWrittenInConversation`), as
approvals were checked.

## Recall and citing

- **Before each message**, the teammate gets up to five active decisions that match the
  message's text (Postgres full-text search, no model), as lines after
  `Decisions on record that may bear on this:`, each with its number in the table, who, when
  and its link. No model runs to pick them; the list may miss one or include one that does not
  matter.
- **`recall_decisions`** searches active decisions by words and area, at most 20, for the
  agent to look further.
- **Citing:** the teammate names a decision it relies on, with who decided it and when, and
  links it. It says so when the record and a person in the thread disagree, and does not
  override the record on its own.

Decisions are data the team confirmed, so they are given to the agent as information, like the
thread, not as instructions.

## Done when

Each line gets its query before its pull request merges (96).

- The seed holds every entry of `decisions.md`, active, with its number.
- A decision recorded at the asker's request in one thread is active, with who and the message.
- A thread that read a ticket first records only proposals; Confirm makes one active and names
  who confirmed it.
- Asked in a second thread by a different person, the bot cites the first thread's decision.

## Not in 2.2

- Editing, rejecting and browsing decisions by area: the wiki, slice 2.6.
- Areas with owners and conflicts between decisions: wave 3.
- Proposals from listening in channels: slice 2.5.
