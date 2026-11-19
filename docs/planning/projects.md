# Projects: how a feature moves from an idea to shipped

Status: **draft, 2026-11-19. Planning only; nothing is built.** Written from a conversation
that is still going, so expect changes. What is decided is in `decisions.md` 134 to 149; what
is not is in `open-questions.md`, group E. This file describes the workflow; the slices that
build it are sketched in `wave-1.md` (5A, 5B, 5C).

This is the process for new features. Bugs get their own process later (decision 140).

## The idea

The unit of work is a **project** (decision 134). A project holds:

- its documents (the plan, sometimes more than one),
- its epic and tickets,
- its Slack threads,
- its pull requests.

hippidy-bot's database owns the project, its stage, who holds which role and every approval.
The document system and the ticket system hold the content. Which systems those are is not
chosen yet (E1; candidates in `stack-and-tools.md`).

A project has many threads, on purpose. One thread is one agent session with a budget
(decisions 51 and 69), so a thread cannot carry a feature for weeks. The documents and tickets
carry the memory from one thread to the next.

## Stages

Four stages, loose (decision 135): a project can go backwards at any time.

| # | Stage | What happens | Leaves the stage when |
|---|---|---|---|
| 1 | Plan and discovery | People and the bot write the plan document in a thread: decisions, the plan, or a requirements document | The product manager and the engineering manager both approve the plan |
| 2 | Roadmap | The bot turns the approved plan into an epic and tickets, and they are iterated in a thread | Both approve the roadmap |
| 3 | Ship and iterate | The bot develops ticket by ticket. Each pull request comes with a walkthrough. A person merges; the bot checks production. People comment, more tickets may be added | Everyone is done iterating |
| 4 | End | The epic and tickets are closed | Both approve ending it |

Two rules are firm:

1. No development on a project before its roadmap is approved by both.
2. No merge without an approver. Only the bot opens pull requests; a person merges by hand.

Neither is a gate in code for now (decision 145). The agents are told the sender's role and
the project's stage and follow the rules; the API checks nothing. Everything else is a habit
the bot follows and reminds people of.

## Approval

Decision 136.

- The plan, the roadmap, a ticket added during stage 3 and ending the project each need both
  the product manager and the engineering manager.
- An approved document or ticket is frozen. After that there are two ways to change it: add a
  comment, or one of the two withdraws the approval, the work pauses and it is iterated again.
- If an approved document or ticket is edited outside the bot, the bot warns in the project's
  threads. The approval stands.
- _Recommended, not decided:_ an approval records the version it approved. That is how an
  edit after approval is noticed.

## Roles

Each person is a real, separate Slack account. hippidy-bot keeps the map from account to
role; it is set up by hand at first (decision 137). There is no defence yet against someone
claiming a role they do not hold.

| | Engineering manager | Product manager | Tech lead | Engineer | QA | Designer |
|---|---|---|---|---|---|---|
| Ask the bot questions | Yes | Yes | Yes | Yes | Yes | Yes |
| Create a project | Yes | Yes | - | - | - | - |
| Edit the plan document (stage 1) | Yes | Yes | Yes | Comment | Comment | Yes |
| Edit tickets (stage 2) | Yes | Yes | Yes | Comment | Comment | Comment |
| Approve the plan, the roadmap, an added ticket, the end | Yes | Yes | - | - | - | - |
| Withdraw an approval | Yes | Yes | - | - | - | - |
| Stop the bot | Yes | Yes | Yes | Yes | Yes | Yes |
| Ask for development | Yes | - | Yes | Yes | Yes | - |
| Merge a pull request | Yes | - | Yes | Yes | Yes | - |

"Edit" means asking the bot to change the content, or changing it by hand, while it is not
frozen. "Comment" means the same person may only add comments.

Development without a project stays as it is today, for the four roles that may ask for
development (decision 140). It is where small tasks and bugs go until bugs have a process.

## Two agents, one bot

Decision 138. In Slack there is one bot with one name. A reply never says which agent wrote
it; people should not need to care.

| | Product agent | Engineer agent |
|---|---|---|
| Used for | Stages 1 and 2: documents, the epic, tickets | Stage 3, and development without a project |
| Code | Reads the repo, cannot change it (decision 146) | Changes it, as today |
| GitHub | None | The four tools it has today |
| Documents | Create, edit, comment | Read, comment |
| Tickets | Create, edit, comment | Read, comment, change status |

Why two: a thread that belongs to the product agent cannot change code, whatever it is
asked. It also keeps the text of documents and tickets away from the right to push, except
for the ticket the engineer agent is working on.

In the document and ticket systems both agents write through one account, the bot's own, and
each comment says who asked for it (decision 148).

A thread belongs to one agent from its first message, because one thread is one session.
How a thread is tied to a project and to an agent is open (E6), and so is where an approval
is written down now that the API does not check it (E15).

## Threads and updates

Decision 139.

- The bot acts only when mentioned. When it is, it is given the thread's messages since its
  last turn, so it has read what people said to each other.
- Activity on a project is posted as a note in every active thread of that project: a change
  of stage, an approval or its withdrawal, a pull request opened or merged, a ticket added,
  and edits and comments on documents and tickets. This is meant to keep the number of open
  threads small.
- Notes are written by the API, with no model call, and batched so that a busy document does
  not flood a thread.
- Changes made outside the bot are reported as well as is cheap. The owner does not plan to
  edit outside the bot, so little time goes here.

## Development, walkthrough and the production check

Decision 141.

- "Start development" on a ticket opens an engineer thread. The agent works as in slice 4
  and also keeps the ticket up to date: status and comments.
- With the pull request comes a **walkthrough**: screenshots from the agent's sandbox with a
  short text explaining each, posted in the thread as images. Having the screenshots means
  the change ran. How the images get out of the sandbox needs a probe first (decision 149). Where there is nothing to show (a change only visible in Slack), the
  walkthrough is text.
- So that an API change has something to show, the API gets a generated reference page
  (OpenAPI, made from the schemas in `packages/contracts`). The page is public.
- A person merges. The bot learns of the merge by reading the pull request's state on
  reconcile (decision 108 stands: no GitHub webhook yet), then checks production and says so
  in the thread. What that check covers is open (E12).
- Everything is tested in production for now.

## Left for later

Decision 142: feature flags, a staging environment or A/B testing, the bug process, a better
way to manage roles than a hand-made map. Spend is added up per project so the budget can be
decided from data.
