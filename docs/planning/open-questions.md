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
"Deferred on purpose". It no longer blocks slice 4 (decision 100).

## B. Blocks slice 2

`slice-2.md` collects these with five new ones (B10 to B14) in one table. All answered
(`decisions.md` 51 to 63); B13 (one free Supabase project, PGlite for tests) is decision 63.

B1 (storage before slice 3) is answered: see `decisions.md` 8.

B2 (one thread is one conversation), B3 (replies must mention the bot) and B4 (a reconcile job
as the backup for lost webhooks) are answered: see `decisions.md` 51, 52 and 54.

B5 (final answer only), B6 (about $2 per session plus a monthly spend limit), B7 (agent config
as files in the repo), B8 (old threads keep their version) and B9 (stop with 🛑 or
"@hippidy-bot stop") are answered: see `decisions.md` 55 and 57 to 60.

## C. Blocks slice 3

Nothing is open. `slice-3.md` collects these with seven new ones (C7 to C13) in one table.

C1 (Supabase owns conversations and messages; raw agent events are a log) and C6 (keep
everything for now) are answered: see `decisions.md` 75 and 76.

C2 (Supabase CLI migrations), C3 (one hosted project, PGlite for tests), C4 (CI applies
migrations) and C5 (tests without Docker) were answered in slice 2: see `decisions.md` 61 to
63 and 65.

C7 to C13 (a transcript view, sessions stay on conversations, read routes, backfill, reading
only new events, housekeeping, one branch per pull request) are answered: see `decisions.md`
77 to 83.

## D. Blocks slice 4

`slice-4.md` collects these in one table with three new ones (D11 to D13). MCP servers come
first where they do not make things worse (`decisions.md` 98), which changed the
answer to D2 and the recommendation for D7.

D1 (Managed Agents behind `AgentRuntime`) was answered up front and built in slice 2: see
`decisions.md` 4. It reopens only if D6 fails.

D3 (the agent opens the pull request through the GitHub MCP server) is answered: see
`decisions.md` 99.

D9 (not bricking the thing that fixes itself) is set aside and does not block slice 4: see
`decisions.md` 100.

D2 (one fine-grained personal access token on your account, the simplest that works) is
answered: see `decisions.md` 104.

**D4. How does the agent get the project instructions?** `CLAUDE.md` loading from a mounted
repo is not documented; `.claude/skills/` is.
*Recommendation:* keep one source of instructions in the repo, shared by local Claude Code
and the cloud agent, and verify by experiment how the cloud agent picks it up.

**D5. What is "done" for a change?** *Recommendation:* lint, typecheck and unit tests pass
in the sandbox; the PR description says what changed and how it was verified; CI is green.

**D6. Can the sandbox run the full test suite?** Needs a spike: Node version, package
install time, no Docker. Whatever cannot run there must run in CI and be fed back to the agent.

**D7. How do CI results get back to the agent and to Slack?**
*Recommendation (changed 2026-11-18):* the agent reads its checks and failed job logs itself
through the GitHub MCP server, waiting for them in the same turn. A GitHub webhook to the
API, which wakes the session, is added only when results that arrive after the turn matter.

**D8. One session per request, or does the thread keep going?**
*Recommendation:* the thread's session continues through review feedback ("also rename X"),
and a new top-level mention starts clean from the latest `main`.

D11 (four GitHub MCP tools, running without asking, everything else off) is answered: see
`decisions.md` 105.

D12 (progress notes after 15 minutes, 1, 2, 4 and 8 hours, then every 4 hours) is answered:
see `decisions.md` 103 and 106.

D13 (a coding session starts at about $5, raised when turns need more) is answered: see
`decisions.md` 107.

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
