# Slice 2.4: the monitoring page

Status: **built 2026-11-25, not merged (decision 197).** The wave is in `wave-2.md`; the
Dashboard v1 plan (Confluence `SD`, page 458754) and its tickets SCRUM-7 (the API: the latest
agents) and SCRUM-11 (the page) are this slice (`team-layer.md`, "The Dashboard v1 project").

**Demo:** a member of the workspace signs in to the web app and sees the agents at work: the
latest ten sessions, working ones first, each with what it was asked, who asked, its project,
what it said last, what it has spent of its budget, and a link to its Slack thread. Refresh
shows the list as it is now.

## What it needs

| Part | What | Live behaviour changes? |
|---|---|---|
| A | **The contract**: `sessionActivitySchema`, `sessionListSchema` and `listSessionsQuerySchema` in `packages/contracts/src/sessions.ts` | No |
| B | **The API**: `listSessions` (`apps/api/src/store/sessions.ts`) and `GET /v1/sessions?limit=`, for the service token and a signed-in person | No: a new read route |
| C | **The page**: the web app's home page lists the sessions once a person is signed in, with a Refresh button | Only the web app, which has no Vercel project yet |

## A session on the page

A session is one agent session doing work, read from the database alone (the record, decision
95); the route never calls the agent runtime. Two kinds:

- **A thread's own session**: the teammate, or an older thread's engineer or product agent.
  Listed once the thread has a session. Its title is the thread's first message; who asked is
  that message's sender.
- **A change's coding worker** (slice 2.1): listed from its brief, even before it runs. Its
  title is the latest brief's title; who asked is who asked for the change.

Each carries:

- **State**: Working (the thread or worker is busy with a message or brief), Waiting for Start
  (a brief a person must start, 185), Idle, Failed (the session ended or its budget ran out)
  or Stopped.
- **Latest activity**: the last thing the agent said, from the record, at most 200 characters.
- **Cost**: list cost spent and the budget, from the usage the record keeps (182). The plan
  left cost out; trusting everyone with every change (174) needs it seen.
- **The thread**: its source and ids, which the page turns into a Slack link
  (`slack.com/archives/<channel>/p<ts>`).

Order: working and waiting first, then by latest activity, or when it started if it has said
nothing. Ten by default, at most fifty.

## Who sees it

Every signed-in member of the workspace (193, 196), like the conversations it summarises
(194). A person sees the titles and last words of every thread, direct messages included,
which they could already read through `GET /v1/conversations`.

## Done when

- A signed-in person sees the latest ten sessions, working ones first, with who asked, the
  project, the latest activity, the cost and a link to the thread.
- A change's worker shows beside its thread, and a brief waiting for Start shows as such.
- Refresh shows the list as it is now.
- When the API does not answer, the page says so and still offers sign-out.

## Not in 2.4

- Opening a session to read its whole record: `GET /v1/conversations/:id` exists; a page for it
  comes with the wiki (2.6) or wave 3's agent management.
- Live updates without Refresh, filters, and cost per person or per month: when the numbers
  ask for them (182).
- Stopping a session from the page: Slack's stop stays the one way.
