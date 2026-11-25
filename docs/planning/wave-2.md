# Wave 2: one team, one memory

Status: **draft, 2026-11-25 (decision 180). Planning only; nothing has started.** The
direction is in `team-layer.md`; the decisions behind it are 172 to 180; what is open is in
`open-questions.md`, group G.

Goal of the wave: a small real team shares one bot and one memory, and can see what the bots
do. The team is the owner and the two or three people invited into the workspace (decision
175), and what they build is hippidy-bot itself.

Only the next slice is planned in detail. Everything after it is a sketch and will be
rewritten. Waves 3 to 5 are at the end, as sketches.

## Where wave 1 ended

Slices 1 to 4 and 5A are built and live. Wave 1 closed there (decision 179): 5B and 5C are
not built as designed, and slice 6 is parked. What carries over:

| From | Goes to |
|---|---|
| The walkthrough and the production check (5C; decisions 142, 157) | Slice 4.3 |
| The independent reviewer (slice 6; F3) | Slice 4.3 |
| Auto-merge, risk tiers and the eval suite (slice 6; F2, F4 to F6) | Parked; see "Deferred on purpose" in `decisions.md` |
| The Dashboard v1 plan and its tickets | Slices 2.3 and 2.4 (table in `team-layer.md`) |

## Rules that hold from wave 2 on

The four rules of `wave-1.md` stay. Added:

5. **Our records, their content.** Decisions, areas and owners, the waiting-on list and
   responsibilities live in the API's database. Tasks and documents sit behind a provider,
   and a team has one home for each kind, with no syncing between two homes (decision 178).
6. **The API talks to the provider.** The agent keeps its direct tools (rule 4), but what the
   web app shows comes through the API, so a page is the same whichever system is behind it.
7. **Visible and correctable.** Everything the bot knows or does can be seen and corrected in
   the web app.
8. **Paired.** A change to how people work with the bot ships with the page that shows it.
9. **A weekly review of the interaction.** What the bot captured wrongly, what it interrupted
   people for, what someone had to repeat. The outcome is a norm in the memory or a change to
   the bot's instructions.
10. **Measured from the first slice.** The numbers in `team-layer.md`, "What is measured",
    are collected from 2.1, before any page shows them.

The habits of wave 1 stay too: a slice's schema ships in its own pull request first (decision
86), and a slice is done when its "done when" lines hold in production (96).

## Slices

| # | Slice | Demo | Needs |
|---|---|---|---|
| 2.1 | One bot, everyone trusted | Anyone in the workspace asks for a change and gets a pull request; nobody types "approve" | One agent with both toolsets; the stage and approval rules out of the prompt; the people in Slack and on GitHub |
| 2.2 | Decisions: store, recall, cite | Something decided in one thread is known, with who decided it, when a different person asks in another thread | The memory probe (G4); the decisions table; tools the API answers; the decisions put before each new session |
| 2.3 | Web app and Slack sign-in | A member of the workspace signs in and sees a page; someone outside it cannot | `apps/web` (decision 22); sign in with Slack; the API accepting a signed-in person beside the service token |
| 2.4 | Monitoring page | The Dashboard v1 plan as approved: the latest ten sessions, active first, with who asked, the project, the latest activity, and a refresh button | The list route grown in `packages/contracts`; cost per session, which the plan left out and trusting everyone needs |
| 2.5 | Listening and capture | A thread that went quiet in a channel with listening on yields proposed decisions, each with a link to the message | A new Slack event and a reinstall; observed messages kept as text; the capture job on reconcile, outside any sync lease |
| 2.6 | Wiki | A person reads the memory by area, and confirms, rejects or edits a proposal | Pages over the decisions table; edits recorded with who made them |

Order: 2.1 first, since it changes how everyone works from the first day. 2.2 before 2.5,
because capture needs somewhere to put what it finds. 2.3 before 2.4 and 2.6, because every
page needs sign-in. 2.2 and 2.3 do not depend on each other and can run side by side.

## Slice 2.1 in outline

