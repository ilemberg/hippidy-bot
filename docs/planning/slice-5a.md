# Slice 5A: plan and discovery

Status: **started 2026-11-19 (decision 163). Parts A and B are merged and live**: the schema
(ilemberg/hippidy-bot 34, applied by CI and checked in production) and the API routes
(ilemberg/hippidy-bot 35). Each was reviewed by an independent agent and corrected before it
merged. C to F wait for the owner; E1 still waits for the Atlassian probe (decision 162). The workflow is in `projects.md`; the decisions
behind it are 135 to 158. This file plans the first of slice 5's three parts.

**Demo:** a product manager starts a project in Slack. Several people and the bot write its
plan document in a thread. The product manager and the engineering manager approve it, and
the project moves to the roadmap stage.

## What 5A needs, and what can be built before E1 is settled

E1 (which document and ticket systems) waits on the Atlassian probe (decisions 151, 159,
162). Everything that does not touch the document system can be built first, and is.

| Part | Depends on E1? | Live behaviour changes? | Order |
|---|---|---|---|
| Projects, roles and approvals in the database | No | No: tables only | A |
| API routes to create and read projects, set roles, record approvals | No | No: nothing calls them yet | B |
| The bot reads the thread's messages since its last turn (decision 140) | No | **Yes**: every mention. Needs a new Slack scope and a reinstall | C |
| Threads tied to a project; the project and the sender's role told to the agent | No | **Yes**: the first line of every message | D |
| The product agent: its file, its environment, read-only repo (147) | The document server | **Yes**: new threads may go to it | E |
| The one tool that records an approval (152) | No, but the agent must call it | **Yes** | E |
| The document system: its MCP server, vault credential, host | **Yes** | Yes | F |

A and B change nothing a person in Slack sees, so they can merge without anyone watching.
C to F change what the bot does in every thread; each waits for the owner to try it.

## A. The schema

One migration, additive only (decision 86), so the code before and after it both work.

- `projects`: `id`, `name`, `stage` (`plan`, `roadmap`, `ship`, `end`; decision 136),
  who asked for it (source, workspace, actor), `main_conversation_id` (decision 155, set
  later), `created_at`, `updated_at`.
- `actor_roles`: the hand-made map from a person to a role (decision 138): `source`,
  `workspace_id`, `actor_id`, `role` (one of the six of `projects.md`), `updated_at`. One
  role per person per workspace.
- `approvals`: append-only (decision 152): `project_id`, `subject` (`plan`, `roadmap`,
  `ticket`, `end`; decision 137), `subject_ref` (the document or ticket in the content
  system, free text until E1), `subject_version` (so an edit after approval can be noticed),
  `action` (`approve` or `withdraw`), who acted (source, workspace, actor), their `role` at
  the time, `recorded_at`, and `seq`, the order recorded, so "latest per approver" never
  ties. A project with approvals cannot be deleted, so the history survives.
  Recording is not checking (decision 146): the API stores what the agent reports.
- `conversations` gains `project_id` (nullable: development without a project stays as it
  is, decision 141) and `agent_kind` (nullable; null is today's agent, the engineer).

Row level security on with no policies, like every other table.

## B. The routes

All behind the service token, like `/v1/messages`. Shapes in `packages/contracts` first.

- `POST /v1/projects` creates a project in `plan`; `GET /v1/projects` lists them;
  `GET /v1/projects/:id` returns one with its approvals.
- `PATCH /v1/projects/:id` moves the stage (any direction, decision 136).
- `PUT /v1/roles` sets a person's role; `GET /v1/roles` lists the map. Until there is a UI,
  the owner sets roles with a curl command from the README.
- `POST /v1/projects/:id/approvals` records an approval or a withdrawal. When both managers
  have approved the plan and neither has withdrawn since, the response says so; the stage is
  not changed by it (146).

## Live checks for A and B

- `select relname, relrowsecurity from pg_class where relname in ('projects', 'actor_roles',
  'approvals')`: all three, row level security on, no `anon` privilege (checked 2026-11-19).
- `curl -s -o /dev/null -w '%{http_code}' https://hippidy-bot.vercel.app/v1/projects`: 401
  without the token. With it, the README's curl examples create a project and set a role.

## C to F, for the owner to start

- **C. Reading the thread** (built 2026-11-19, decision 164; on once the app is reinstalled). Slack's `conversations.replies` needs `channels:history` (and
  `groups:history` for private channels). The manifest changes and the app is reinstalled
  by hand. If the scope is missing, the adapter sends the mention alone, as today.
- **D. Project and role in the message.** The first line the agent gets becomes
  `From: <name> (<role>), project <name>, stage <stage>`. A thread's first message names its
  project (decision 153); the agent asks when it cannot tell.
- **E. The product agent.** `agents/product.md` and its environment; the repo read-only and
  no GitHub tools (147); the approval tool as a custom tool whose call the API answers.
- **F. The document system**, once the probe has settled E1.

## Done when (5A)

Each line gets its query before its pull request merges (decision 96).

- The demo works end to end in Slack.
- A project's approvals and stage can be read back from the database alone.
- A person without a role is treated as today: asks questions, asks for development.
- Nothing in a thread without a project behaves differently from slice 4.
