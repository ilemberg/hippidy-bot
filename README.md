# hippidy-bot

A Slack bot (and later a web UI) in front of a single API that drives Claude agents, built to
explore how an AI teammate fits into a SaaS product engineering team: engineers (tech lead,
team lead, senior, mid, junior), product manager, designer, QA, engineering manager and other
stakeholders.

**Status: slice 3 done; slice 4 planned, not started.** Mention `@hippidy-bot` in Slack and a Claude agent answers in the thread; reply
there and it remembers the conversation. Every conversation is kept in Supabase, with what the agent
did and what it cost, and can be read back through the API.

## Layout

| Path                     | What it is                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `apps/api`               | The deployable, served by Vercel: the core API (`src/api`) and the Slack adapter (`src/slack`) |
| `slack/manifest.yaml`    | The Slack app's definition: name, scopes, events                                               |
| `packages/contracts`     | The API's request, response and error schemas (Zod), shared with every client                  |
| `agents`, `environments` | The agent's definition and system prompt, and its sandbox; synced to Anthropic by CI           |
| `supabase`               | Database schema as migrations, applied by CI on merge to `main`                                |
| `docs/planning`          | Plans and the decision log                                                                     |

## Run, test, check

Needs Node 26 (see `.nvmrc`) and pnpm (the version is pinned in `package.json`; `corepack enable`
picks it up).

```bash
pnpm install
```

```bash
pnpm dev
```

The API listens on http://localhost:3000. To call `/v1/messages` locally, copy `.env.example` to
`apps/api/.env` and set a token.

```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test
```

CI runs the same four checks on every pull request and on `main`, then builds the app the way
Vercel does and checks it starts (`pnpm build && pnpm smoke`).

## API

| Route                              | Auth                | What it does                                                                                                                                  |
| ---------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                      | none                | Returns `{"status":"ok"}`. Works with no configuration at all                                                                                 |
| `GET /status`                      | none                | Health of each part: `database` (answers `select 1`), `agent`, `slack`, `github`. 200 when all are `ok`, else 503 with `degraded`             |
| `POST /v1/messages`                | service token       | Accepts one inbound message, hands it to the thread's agent session, returns 202                                                              |
| `POST /v1/webhooks/agent`          | Anthropic signature | Anthropic says a session went idle or ended; the API posts any new replies                                                                    |
| `POST /v1/reconcile`               | reconcile token     | The safety net: delivers replies whose webhook was lost, retries failed posts. Called every minute                                            |
| `GET /v1/conversations`            | service token       | Conversations, newest first. `limit` (1 to 100, default 20); `before` takes the `next` of the page before                                     |
| `GET /v1/conversations/:id`        | service token       | One conversation: its state, usage and cost, and the transcript, oldest first                                                                 |
| `GET /v1/conversations/:id/events` | service token       | Every event the agent session reported, raw, in the order stored. `limit` (1 to 200, default 50); `after` takes the `next` of the page before |
| `POST /v1/projects`                | service token       | Creates a project in `plan`, returns 201                                                                                                      |
| `GET /v1/projects`                 | service token       | Every project, newest first                                                                                                                   |
| `GET /v1/projects/:id`             | service token       | One project, its approvals and whether the plan is approved                                                                                   |
| `PATCH /v1/projects/:id`           | service token       | Moves the project's stage, in any direction                                                                                                   |
| `POST /v1/projects/:id/approvals`  | service token       | Records an approval or withdrawal, with the actor's current role; returns 201 and whether the subject is approved. Never moves the stage      |
| `PUT /v1/roles`                    | service token       | Sets a person's role in a workspace                                                                                                           |
| `GET /v1/roles`                    | service token       | The map from people to roles                                                                                                                  |
| `POST /slack/events`               | Slack signature     | Slack's Events API. On `app_mention`: sends the message through `/v1/messages`, then reacts 👀. Answers 503 until Slack is configured         |

The request and response shapes are in `packages/contracts`. Every error from the API has the
body `{"error":{"code":"...","message":"..."}}`. The one exception is `/slack/events`: errors there
(a bad signature, for example) come from the Slack library in its own shape; only Slack calls it. Send `x-correlation-id` to tie log lines to one event;
the API generates one if it is missing and returns it in the same header.

The service token is sent as `Authorization: Bearer <token>`. If the API has no token configured,
or the configured one is shorter than 32 characters, it rejects every request.

