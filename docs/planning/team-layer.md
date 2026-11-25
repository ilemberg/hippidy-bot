# The team layer: what hippidy-bot is for

Status: **draft, 2026-11-25. Planning only; nothing is built.** Written from a conversation
that is still going, so expect changes. What is decided is in `decisions.md` 172 to 180; what
is not is in `open-questions.md`, group G. The slices that build it are in `wave-2.md`.

This file replaces `projects.md` as the description of how people and the bot work together.
What slice 5A built from `projects.md` stays live until slice 2.1 changes it.

## The idea

hippidy-bot is the **team layer** (decision 172): a shared teammate that keeps what the team
has decided, knows who owns what and who is waiting on whom, and makes sure the right person
hears about the right thing. It sits above whichever coding agents do the building.

Why this and not a better coding agent:

- A coding agent can be bought. Background coding agents are sold by several companies and
  one is open source ("Reading that shaped this", below). The coding worker slice 4 built is
  good enough and stays as it is.
- What a team cannot buy is its own context kept straight: the decisions, the owners and the
  open questions, the same for everyone who asks. In most teams nobody owns that, so it rots.
- The problem this project started from is everyone on the team shaping context, memory and
  direction together, with shared agents instead of personal ones.

## What it does

| Verb | What happens |
|---|---|
| Captures | When a thread goes quiet, it proposes what was decided, with who said it and where. Most threads should produce nothing |
| Recalls | Every conversation starts from the decisions that matter to it, and cites them: who, when, which thread |
| Routes | When something touches an area, its owner hears about it. When two people's direction conflicts, the owner is asked; the latest message does not win by default |
| Briefs | Each person gets one short message a day: what touched their areas, what is waiting on them, what was decided |
| Delegates | It hands building to a coding worker, with the decisions as the acceptance criteria |

## Its records

Four records, owned by the API like every other table (rule 1 of `wave-1.md`).

| Record | What it holds |
|---|---|
| Decisions | A statement, who made it, when, where (a link to the message), its area, and whether it is proposed, active or superseded |
| Areas | A part of the product or the code, with one person as its owner |
| Waiting-on | Who is blocked on whom, for what, and since when |
| Responsibilities | The bot's standing jobs: an outcome, an owner, what wakes it, where it reports, a budget, and its notes |

The record of what the agents did (`conversations`, `agent_events`) is the fifth, and exists.

## How people reach it

Slack is where people talk to the bot. A web app is where they see and correct what it knows
and does. Each feature of the web app is one of the records made visible (decision 177).

| Feature | The record behind it | What people do there |
|---|---|---|
| Wiki | Decisions, direction and norms | Read the memory; confirm, reject or edit what the bot proposed |
| Task management | Work items, the waiting-on list and goals | See who is blocked on whom; give work to a person or the bot |
| Agent monitoring | The record of every session, wake and cost | See what the bots did and spent |
| Agent management | Responsibilities, areas and owners, budgets | Create, pause or change a standing job |
| Dashboard | A summary of the other four | Your own brief, and the team's scorecard |

The team builds these features through the team layer itself, so the product work is the
test of the interaction. How people work with the bot is iterated at the same time: a short
review each week asks what the bot captured wrongly, what it interrupted people for and what
someone had to repeat. What comes out becomes a norm in the memory or a change to the bot's
instructions.

## What stays outside: providers

Decision 178. The four records are always ours. Tasks and documents live behind a provider:

- Work items: Jira (works today), a built-in tracker (to be built), others later.
- Documents: Confluence (works today), a built-in wiki (to be built), others later.

The built-in ones are an option beside Jira and Confluence, not a replacement. The aim is to
support the major systems in time; the records and the API do not change when one is added.
Two rules keep that true (rules 5 and 6 of `wave-2.md`): a team has one home for each kind of
content, with no syncing between two homes, and the API talks to the provider itself so the
web app shows the same page whichever system is behind it.

With Confluence chosen, the wiki's decision pages are published there; the decisions stay in
our store.

## Trust

Decisions 173 and 174.

- Everyone in the workspace is trusted like the owner. Anyone may ask for anything,
  development included.
- There are no stages to pass and no approvals to give. Work that can be redone needs no
  sign-off.
- One rule is firm: only a person merges. The bot has no tool that merges (decision 117).
- Only people's words in Slack are requests. Tickets, documents, pull request comments and
  listened channels are information, and the session that reads them cannot publish
  (decision 181).
- Limits are added when a problem shows up, not before (the pattern of decision 14).

## Listening

Decision 176. The bot acts when mentioned, as today. It also listens, silently, in channels
where listening has been switched on:

- It posts a note in the channel when listening starts or stops.
- It never replies to a message that does not mention it.
- No model runs per message. The messages are kept as text and read once the thread has gone
  quiet, by the capture job.
- Channel text is untrusted. The capture job can only propose a decision; nothing becomes
  active memory without a person.

