# Open questions

The grill. Each question has a recommendation so that "go with your pick" is a valid answer.
When a question is answered it moves to `decisions.md`.

Groups are ordered by when they block: Z is direction, A blocks slice 1, B blocks slice 2,
and so on. Later groups are expected to change.

## Z. Direction (does not block slice 1, shapes everything)

**Z1. Why build this instead of using what exists?**
Claude in Slack (Claude Tag) already does roughly slices 1, 2 and 4: mention it, it opens a
thread session with a cloud sandbox, clones the repo, and opens a draft PR. It needs a Team or
Enterprise plan and does not document routing through your own API, your own database as the
record, or a custom workflow. So the reason to build is the part it does not give you: your
own API, your own record, your own workflow and team simulation. Worth writing down which of
those you care about most, because it tells us where to spend effort and where to stay thin.
*Recommendation:* state it as "the value is the workflow and the record, not the plumbing",
and keep the plumbing as thin and replaceable as possible.

**Z2. Software factory, AI employee, or knowledge and task system?**
You do not need to choose now, but each one pulls the data model differently:
- Factory: the unit is a work item moving through stages. Slack is one of several triggers.
- Employee: the unit is a conversation with a persistent persona and memory.
- Knowledge and task system: hippidy-bot owns the tickets and docs, agents are clients of it.
*Recommendation:* keep `conversation` and `work item` as separate concepts from slice 3 so
any of the three can grow from it. Revisit after slice 4, when there is real usage to look at.

Z3 (personas), Z4 (success measure) and Z5 (budget) are answered: see `decisions.md` 9 to 11.

## A. Blocks slice 1

Nothing is open. All of group A is decided (`decisions.md` 12, 16, 18, 21 to 28 and 30 to
46) and slice 1 is finalized in `slice-1.md`.

One item from this group is deferred, not solved: how to test new code against Slack without
taking the real bot offline. A leading candidate is recorded with it in `decisions.md`,
"Deferred on purpose", to be decided before slice 4.

## B. Blocks slice 2

`slice-2.md` collects these with five new ones (B10 to B14) in one table to answer before the
slice starts.

B1 (storage before slice 3) is answered: see `decisions.md` 8.

**B2. What is one conversation?**
*Recommendation:* one Slack thread is one conversation is one agent session. A top-level
mention starts a new one.

**B3. Must replies in a thread mention the bot?**
Without a mention, the bot needs to read all channel messages (a broader Slack scope) and
decide which are for it.
*Recommendation:* require the mention at first. Smallest scope, no ambiguity.

**B4. Backup for lost "agent finished" notifications.**
The async loop is decided (`decisions.md` 13). Still open: Anthropic tells the API an agent has
finished by calling a webhook, tries three times, then gives up without saying so. If the API
was down or erroring at that moment, the Slack thread stays on 👀 forever.
*Recommendation:* a small scheduled job that asks "which conversations are still waiting?"
and checks each one directly. A dozen lines, and it turns a silent hang into a late reply.

**B5. Final answer only, or progress as it works?**
*Recommendation:* final answer only in slice 2, with the reaction as the status signal. Live
progress (editing one status message) when slice 4 makes turns long.

**B6. What cap per session, inside the $100 a month budget?** Model is decided (Opus 5.5,
`decisions.md` 20).
*Recommendation:* about $2 per session for slice 2, a monthly spend limit on the Anthropic
workspace as the backstop, and set the slice 4 cap from measured coding sessions.

**B7. How are the agent's prompt and config managed?**
*Recommendation:* as files in the repo, synced with Anthropic's CLI, so prompt changes go
through pull requests like code. This is also what makes prompt changes evaluable in slice 6.

**B8. What happens to open threads when the agent changes?**
Sessions pin the agent version they started with.
*Recommendation:* accept it. Old threads keep old behavior; record agent version on every
conversation so behavior can be explained later.

**B9. Can you stop it?**
*Recommendation:* a "stop" message or reaction that sends an interrupt. Cheap now, essential
by slice 4.

## C. Blocks slice 3

**C1. What does "source of truth" mean when Anthropic also stores session history?**
Options: Supabase holds pointers only; Supabase mirrors everything; Supabase owns the
conversation and stores the agent's raw events as a log.
*Recommendation:* the third. The API's own model is the truth for conversations and messages;
raw agent events are kept append-only so nothing is lost and the UI can show detail later.

**C2. Schema tooling.** Supabase CLI migrations with generated types, or Drizzle.
*Recommendation:* Supabase CLI migrations plus generated types. Fewer moving parts.

**C3. Environments.** One Supabase project or separate dev and prod.
*Recommendation:* local Supabase for development, one hosted project for production. Note
that free hosted projects pause after a period of inactivity (check current terms).

**C4. Who applies migrations?** *Recommendation:* CI on merge to main, never by hand, and
never by the agent directly.

C5 (testing without Docker) is answered in outline: see `decisions.md` 17. Details are
revisited before implementing, starting with an experiment on what the sandbox can run.

**C6. Retention and privacy.** How long are messages and raw events kept? Slack messages
from other people will eventually land here.
*Recommendation:* keep everything for now, but add the `actor` and `source` columns that make
deletion by person or channel possible later.