## Setup

These are the manual steps for slice 1, in order. Secrets go into Vercel directly, never into
chat or the repo, and only into the **Production** environment.

### Before the first pull request merges

In the repo's GitHub settings (Settings, then Advanced Security), turn on secret scanning and
push protection.

### After the first pull request merges

1. In Vercel, create a project from this GitHub repo. Set the root directory to `apps/api` and
   leave the framework as detected (Hono). Everything else stays at the defaults.
2. Generate a service token:

   ```bash
   openssl rand -hex 32
   ```

   That is for a Mac (Terminal) or Linux. On Windows, in PowerShell:

   ```powershell
   $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b | % { $_.ToString('x2') }) -join ''
   ```

3. In the Vercel project, under Settings, Environment Variables, add `API_SERVICE_TOKEN` with
   that value, for **Production only**. Then redeploy (Deployments, the latest one, Redeploy):
   Vercel only applies changed variables to new deployments.
4. Check production. Replace the URL with your production URL, and the token with yours:

   ```bash
   curl -s https://hippidy-bot.vercel.app/health
   ```

   Expect `{"status":"ok"}`.

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://hippidy-bot.vercel.app/v1/messages
   ```

   Expect `401`.

   ```bash
   curl -s -X POST https://hippidy-bot.vercel.app/v1/messages -H "Authorization: Bearer YOUR-TOKEN" -H 'content-type: application/json' -d '{"source":"slack","sourceEventId":"Ev-manual-check","conversation":{"workspaceId":"T0","channelId":"C0","threadId":"1.0","messageId":"1.0"},"actor":{"id":"U0"},"text":"hello","sentAt":"2026-11-18T00:00:00Z"}'
   ```

   Expect a 202 body like `{"id":"...","status":"accepted"}`, and a `message.received` line in
   the Vercel logs.

5. In GitHub (Settings, Branches or Rules), require the **Lint, typecheck, test** check before
   merging to `main`.

### When the second pull request is up, before merging it

1. Open `slack/manifest.yaml` and copy its contents. It already points at the production domain,
   `hippidy-bot.vercel.app`.
2. At https://api.slack.com/apps choose **Create New App**, then **From a manifest**, pick your
   workspace, choose the **YAML** tab (not JSON), paste, and create. If Slack says the request URL is not verified,
   that is expected for now. If Slack refuses to create the app because of the URL, delete the
   `request_url:` line from what you pasted and try again; you will add the URL in step 2 under
   "Then".
3. On the app's **Install App** page, install it to your workspace.
4. In Vercel, Settings, Environment Variables, add two variables, for **Production only**:
   - `SLACK_BOT_TOKEN`: the **Bot User OAuth Token** from the app's OAuth & Permissions page
     (starts with `xoxb-`)
   - `SLACK_SIGNING_SECRET`: the **Signing Secret** from the app's Basic Information page

### Then

1. Merge the second pull request. Vercel deploys it to production with the Slack variables.
2. In the Slack app, open **Event Subscriptions**. Check it is switched on and the request URL is
   `https://hippidy-bot.vercel.app/slack/events`, then click **Retry** (or enter it). Slack should
   show **Verified**. Check `app_mention` is listed under bot events, and save.
3. In Slack, invite the bot to a channel (`/invite @hippidy-bot`) and mention it:
   `@hippidy-bot hello`. Within a couple of seconds the message gets a 👀 reaction, and the Vercel
   logs show a `message.received` line with who sent it and where.
4. Soon after, while Vercel still has the logs: find the `slack.mention.raw` line for that
   mention and copy its `body`. It becomes the test fixture in the last pull request of the
   slice. It contains Slack ids and your message text. Slack's verification `token` in it is
   replaced with `[redacted]` before logging; if you ever see a real value there, do not share it.

If there is no reaction: check the Vercel logs for `slack.` and `auth.` lines. `auth.rejected`
means `API_SERVICE_TOKEN` is missing or changed without a redeploy; `slack.reaction_failed` with
`not_in_channel` means the bot is not in that channel; nothing at all means Slack is not
reaching the URL (check Event Subscriptions).

## Slice 2 setup: storage (Supabase)

1. At supabase.com, create a project named `hippidy-bot` on the Free plan. Save its database
   password in your password manager.
