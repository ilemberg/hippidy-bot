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
moving through stages. See `decisions.md` 135 and `projects.md`. Changed on 2026-11-25: the
project stays as a grouping, without stages, and the direction is the team layer
(`decisions.md` 172, 173 and `team-layer.md`).

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

**E1** is answered: Jira and Confluence (`decisions.md` 168).

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

## G. Blocks waves 2 to 4

The direction changed on 2026-11-25: hippidy-bot is the team layer (`decisions.md` 172 to
180, `team-layer.md`, `wave-2.md`). Each question names the slice it blocks.

**G1 (2.1). One agent reads tickets and documents and can also push. Accept that?** Decision
139 kept the two apart, so text in a ticket could not steer a session that can push.
*Recommendation:* accept it for now. A person reviews and merges every pull request, and the
agent has no tool that merges. Revisit when a worker is started by the bot and not by a
person (wave 4). **Answered 2026-11-25 (decision 181): not accepted. Split by rights into a
teammate and a coding worker, joined by a brief; see `slice-2-1.md`.**

**G2 (2.1). Who can merge?** Only people with access to the GitHub repository can.
*Recommendation:* add each invited person as a collaborator, and leave the rule on `main` as
it is (required check, no bypass). Otherwise every pull request waits on the owner.
**Deferred 2026-11-25 (decision 183): the owner merges, as today.**

**G3 (2.1). Spend, with several people starting sessions.** The cap is $5 a session (107)
and the budget $100 a month (11). *Recommendation:* keep both, read spend per person from
the record each week until slice 2.4 shows it, and decide a limit when the numbers ask for
one. **Answered 2026-11-25 (decision 182), as recommended.**

**G17 (2.1, part D). How does a person start a brief?** Three ways: a Start button under the
brief (Slack interactivity in the app's manifest, a reinstall, and Bolt answering it at the
same URL); a ✅ reaction (the `reactions:read` scope and the `reaction_added` event, a
reinstall); or a reply that mentions the bot and says "go", recognised by the API before the
teammate sees it (no reinstall, but it matches text). *Recommendation:* the button. It is
one click, it says plainly what it does, Slack tells the API who pressed it, and Bolt handles
it on the same route. **Answered 2026-11-25 (decision 185): the button.**

**G18 (2.1, parts A and D). Does every brief need a person to start it, or only one written
after untrusted content was read?** Only tainted briefs keeps "nobody types approve" for
changes asked for in Slack alone, but rests on the API seeing every untrusted read; part A
checks the one it may not see (the teammate fetching a fork's branch with git).
*Recommendation:* only tainted briefs, if part A shows the teammate cannot fetch other refs
or the start rule can count the fetch. Otherwise every brief, and revisit once the share of
briefs that needed a start is known. **Answered 2026-11-25 (decision 189): the probe showed the teammate can fetch
other refs, so the start rule counts git reads of them; only tainted briefs need a start.**

**G4 (2.2). Where does the memory live?** In the runtime's memory stores, or in our own
table behind tools the API answers. *Recommendation:* our own table, after the probe in
`wave-2.md` has shown what the memory stores can and cannot hold. The web app must read and
correct a decision without calling the runtime, as the read routes do today.

**G5 (2.2). Is the memory seeded from `decisions.md`?** *Recommendation:* yes. Import the
log as the first entries, each marked with its number as its source, so recall has something
real to answer from on the first day.

**G6 (2.2). When is a decision active at once, and when only proposed?** *Recommendation:*
active at once when a person asks the bot to record it in their own message; proposed when
the bot inferred it.

**G7 (2.3). How do people sign in to the web app?** The Dashboard v1 plan settled who may
see it: anyone who can talk to the bot in Slack. *Recommendation:* sign in with Slack,
limited to the workspace. The service token never reaches a browser (26, 38), so the API
accepts a signed-in person beside it.

**G8 (2.5). What does listening store, and for how long?** Changes 76 and 84.
*Recommendation:* the text, the sender, the time and a link to the message, never Slack's
payload. Deleted after 30 days; a decision keeps its link.

**G9 (2.5). How do people know a channel is listened to?** *Recommendation:* the note in the
channel (176), and one page saying what is read, what is kept, and how to switch it off or
have something deleted.

**G10 (2.5). Which model captures, and what does it cost?** *Recommendation:* the smallest
current model, one run per thread gone quiet, measured in the first days against the budget
before more channels are switched on.

**G11 (2.5, 2.6). Who confirms a proposed decision before areas have owners?**
*Recommendation:* anyone in the thread it came from. From slice 3.1, the owner of its area.

**G12 (3.1, 3.2). Who wins when two people's direction conflicts?** *Recommendation:* the
named owner of the area, with one person as the fallback for everything unowned.

**G13 (3.4). May the bot act in shared spaces for a person, or only brief them?**
*Recommendation:* brief only, at first. It tells you; you act.

**G14 (3.3). How does the API reach a provider?** Today only the agent reaches Jira and
Confluence, through Atlassian's MCP server. *Recommendation:* a small interface in the API
for tasks and pages, with Jira and the built-in tracker as its first two providers; the
agent keeps its direct tools (rule 4 of `wave-1.md`).

**G15 (4.3). How does the bot learn of GitHub events?** Decision 108 left the webhook for
later. *Recommendation:* read the open pull requests on reconcile first, which needs no new
route; add the webhook when a minute's delay costs something.

**G16 (4.1). May the bot change what it is responsible for?** *Recommendation:* no. The goal
is a person's to change, and a changed goal is a recorded decision.

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
  agent's memory lives there, in Supabase, or in the repo's docs. Now G4.
- **Rate limits and concurrency.** What happens when five requests arrive at once.
- **The UI slice.** Supabase Realtime makes a live view cheap if slice 3's model is right,
  which is another reason to get `messages` and `agent_events` right.
- **License** for a public repo. Answered: MIT, `decisions.md` 31.
