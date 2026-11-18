# hippidy-bot

A Slack bot (and later a web UI) in front of a single API that drives Claude agents, built to
explore how an AI teammate fits into a SaaS product engineering team: engineers (tech lead,
team lead, senior, mid, junior), product manager, designer, QA, engineering manager and other
stakeholders.

**Status: slice 1 done.** Mention `@hippidy-bot` in Slack and the message goes through the API
and gets a 👀 reaction. Slice 2 (replies from a Claude agent) is drafted in
[docs/planning/slice-2.md](docs/planning/slice-2.md), with every question answered; not started.

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

| Route                     | Auth                | What it does                                                                                                                          |
| ------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`             | none                | Returns `{"status":"ok"}`. Works with no configuration at all                                                                         |
| `POST /v1/messages`       | service token       | Accepts one inbound message, hands it to the thread's agent session, returns 202                                                      |
| `POST /v1/webhooks/agent` | Anthropic signature | Anthropic says a session went idle or ended; the API posts any new replies                                                            |
| `POST /v1/reconcile`      | reconcile token     | The safety net: delivers replies whose webhook was lost, retries failed posts. Called every minute                                    |
| `POST /slack/events`      | Slack signature     | Slack's Events API. On `app_mention`: sends the message through `/v1/messages`, then reacts 👀. Answers 503 until Slack is configured |

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
   Actions, repository secret). GitHub uses it to sync the agent.
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

## Planning docs

| Doc                                                                  | What it is                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [docs/planning/wave-1.md](docs/planning/wave-1.md)                   | The wave 1 plan: six slices, each with a demo, exit criteria, and what is known to be hard |
| [docs/planning/slice-1.md](docs/planning/slice-1.md)                 | Slice 1 as built: what was built, the manual steps, how the work was done                  |
| [docs/planning/slice-2.md](docs/planning/slice-2.md)                 | The next slice: flow, what gets built, manual steps, and the questions to answer first     |
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