2. In GitHub, go to the repo's Settings, Secrets and variables, Actions, and add three
   **repository secrets**:
   - `SUPABASE_PROJECT_REF`: the project's ID, the part of its dashboard address after
     `/project/` (also under Project Settings, General)
   - `SUPABASE_DB_PASSWORD`: the database password from step 1
   - `SUPABASE_ACCESS_TOKEN`: a personal access token from supabase.com, Account, Access Tokens
3. After the storage pull request merges, the **Database migrations** workflow under Actions
   applies the schema. Its run should be green, and the Supabase Table Editor should show
   `conversations`, `inbound_messages` and `deliveries`. If the secrets were added after the
   merge, run the workflow by hand: Actions, Database migrations, Run workflow.
4. In Vercel, add `DATABASE_URL`, **Production only**. In the Supabase dashboard choose
   **Connect**, then **Transaction pooler**, copy the string (it ends in `:6543/postgres`), and
   replace `[YOUR-PASSWORD]` with your database password. If the password has any of
   `@ : / ? # %` in it, reset it in Supabase to one with only letters and numbers first, or the
   string breaks. Then redeploy. Until it is set, storage stays off and the rest keeps working.

## Slice 2 setup: the agent loop

Do steps 1 to 4 **before merging** the agent loop pull request: once it is deployed,
`/v1/messages` needs storage and the agent, and the bot stops reacting until both are set.

1. **API key.** In the Anthropic Console (platform.claude.com), in the `hippidy-bot`
   workspace with its monthly spend limit, create an API key. Add it as `ANTHROPIC_API_KEY`
   in two places: Vercel (Production only), and GitHub (Settings, Secrets and variables,
   Actions, repository secret). GitHub uses it to sync the agent. (Later moved to the
   `release` environment: see "Slice 3 setup: keep the CI secrets to `main`".)
2. **Webhook.** In the Console, go to Manage, then Webhooks, and add an endpoint:
   - URL: `https://hippidy-bot.vercel.app/v1/webhooks/agent`
   - Events: `session.status_idled` and `session.status_terminated`
   - Copy the signing secret (`whsec_...`, shown once) into Vercel as
     `ANTHROPIC_WEBHOOK_SIGNING_KEY`, Production only.
3. **Database.** If not done yet, add `DATABASE_URL` to Vercel (storage setup, step 4).
4. **Safety net.** Make a second token, the same way as the service token
   (`openssl rand -hex 32`). It only lets its holder run `/v1/reconcile`, so the database
   never holds a token that can post messages.
   - In Vercel, add it as `RECONCILE_TOKEN`, Production only.
   - In Supabase, open **Project Settings**, then **Vault** (or search the dashboard for
     "Vault"), and add two secrets:
     - name `hippidy_api_url`, value `https://hippidy-bot.vercel.app`
     - name `hippidy_reconcile_token`, value: the token you just made

   Use the Vault page rather than the SQL editor, which keeps a history of what you typed.
   Supabase then calls `/v1/reconcile` every minute; until both secrets exist it does nothing.

   The names differ on purpose and both must be exact: `RECONCILE_TOKEN` in Vercel,
   `hippidy_reconcile_token` in Supabase. To check it works, two minutes after the Vercel
   deployment is ready, run this in Supabase's SQL Editor. The newest rows should start with
   `200`; `401` means the API does not have the token under the right name, or the two
   values differ.

   ```sql
   select coalesce(status_code::text, 'no status') || ' '
            || left(coalesce(content, error_msg, ''), 80) as response,
          created
   from net._http_response order by created desc limit 3;
   ```

5. **Merge.** On merge, GitHub's **Agent sync** workflow creates the agent and its
   environment in your Anthropic workspace (check the run is green), the **Database
   migrations** workflow adds the schedule, and Vercel deploys. Redeploy once in Vercel if you
   added variables after the last deploy.
6. **Try it.** Mention `@hippidy-bot` with a question. 👀 appears at once; within a minute or
   so the answer arrives in the thread and 👀 becomes ✅. Reply in the thread, mentioning the
   bot, and it answers with the earlier context.

If no answer arrives: search the Vercel logs for `conversation.`, `webhook.` and
`reconcile.`. The Console's session viewer (Managed Agents, Sessions) shows what the agent
did. Each conversation is capped at $2; past that the bot says so and shows ❌.

## Slice 2 setup: names and stop

The bot now asks Slack for the sender's name and listens for 🛑 reactions, which needs two
more permissions and one more event. After this pull request merges:

