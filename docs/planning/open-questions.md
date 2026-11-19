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

Z2 (factory, employee, or knowledge and task system) is answered: the unit is a project
moving through stages. See `decisions.md` 134 and `projects.md`.

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

Nothing is open.

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

D4 (`CLAUDE.md` as the one source, plus a skill) and D6 (the sandbox runs the suite) are
answered and confirmed by the experiment that opens the slice: see `decisions.md` 110.

D5 (what "done" means) and D8 (the thread keeps going on the same pull request) are answered:
see `decisions.md` 109.

D7 (the agent reads its own CI results through MCP; a GitHub webhook waits for slice 6) is
answered: see `decisions.md` 108.

D11 (four GitHub MCP tools, running without asking, everything else off) is answered: see
`decisions.md` 105.

D12 (progress notes after 15 minutes, 1, 2, 4 and 8 hours, then every 4 hours) is answered:
see `decisions.md` 103 and 106.

D13 (a coding session starts at about $5, raised when turns need more) is answered: see
`decisions.md` 107.

D10 (browser for the agent) is answered: try Playwright in the sandbox first, see
`decisions.md` 24.

The review of the plan on 2026-11-18 asked three more: when the outcome is sent (with every
message), what is stored (everything; the size is watched) and where the experiment runs (a
workflow in `release`). All answered: see `decisions.md` 115, 120 and 118.

## E. Blocks slice 5

Slice 5 became the project workflow in `projects.md`, built in three parts (5A, 5B, 5C;
`decisions.md` 134 to 149). The questions were asked again on 2026-11-19 and the grill is
still going.

**E1. Which document system and which ticket system?** Still open. Six candidates were
researched on 2026-11-19; the table and its sources are in `stack-and-tools.md`. What decides
it is whether the system's MCP server takes a fixed token, because that is what our vault
holds today, and whether that works on the free plan.
*Recommendation:* probe Jira and Confluence first, since they are what your real teams use:
on a free site, can a service account key be made and does the MCP server accept it? If not,
Linear: one product holds projects, documents and issues, and its MCP server takes an API
key. Its free plan stops at 250 issues.

E2 (the agent's rights in each system) is answered: see `decisions.md` 137 and 138 and the
two tables in `projects.md`.

E3 (how a ticket is linked to a conversation, a branch and a pull request) is answered in
outline: the project links them, see `decisions.md` 134. How a thread names its project is E6.

**E4. What makes a ticket "ready" for the agent?**
*Recommendation:* the product agent writes every ticket to one template (what and why, how to
tell it is done, what is out of scope), and "ready" is the roadmap's approval by both
(`decisions.md` 136). No separate ready state.

**E5. Does the agent ask clarifying questions in Slack, on the ticket, or both?**
*Recommendation:* in the thread it is working in. What was asked and answered is added to
the ticket as a comment, so the next thread can read it.

**E6. How is a thread tied to a project, and which agent answers it?** A thread belongs to
one agent from its first message.
*Recommendation:* the first message names the project, and the bot asks when it cannot tell.
In a project, "start development on a ticket" opens an engineer thread and everything else
goes to the product agent. Without a project, the four roles that may ask for development
get the engineer agent, as today, and the others get the product agent.

E7 (how the API recognises the actions it checks) is answered: it checks none for now, see
`decisions.md` 145. That leaves E15.

E8 (the product agent reads the repo, read-only), E9 (anyone may stop the bot) and E10 (QA
may merge) are answered: see `decisions.md` 146, 147 and 144.

**E11. How do screenshots get from the sandbox to Slack?** The agents cannot reach Slack, so
the API has to fetch the images from the session and upload them, which needs a new Slack
permission. Whether Chromium runs in the sandbox is the experiment decision 24 deferred, and
how a session hands files out is not known. Agreed: a probe like slice 4's experiment before
5C is planned (`decisions.md` 149).

**E12. What does the production check cover?** The sandbox has no general web access and
must hold no production secret (`decisions.md` 39, 128).
*Recommendation:* three steps. The API waits until GitHub reports the merge commit's
deployment as successful. The engineer agent then calls production's public routes from its
sandbox: health, and the reference page listing what the change added (one more allowed
host). For anything only visible in Slack, the bot asks the person who asked for the change
to try it and say so in the thread. A smoke test that needs a secret belongs in a workflow in
`release`, with slice 6.

**E13. One epic per project, or several?**
*Recommendation:* one, to start.

E14 (the bot has its own account, and its comments say who asked) is answered: see
`decisions.md` 148.

**E15. Where is an approval written down, and how does the API know a project's stage?**
With no gate in code (`decisions.md` 145) the API never sees an approval happen, yet it owns
the stage (134) and must pick the agent for a new thread (E6).
*Recommendation:* the agent writes the approval where the content lives, as a comment on the
document or the epic naming who approved which version, and tells the API through one small
tool that only records: project, stage, who, when. Recording is not checking.

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
