# Wave 3: who owns what, who waits on whom

Status: **planned 2026-11-25 (decisions 205 and 206).** Wave 2 is in `wave-2.md`; the
direction in `team-layer.md`. G12, G13, G14 and G19 are answered (205).

**Goal:** the right person hears about the right thing. Wave 2 gave the team one memory of
what it decided; wave 3 gives that memory owners, and tells each person what is theirs.

## Where wave 2 ended

- Every thread has a teammate; changes go to a coding worker through a brief (2.1).
- Decisions are recorded, recalled and cited; a proposal is confirmed by someone who wrote in
  its thread (2.2, 2.6, G11).
- The web app signs people in with Slack and shows the agents at work, what listening found,
  and the decisions, by area (2.3 to 2.6).
- An area is still only a free label on a decision. Nobody owns anything, and the latest
  message in a thread still wins by default.

## Rules that hold in wave 3

The rules of `wave-1.md` and `wave-2.md` stay. Added:

10. **Every area has one owner, or the fallback.** The fallback is the owner of the project
    (`FALLBACK_OWNER` in the API's configuration), for anything in no area or in an area with
    no owner (G12).
11. **The record does not change under a disagreement.** When two people's direction
    conflicts, the active decision stands until the owner decides; the latest message does not
    win by default (G12).
12. **The bot tells; it does not act for a person.** A brief says what touched your areas and
    what waits on you; it never posts, approves or replies in a shared space in your name
    (G13).
13. **One brief a day, at most.** Attention has a budget, like money (`team-layer.md`). A
    brief with nothing in it is not sent.

## Slices

| # | Slice | Demo | Needs |
|---|---|---|---|
| 3.1 | Areas, owners and routing | A brief that touches the search code says so in its thread and names the owner of search, who is mentioned there; a proposed decision in an area names its owner, who may confirm it | `areas` with owners, code paths and words; a page to manage them; matching on briefs, pull requests and decisions |
| 3.2 | Conflict surfacing | Someone asks the bot to change a decision another person made; the bot says it conflicts with decision N, asks the owner in the thread, and the record keeps decision N until the owner confirms the change | A `raise_conflict` tool; open conflicts kept and shown; only the owner (or the fallback) confirms a proposal that replaces an active decision in their area |
| 3.3 | Tasks and the waiting-on list | One task page in the web app shows Jira's issues (or the built-in tracker's) the same way, beside who is waiting on whom | A task provider interface in the API with Jira (REST, its own credential) and a built-in tracker; `waits` kept by a `record_wait` tool and the web app; a thread linked to its task (SCRUM-8) |
| 3.4 | Daily briefs by direct message | At 9:00 in their time zone, each person gets one message: what touched their areas, what waits on them, what they may confirm or decide | Direct messages (decision 36 deferred them); a brief built from the records with no model; "stop briefs" and "start briefs"; the brief run from reconcile |

Order: 3.1 first, since every other slice routes by area. 3.2 and 3.3 do not depend on each
other and can run side by side. 3.4 last, since a brief reads what the other three record.

## Slice 3.1

Planned in detail in `slice-3-1.md` (decision 206).

## Slice 3.2

Planned in detail in `slice-3-2.md` (decision 208). The outline it came from:

- **Finding a conflict.** No new model call. The teammate already sees the decisions that bear
  on a message; it is told to call `raise_conflict` when what someone asks for contradicts an
  active decision, or when two people in the thread want opposite things. Capture's prompt
  also gets the active decisions near a thread and flags a proposal that contradicts one.
- **What the API does.** Records the conflict (the decisions involved, the two positions, who
  holds each, the area), posts in the thread naming the area's owner (or the fallback), and
  marks a proposal that would replace an active decision so that only that owner may confirm
  it. The conflict closes when the owner confirms or rejects, or says so in the web app.
- **Shown** on the decision's page and in a list of open conflicts; 3.4 puts them in the
  owner's brief.

## Slice 3.3

Planned in detail in `slice-3-3.md` (decision 210). The outline it came from:

- **One home per kind (178).** `TASK_PROVIDER` is `jira` or `builtin`. Both are built behind
  one interface (list, read, link a thread), so the web app's task page is the same for both.
- **Jira** is read through its REST API with a credential of the API's own, not the agent's
  vault. The agent keeps its Atlassian tools (rule 4 of `wave-1.md`).
- **Waiting-on is ours (178):** who waits on whom, for what (a task or a sentence), since when,
  where it was said. Recorded by the teammate's `record_wait` tool and in the web app; ended by
  either.
- **A thread's task** (SCRUM-8): the teammate links a thread to the task it works on.

## Slice 3.4 (outline)

- **Direct messages.** The manifest gains the `im` scopes and `message.im`. Writing to the bot
  in a direct message stays as today (a mention is not needed there); "stop briefs" and "start
  briefs" are commands, like "stop".
- **Who gets one:** everyone who has written to the bot, owns an area, or is waited on, unless
  they said "stop briefs" (G13). At about 9:00 in their Slack time zone, on weekdays.
- **What is in it**, built from the records without a model: decisions recorded or proposed in
  their areas since the last brief; changes and pull requests that touched their areas; what is
  waiting on them; proposals they may confirm; conflicts they are to decide. Each line links to
  its thread or page. An empty brief is not sent.

## By hand, the owner's

- Before 3.1: set `FALLBACK_OWNER` (your Slack user id) in the API's Vercel project.
- Before 3.3: a Jira credential for the API, if Jira is the task home.
- Before 3.4: update the Slack app from its manifest and reinstall it, for direct messages.

## Not in wave 3

- Standing jobs with their own records, the checker and feature goals (wave 4).
- Acting for a person in shared spaces (G13).
- More than one workspace, repository or team (wave 5).

## Retros

Appended after each slice.