1. At https://api.slack.com/apps, open **hippidy-bot**, then **App Manifest** in the left menu.
2. Switch to **YAML**, replace everything with the contents of `slack/manifest.yaml`, and
   click **Save Changes**.
3. Slack shows a banner asking you to reinstall the app for the new permissions. Click
   **reinstall your app** (or go to **Install App**, then **Reinstall to Workspace**) and
   allow. The bot token stays the same, so nothing changes in Vercel.

To stop the agent in a thread: put a 🛑 (`:octagonal_sign:`) reaction on any message of yours
in that thread, or send a message that is only `@hippidy-bot stop`. The bot interrupts the
agent, marks the pending messages 🛑 and says so in the thread. "Don't stop" never stops it.
A 🛑 on a thread where nothing is running does nothing; a stop message there gets "nothing
running". Text the agent had already written before the stop may still arrive.

## Slice 3: the record

Nothing to set up. From this slice on, every conversation is kept in Supabase so it can be
read back without Anthropic:

- `agent_events`: every event of a conversation's agent session, with the raw payload.
- `conversations`: the session's usage so far (tokens, running time, list cost in cents) and
  its budget.
- `conversation_transcript`: a view of what people wrote, what the agent answered and the
  notes the bot posted.

To look, open the Supabase dashboard, then **SQL Editor**, and run for example:

```sql
-- The latest conversation, as people saw it
select role, actor_name, text, occurred_at
from conversation_transcript
where conversation_id = (select id from conversations order by created_at desc limit 1)
order by occurred_at, recorded_at, position;

-- What each conversation cost
select created_at, usage_list_cost_minor / 100.0 as dollars, usage_input_tokens,
       usage_output_tokens
from conversations
order by created_at desc;
```

Conversations from before this slice are filled in by the reconcile job, three per minute, as
far as Anthropic still has them. In the Vercel logs, search for `record.`.

The same can be read through the API, which answers from the database alone (the agent
runtime is not asked). With the service token from Vercel in `TOKEN`:

```sh
curl -s -H "Authorization: Bearer $TOKEN" https://hippidy-bot.vercel.app/v1/conversations?limit=5
curl -s -H "Authorization: Bearer $TOKEN" https://hippidy-bot.vercel.app/v1/conversations/<id>
curl -s -H "Authorization: Bearer $TOKEN" https://hippidy-bot.vercel.app/v1/conversations/<id>/events
```

Keep the token out of chat and out of your shell history (for example, read it into the
variable with `read -s TOKEN`).

## Slice 3 setup: keep the CI secrets to `main`

GitHub gives a repository secret to any workflow run from a branch of this repo, including a
workflow a pull request adds or changes. From slice 4 the agent opens pull requests, so the
secrets that can change production move into an environment only `main` may use. The
workflows already ask for it; until you do the steps below they keep working from the
repository secrets, exactly as before.

1. In GitHub, open the repo's **Settings**, then **Environments**. If `release` is not listed
   yet, click **New environment** and name it `release`.
2. Open `release`. Under **Deployment branches and tags**, choose **Selected branches and
   tags**, click **Add deployment branch or tag rule**, and enter `main`.
3. Still in `release`, under **Environment secrets**, add the four secrets with the same
   values as the repository secrets of the same names:
   - `ANTHROPIC_API_KEY`
   - `SUPABASE_ACCESS_TOKEN`
   - `SUPABASE_DB_PASSWORD`
   - `SUPABASE_PROJECT_REF`

   GitHub never shows a stored secret, so take the values from your password manager. If you
   no longer have one: make a new Anthropic key or Supabase access token and delete the old
   one where it was made. Do not reset the database password for this: `DATABASE_URL` in
   Vercel contains it, and the bot would lose its database.

4. Check it works: **Actions**, **Database migrations**, **Run workflow** on `main`. It should
   be green and say there is nothing to apply.
5. Then delete the four **repository secrets** (Settings, Secrets and variables, Actions).
   Run **Database migrations** once more: still green means the environment's secrets are the
   ones in use.

## Slice 4 setup: the GitHub token

From slice 4 the agent pushes branches and opens pull requests on this repo, which needs a
key: one fine-grained personal access token on your account, for this repo only (decisions
104 and 122). The API hands it to Anthropic when a session starts, so the agent's `git push`
works without the token entering its sandbox. The agent sync keeps the same token in an
Anthropic vault for GitHub's MCP server, which the agent uses to open pull requests and read
CI results.