Not started. A `slice-2-1.md` is written when the slice is told to begin.

**Demo:** anyone in the workspace mentions the bot and asks for a change to the code; the
thread ends with a pull request. Nobody is asked for a role, a stage or an approval.

What changes:

- **One agent.** `agents/hippidy.md` gains the Atlassian server and its sixteen tools
  (decision 169), beside its four GitHub tools. New threads all get this agent.
- **The product agent takes no new threads.** Threads already open on it keep it, and its
  agent stays synced while they can still be answered (decision 59).
- **The prompt.** The stage rules, the approval rules and "who may ask for development" come
  out. What stays: never merge; say who asked on everything written to Jira and Confluence;
  never delete there.
- **Left in place, unused.** The `approvals` table, the `stage` column and their routes stay
  (add first, remove later); the bot no longer has `record_approval`. `link_project` stays,
  since a project is still a grouping. The role map stays for wave 3's owner map.
- **The README** says how the bot is used now.

Done when (each line gets its query before its pull request merges, decision 96):

- A thread started by any member can end in a pull request, whatever their role or none.
- A thread opened on the product agent before the change can still be answered.
- Nothing the bot says in a new thread mentions a stage, an approval or who may ask.
- No new row appears in `approvals`.

Open before it starts: G1 (one agent that reads tickets and can push), G2 (who can merge)
and G3 (spend with several people).

## Before 2.2: the memory probe

"Agent memory across sessions" has been open since wave 1 (`open-questions.md`, "Things not
yet mentioned"). Before any table is added, a probe like slice 4's experiment answers G4: do
the runtime's memory stores hold what a decision needs (who, when, a link, an area, proposed
or active), can the API read and write them, and can a person correct one? If not, decisions
are our own table behind tools the API answers, as `record_approval` was (decision 167).

## By hand, the owner's

- Invite the people into the Slack workspace, and to the GitHub repository if they are to
  merge (G2).
- Confirm the monthly spend limit on the Anthropic workspace (decision 123).
- Before 2.5: update the Slack app's manifest and reinstall it for the new event.

## Waves 3 to 5 (sketch)

None of this is planned in detail, and each wave is rewritten when the one before it closes.

**Wave 3: who owns what, who waits on whom.** Goal: the right person hears about the right
thing.

| # | Slice | Demo |
|---|---|---|
| 3.1 | Areas, owners and routing | A change that touches an area reaches its owner |
| 3.2 | Conflict surfacing | Two people give opposite direction; the owner is asked, and the latest speaker does not win |
| 3.3 | Tasks and the waiting-on list | One task page, showing Jira or the built-in tracker through the same interface |
| 3.4 | Daily briefs by direct message | "Two things are waiting on you" (direct messages were deferred in decision 36) |

**Wave 4: standing jobs.** Goal: the bot holds responsibilities, not only requests
(`team-layer.md`, "Standing responsibilities").

| # | Slice | Demo |
|---|---|---|
| 4.1 | The responsibility record and its scheduler | Capture and the brief run as standing jobs; a wake that says nothing is still logged |
| 4.2 | Agent management page | A person creates, pauses or caps a standing job |
| 4.3 | The checker | Every pull request gets a review its author did not write, with the walkthrough and the production check. Pulls the GitHub events of decision 108 forward |
| 4.4 | A feature goal | The bot carries a feature across its tickets, and stops at the limit on pull requests waiting for review |
| 4.5 | Dashboard home | Your brief, and the team's scorecard |

**Wave 5: take it elsewhere.** Install for a second team in a deployment of its own, then
add a third provider when a team needs one.

## Not in wave 2

- Owners, routing and conflicts (wave 3). Until then anyone may confirm a proposal (G11).
- Direct messages to the bot and briefs (wave 3).
- Standing jobs with their own records (wave 4). Capture in 2.5 runs from reconcile.
- The built-in task tracker (wave 3) and any provider beyond Jira and Confluence.
- More than one Slack workspace or more than one repository.

## Retros

Appended after each slice, as in `wave-1.md`.
