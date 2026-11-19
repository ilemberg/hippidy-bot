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
moving through stages. See `decisions.md` 135 and `projects.md`.

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

Slice 5 became the project workflow in `projects.md`, built in three parts (5A, 5B, 5C). The
questions were asked again on 2026-11-19 and all are answered, in `decisions.md` 135 to 158.
Two answers wait for a probe.

**E1. Which document system and which ticket system?** Waits for a probe (`decisions.md`
151): on a free Atlassian site, can a service account key be made, and does the MCP server
accept it as a bearer token for Jira and for Confluence? If yes, Jira and Confluence. If
not, Linear. The candidates and their sources are in `stack-and-tools.md`. Where the probe
stands is in `decisions.md` 158.

**E11. How do screenshots get from the sandbox to Slack?** Waits for a probe before 5C is
planned (`decisions.md` 150): does Chromium run in the sandbox, and how does a session hand
files to the API. Posting them needs a new Slack permission.

Answered:

| Question | Answer | Decision |
|---|---|---|
| E2. The agents' rights in each system | The two tables in `projects.md` | 138, 139 |
| E3. How a ticket is linked to a conversation, a branch and a pull request | The project links them | 135 |
| E4. What makes a ticket ready | One template; ready when the roadmap is approved | 154 |
| E5. Where the bot asks clarifying questions | In the thread it is working in, with a note in the project's main thread | 155 |
| E6. Which project and which agent a thread gets | Named in the first message; "start development" opens an engineer thread | 153 |
| E7. How the API recognises the actions it checks | It checks none for now | 146 |
| E8. May the product agent read the repo | Yes, read-only | 147 |
| E9. Who may stop the bot | Anyone | 148 |
| E10. May QA merge | Yes | 145 |
| E12. What the production check covers | Deployed, public routes, then a person for what only Slack shows | 157 |
| E13. One epic per project, or several | Usually one; no rule | 156 |
| E14. Whose name is on the bot's edits | The bot's own account; comments say who asked | 149 |
| E15. Where an approval is written down | On the content, and recorded by the API | 152 |

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