Done on 2026-11-18. From pull request C, the API reads it in Vercel to mount the repo in each
session, and the agent sync reads the `release` copy to fill the vault. Without it, no session
starts: a message gets the note that it could not be passed on. To make it again:

1. Open https://github.com/settings/personal-access-tokens/new (**Settings**, **Developer
   settings**, **Personal access tokens**, **Fine-grained tokens**).
2. Name it `hippidy-bot agent`. Pick the longest expiry offered and note the date.
3. **Resource owner:** your account. **Repository access:** **Only select repositories**, then
   `hippidy-bot`.
4. **Repository permissions:**
   - Contents: **Read and write**
   - Pull requests: **Read and write**
   - Actions: **Read-only**
   - Commit statuses: **Read-only**
   - Metadata: **Read-only** (GitHub sets it)
   - everything else, Workflows and Administration included: **No access**
5. Generate it and copy it straight into the two places below, never into a chat, a file or
   your shell history:
   - GitHub: the repo's **Settings**, **Environments**, `release`, **Add environment
     secret**.
   - Vercel: the project's **Settings**, **Environment Variables**, **Production** only,
     marked **Sensitive**.

   The name is `AGENT_GITHUB_TOKEN` in both. (GitHub does not allow secret names that start
   with `GITHUB_`.)

When it expires (GitHub emails you first), make a new one the same way, replace it in both
places, then run **Actions**, **Agent sync**, **Run workflow** on `main` so the vault gets
the new one too.

## Slice 4: the experiment

Before the agent gets the repo, one throwaway session checks what the docs cannot (decision
118; the questions are under "Experiment first" in `docs/planning/slice-4.md`). It runs only
from `main`, by hand, in the `release` environment, and needs `ANTHROPIC_API_KEY` and
`AGENT_GITHUB_TOKEN` there.

1. **Actions**, **Slice 4 experiment**, **Run workflow** on `main`, mode `probes-only`. This
   costs nothing: it checks the token (repo, check runs, job logs, and that it cannot push a
   workflow change) and lists the tools at each address of GitHub's MCP server. The findings
   are in the run's summary.
2. If those look right, run it again with mode `full` (about 30 to 60 minutes, at most $10 by
   default). It makes its own agent, environment and vault named `hippidy-bot-experiment`,
   runs one session in three turns (a sandbox report, a plain question, the demo change), and
   prints a table of findings in the run's summary.
3. It cleans up after itself: the agent's pull request is closed, every `experiment/` branch
   is deleted, the vault is deleted and the rest archived. If a run dies half way, run it with
   mode `cleanup-only`.

Locally, with the three variables set (`GITHUB_REPOSITORY` is `owner/name`):
`pnpm agent:experiment --probes-only`.

## Slice 5: the Atlassian probe

Before Jira and Confluence are chosen for the project workflow, a probe checks that
Atlassian's MCP server accepts the bot's service account key as a bearer token, which is the
only kind of credential the agent's vault holds (decisions 151, 158 and 159). It calls the
server straight from a GitHub runner: no agent, no Anthropic cost.

1. On the Atlassian site, make sure the service account has access to both Jira and
   Confluence (**Administration**, **Directory**, **Service accounts**, the account, product
   access), and that its key was made with the scopes for both.
2. Copy the key straight into the repo's **Settings**, **Environments**, `release`, **Add
   environment secret**, named `ATLASSIAN_SERVICE_KEY`. Never into a chat, a file or your
   shell history.
3. **Actions**, **Atlassian probe**, **Run workflow** on `main`, with `writes` off and `site`
   set to the site's address (`example.atlassian.net`). The run's summary lists the tools
   the server serves and each one's input fields, what the key may reach (`discover`), who
   it is, and whether it can search Jira and Confluence. The server answers its first call
   without a valid key, so the rows after "accepted" are what show the key works.
4. If that looks right, run it again with `writes` on, a Jira project key and a Confluence
   space key. It creates one issue and comments on it, and creates one page, and leaves
   them, marked as the probe's: the server has no tool that deletes, so delete them by hand.

Locally, with `ATLASSIAN_SERVICE_KEY` set: `pnpm atlassian:probe` (add `--writes` with
`ATLASSIAN_PROBE_PROJECT` and `ATLASSIAN_PROBE_SPACE`).