What is stored, for how long, who confirms a proposal and what capture costs are open
(G8 to G11).

## How many agents

One teammate behind the one bot (decisions 174, 181). Agents are not organised by job role.
A second agent is worth having for three reasons only:

- **Rights:** a session that should not hold a right another one needs. The first is the
  coding worker (decision 181): the teammate reads tickets and documents and cannot push;
  the worker pushes and reads only its brief, the repository and its own pull requests.
  The brief, posted in the thread, is the only path between them (`slice-2-1.md`).
- **Independence:** a reviewer that did not write the code (slice 4.3).
- **Parallel work:** long work that would block a thread.

## Standing responsibilities

A sketch for wave 4; nothing here is decided. A task is bounded: write this email, done. A
responsibility is an outcome that stays open: keep the memory true; every pull request gets a
review; carry Dashboard v1 until it ships.

- **Persistent means the records, not the session.** Each wake is a short, fresh session
  that reads the responsibility's notes and the shared memory, acts, and writes its notes
  back. A session that never ends would grow without limit and has a budget (decisions 55, 69).
- **What wakes it:** an event (a pull request opened, a check failed, a thread gone quiet) or
  a timer. The reconcile job already runs every minute and can ask which are due, checking
  for change with plain queries before any model is called.
- **Silence is a valid result.** Most wakes should end with nothing said. The wake is still
  logged, so silence can be checked.
- **Attention has a budget too.** One brief per person per day; a responsibility can be
  paused or muted.
- **People own the goal.** The bot does not rewrite what it is responsible for; a changed
  goal is a recorded decision by its owner.
- **It starts by proposing.** A responsibility says what it would do before it is allowed to
  do it.

## The pilot

Decision 175. Two or three people are invited into the current Slack workspace and build
hippidy-bot with the owner. Capture and recall can be tried by one person; routing, owners
and conflicts cannot.

## What is measured

Collected from slice 2.1, before any page shows them:

- decisions captured, and the share their owners reject;
- conflicts surfaced;
- questions answered from memory without interrupting a person;
- how long work waited on a person;
- cost, per person and per standing job;
- the measures of decision 10 for the coding worker (merged without edits, time from
  message to merge, cost per merged change).

## The Dashboard v1 project

The plan approved on 2026-11-19 (Confluence, space `SD`, page 458754; epic SCRUM-6) is kept.
Its content is the monitoring page, and its tickets map to wave 2:

| Ticket | Where it goes |
|---|---|
| SCRUM-9 (the web app) and SCRUM-10 (sign in with Slack) | Slice 2.3 |
| SCRUM-7 (API: the latest agents) and SCRUM-11 (the page) | Slice 2.4 |
| SCRUM-8 (which task a thread works on) | Slice 3.3, with tasks |
| SCRUM-12 (browser tests) | Waits for the probe of decision 150 |

The dashboard proper, a home page with a brief and the scorecard, is slice 4.5.

## What is kept and what is retired

| Kept | Retired |
|---|---|
| The Slack adapter, the API as the only door, the record | Stages as gates (136) |
| Reading the thread since the bot's last reply (164) | Approvals, freezing and withdrawal (137) |
| The sender line; the role map, which becomes the owner map | The rights table of 138 |
| The custom tool plumbing (167), reused for memory tools | Two agents picked by the sender's role (139, 153) |
| The Jira and Confluence connection (168, 169) | "Who may ask for development" (141) |
| Projects, as a grouping for threads | Slices 5B and 5C as designed; slice 6 is parked (179) |
| The coding worker and its skill, as slice 4 left them | |

## Reading that shaped this

Read on 2026-11-20 to 2026-11-24, mostly through search summaries, not the full texts, so
each is a pointer to verify and not a source to quote.

- Ramp's Inspect, a background coding agent with shared sessions:
  <https://builders.ramp.com/post/why-we-built-our-background-agent>. An open-source project
  modelled on it, whose docs were read in full: <https://github.com/ColeMurray/background-agents>.
  Taken from its memory doc: the agent proposes a memory and a person approves it; "most
  sessions should save nothing"; personal memory never answers anyone else's prompt.
- Tasks and goals, and what wakes a persistent agent:
  <https://www.langchain.com/blog/from-tasks-to-goals> and
  <https://langchain.com/blog/what-weve-learned-building-proactive-agents>.
- Memory kept by a background job:
  <https://anthropic.com/engineering/components-of-agent-memory> and
  <https://letta.com/blog/sleep-time-compute>.
- Agents in shared threads, and whose requests they honour:
  <https://workos.com/blog/agents-in-shared-threads-social-contract> and
  <https://claude.com/blog/turning-conversation-into-knowledge-how-slack-builds-human-agent-teams>.
- A separate reviewer: <https://anthropic.com/engineering/harness-design-long-running-apps>.
- The case against many agents writing at once:
  <https://cognition.ai/blog/dont-build-multi-agents>.