## D. Blocks slice 4

**D1. Managed Agents or something else for the coding agent?**
Alternatives: Claude Code GitHub Action triggered by the API, or the Claude Agent SDK in a
container you host. See `stack-and-tools.md` for the comparison.
*Recommendation:* Managed Agents, as planned, behind an `AgentRuntime` interface.

**D2. GitHub identity.** A personal access token (PRs appear as you, and you cannot approve
your own PR) or a GitHub App (PRs appear as the bot, short-lived tokens, reviewable by you).
*Recommendation:* GitHub App. It is more setup once and removes a wall in slice 6.

**D3. Who opens the PR?** The agent via the GitHub MCP server, or the API after the agent
pushes a branch.
*Recommendation:* spike both. API-opens-PR gives the agent less power and a more predictable
PR format; MCP is the documented path.

**D4. How does the agent get the project instructions?** `CLAUDE.md` loading from a mounted
repo is not documented; `.claude/skills/` is.
*Recommendation:* keep one source of instructions in the repo, shared by local Claude Code
and the cloud agent, and verify by experiment how the cloud agent picks it up.

**D5. What is "done" for a change?** *Recommendation:* lint, typecheck and unit tests pass
in the sandbox; the PR description says what changed and how it was verified; CI is green.

**D6. Can the sandbox run the full test suite?** Needs a spike: Node version, package
install time, no Docker. Whatever cannot run there must run in CI and be fed back to the agent.

**D7. How do CI results get back to the agent and to Slack?**
*Recommendation:* a GitHub webhook to the API, which posts to the thread and, on failure,
sends the failure to the same session to fix.

**D8. One session per request, or does the thread keep going?**
*Recommendation:* the thread's session continues through review feedback ("also rename X"),
and a new top-level mention starts clean from the latest `main`.

**D9. How do you avoid bricking the thing that fixes itself?** Deferred by choice; revisit
before slice 4 ships.
*Recommendation:* local Claude Code on the repo always works without the bot; Vercel rollback
is documented in the repo; the bot's deploy and the agent's config are in the "human review
always" tier.

D10 (browser for the agent) is answered: try Playwright in the sandbox first, see
`decisions.md` 24.

## E. Blocks slice 5

**E1. External tools or internal ones?** Jira and Confluence (what your real teams use, free
tier, official MCP server), Linear and Notion (lighter, official MCP servers), GitHub Issues
and docs in the repo (nothing new to set up), or build internal ones in Supabase.
*Recommendation:* leave open, as you said. Lean: start with GitHub Issues plus `docs/` behind
the provider interfaces to prove the flow for free, then add the Atlassian provider to test
the realistic case. Building an internal tracker only makes sense if Z2 lands on "knowledge
and task system".

**E2. For each system, is the agent the only writer, a collaborator, or read-only?**
**E3. How is a ticket linked to a conversation, a branch and a PR?**
**E4. What makes a ticket "ready" for the agent?** A definition of ready is what stops it
from building the wrong thing confidently.
**E5. Does the agent ask clarifying questions in Slack, on the ticket, or both?**

## F. Blocks slice 6

F1 (what earns trust in auto-merge) is answered: see `decisions.md` 14.
**F2. Which paths are never auto-merged?** *Recommendation:* migrations, CI and deploy
config, agent config and prompts, auth, secrets handling, and the tests and evals themselves.
**F3. Who reviews?** A second agent with a different prompt, the Claude Code review action,
or both. The author must not grade its own work.
**F4. How do you stop the agent weakening tests to make them pass?** *Recommendation:* test
and eval changes are their own risk tier, and the grader's rubric checks for it.
**F5. What triggers an eval run?** *Recommendation:* any change to prompt, model, tools or
skills.
**F6. What happens after a bad merge?** Smoke test, automatic rollback, bot pauses itself,
you are paged in Slack.

## Things not yet mentioned at all

- **Secrets.** Where each one lives (Vercel env, Anthropic vault, GitHub App key) and how it
  is rotated. Public repo, so secret scanning and push protection on before any code lands
  (decided, `decisions.md` 45), and no production secrets in preview deployments (39).
- **Observability.** One correlation id from Slack event to API request to session to PR.
  Structured logs from slice 1; error tracking by slice 2.
- **Prompt injection.** Slack messages, tickets and web pages are untrusted input to an agent
  that can push code. Network limits on the sandbox and least-privilege tokens are the defense.
- **Public repo and CI.** Pull requests from forks must not get secrets.
- **Human approval path.** Tool calls can pause for approval. Slack buttons to approve or
  deny are a natural fit and may be worth a slice of their own.
- **Agent memory across sessions.** Managed Agents has memory stores. Decide whether the
  agent's memory lives there, in Supabase, or in the repo's docs.
- **Rate limits and concurrency.** What happens when five requests arrive at once.
- **The UI slice.** Supabase Realtime makes a live view cheap if slice 3's model is right,
  which is another reason to get `messages` and `agent_events` right.
- **License** for a public repo. Answered: MIT, `decisions.md` 31.