## Slice 5A: projects and roles

Projects, the roles people hold and approvals are kept in Supabase (`projects`,
`actor_roles`, `approvals`; `docs/planning/slice-5a.md`). The agent is told a sender's role
and a thread's project and stage (part D); nothing else in Slack uses them yet. Until there is
a UI, roles are set by hand through the API. With the service token from Vercel in
`HIPPIDY_SERVICE_TOKEN` (read it with `read -s HIPPIDY_SERVICE_TOKEN`, never paste it into a
chat or your shell history):

```sh
# Give a Slack user a role: engineering_manager, product_manager, tech_lead, engineer, qa or designer
curl -s -X PUT https://hippidy-bot.vercel.app/v1/roles \
  -H "Authorization: Bearer $HIPPIDY_SERVICE_TOKEN" -H 'content-type: application/json' \
  -d '{"source":"slack","workspaceId":"<team id>","actorId":"<user id>","role":"product_manager"}'
curl -s -H "Authorization: Bearer $HIPPIDY_SERVICE_TOKEN" https://hippidy-bot.vercel.app/v1/roles

# Start a project (it starts in the plan stage), then read it back with its approvals
curl -s -X POST https://hippidy-bot.vercel.app/v1/projects \
  -H "Authorization: Bearer $HIPPIDY_SERVICE_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"<project name>","createdBy":{"source":"slack","workspaceId":"<team id>","actorId":"<user id>"}}'
curl -s -H "Authorization: Bearer $HIPPIDY_SERVICE_TOKEN" https://hippidy-bot.vercel.app/v1/projects/<id>

# Record an approval (subject: plan, roadmap, ticket or end; a ticket needs its subjectRef)
curl -s -X POST https://hippidy-bot.vercel.app/v1/projects/<id>/approvals \
  -H "Authorization: Bearer $HIPPIDY_SERVICE_TOKEN" -H 'content-type: application/json' \
  -d '{"subject":"plan","action":"approve","actor":{"source":"slack","workspaceId":"<team id>","actorId":"<user id>"}}'

# Link a thread (a conversation id from GET /v1/conversations) to a project; "projectId":null unlinks it
curl -s -X PUT https://hippidy-bot.vercel.app/v1/conversations/<conversation id>/project \
  -H "Authorization: Bearer $HIPPIDY_SERVICE_TOKEN" -H 'content-type: application/json' \
  -d '{"projectId":"<project id>"}'
```

From then on, every message the agent gets in that thread carries a
`Project: <name> (stage: <stage>)` line after the `From:` line, and a `Role:` line (for example
`Role: product manager`) when the sender holds a role. A person with no role
and a thread with no project get exactly the text they got before.

The Slack team and user ids are in Slack under a person's profile, **More**, **Copy member
ID**, and in the API's `message.received` log lines. An approval records what it is told and
checks nothing (decision 146): `planApproved` is true while the latest action (by `seq`, the
order recorded) of at least one engineering manager and one product manager is `approve`. An
approver is one person in one workspace: the role copied onto an approval is the one set for
that same source, workspace and user. The stage moves only through `PATCH /v1/projects/:id`.
A project with approvals cannot be deleted.

## Slice 5A: reading the thread

When the bot is mentioned inside a thread, it first reads what people said there since its
last reply (decision 140): up to the latest 50 messages, leaving out bots and messages that
mention it (those reach it on their own). The agent gets them above the message, one line
each. Reading the thread needs two more Slack permissions, `channels:history` and
`groups:history` (private channels). After this pull request merges:

1. At https://api.slack.com/apps, open **hippidy-bot**, then **App Manifest**.
2. Switch to **YAML**, replace everything with the contents of `slack/manifest.yaml`, and
   click **Save Changes**.
3. Reinstall the app when Slack asks (**Install App**, then **Reinstall to Workspace**). The
   bot token stays the same, so nothing changes in Vercel.

Until the app is reinstalled, the bot answers exactly as before, from the mention alone, and
logs `slack.thread_read_failed` with `slackError: "missing_scope"` for each mention in a
thread. The same happens if Slack takes longer than 1.5 seconds to answer.

## Slice 5A: the product agent

Slack still shows one bot, but behind it are two agents (decisions 139, 167), and a reply
never says which one answered. A thread whose first message comes from someone with the role
`product_manager` or `designer` (set with `PUT /v1/roles`, above) gets the **product agent**,
`agents/product.md`; everyone else, and anyone with no role, gets today's agent, the
engineer. The choice is stored on the conversation (`agent_kind`) when its session starts and
kept for the life of the thread; threads from before keep the engineer.

The product agent writes and iterates the plan with people. It reads the repo to ground the
plan: its session mounts the public repo without a token, so it can read and clone but not
push (decision 147). It has no GitHub tools, and never changes code or opens pull requests. It
has two tools the API answers itself: `link_project` links the thread to a project (creating
one only when a product manager or engineering manager asks), and `record_approval` records
an approval given in the thread by the person approving.

From part F it reaches Jira and Confluence on `levelforward-hippidy-bot.atlassian.net`
through Atlassian's MCP server (`https://mcp.atlassian.com/v2/mcp`). The plan document lives
in the Confluence space `SD`, and its link is posted in the thread; tickets go in the Jira
project `SCRUM`, for now only when someone asks. It may search, read, create, edit, transition
and comment; nothing that deletes, and not the server's generic `executeWrite` or
`executeDestructive`. Everything it writes says who asked for it (decision 149).

Nothing needs setting up by hand: on merge, the agent sync (`pnpm agent:sync`, run by CI)
creates `hippidy-bot-product` beside `hippidy-bot`, in the same environment. Until it has,
a product manager's or designer's new thread fails closed: the API logs
`conversation.session_start_failed`, retries, and then answers with the same note as when the
agent is missing. Product sessions also attach the vault, for the Atlassian credential: with no
vault, they fail closed the same way.

### The Atlassian key

The agent sync keeps the service account's key in the Anthropic vault as the credential for
Atlassian's MCP server, beside GitHub's (each server has its own secret). It reads it from
`ATLASSIAN_SERVICE_KEY` in the `release` environment, the secret the probe uses. The key
belongs to the bot's service account on the site, and needs these scopes:

- Jira's and Confluence's own read and write scopes;
- `read:me` and `read:account`, for the identity tools;
- the MCP server's own: `search:jira:agent-interface`, `search:confluence:agent-interface`,
  `read:jira:agent-interface`, `write:jira:agent-interface`,
  `read:confluence:agent-interface` and `write:confluence:agent-interface`.

A key's scopes cannot be changed after it is made: for different scopes, make a new key. To
rotate it, replace `ATLASSIAN_SERVICE_KEY` in the repo's **Settings**, **Environments**,
`release` (never into a chat, a file or your shell history), then run **Actions**,
**Agent sync**, **Run workflow** on `main`. Without the secret, the sync warns and leaves the
Atlassian credential as it was; GitHub's credential is never touched by it.

## Planning docs

| Doc                                                                  | What it is                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [docs/planning/wave-1.md](docs/planning/wave-1.md)                   | The wave 1 plan: six slices, each with a demo, exit criteria, and what is known to be hard |
| [docs/planning/slice-1.md](docs/planning/slice-1.md)                 | Slice 1 as built: what was built, the manual steps, how the work was done                  |
| [docs/planning/slice-2.md](docs/planning/slice-2.md)                 | Slice 2 as built: the agent loop, storage, names and stop                                  |
| [docs/planning/slice-3.md](docs/planning/slice-3.md)                 | Slice 3 as built: Supabase as the record, the read routes, and how the slice closed        |
| [docs/planning/slice-4.md](docs/planning/slice-4.md)                 | Slice 4 plan: the agent gets a development environment (in progress)                       |
| [docs/planning/open-questions.md](docs/planning/open-questions.md)   | The grill: decisions that are open, grouped by when they block                             |
| [docs/planning/decisions.md](docs/planning/decisions.md)             | Decision log. Things move here from open-questions once decided                            |
| [docs/planning/stack-and-tools.md](docs/planning/stack-and-tools.md) | Stack options, MCP servers, and off-the-shelf pieces that make this cheaper or better      |

How the planning docs are maintained:

- Only the next slice is planned in detail. Later slices stay as sketches and are rewritten
  after each slice ships, because each one teaches something that changes the next.
- Every slice ends with a short retro appended to `wave-1.md` (what was learned, what changed).
- A decision is not real until it is in `decisions.md` with a date and a reason.

## License

MIT. See [LICENSE](LICENSE).
