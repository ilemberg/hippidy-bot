# hippidy-bot

A Slack bot (and later a web UI) in front of a single API that drives Claude agents, built to
explore how an AI teammate fits into a SaaS product engineering team: engineers (tech lead,
team lead, senior, mid, junior), product manager, designer, QA, engineering manager and other
stakeholders.

**Status: slice 1 in progress.** The API is built; the Slack adapter is next. See
[docs/planning/slice-1.md](docs/planning/slice-1.md).

## Layout

| Path                 | What it is                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `apps/api`           | The deployable: the core API (and, from the next pull request, the Slack adapter), served by Vercel |
| `packages/contracts` | The API's request, response and error schemas (Zod), shared with every client                       |
| `docs/planning`      | Plans and the decision log                                                                          |

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

| Route               | Auth          | What it does                                                  |
| ------------------- | ------------- | ------------------------------------------------------------- |
| `GET /health`       | none          | Returns `{"status":"ok"}`. Works with no configuration at all |
| `POST /v1/messages` | service token | Accepts one inbound message, returns 202 with an id. Logs it  |

The request and response shapes are in `packages/contracts`. Every error has the body
`{"error":{"code":"...","message":"..."}}`. Send `x-correlation-id` to tie log lines to one event;
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

3. In the Vercel project, under Settings, Environment Variables, add `API_SERVICE_TOKEN` with
   that value, for **Production only**. Then redeploy (Deployments, the latest one, Redeploy):
   Vercel only applies changed variables to new deployments.
4. Check production. Replace the URL with your production URL, and the token with yours:

   ```bash
   curl -s https://YOUR-APP.vercel.app/health
   ```

   Expect `{"status":"ok"}`.

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://YOUR-APP.vercel.app/v1/messages
   ```

   Expect `401`.

   ```bash
   curl -s -X POST https://YOUR-APP.vercel.app/v1/messages -H "Authorization: Bearer YOUR-TOKEN" -H 'content-type: application/json' -d '{"source":"slack","sourceEventId":"Ev-manual-check","conversation":{"workspaceId":"T0","channelId":"C0","threadId":"1.0","messageId":"1.0"},"actor":{"id":"U0"},"text":"hello","sentAt":"2026-11-18T00:00:00Z"}'
   ```

   Expect a 202 body like `{"id":"...","status":"accepted"}`, and a `message.received` line in
   the Vercel logs.

5. In GitHub (Settings, Branches or Rules), require the **Lint, typecheck, test** check before
   merging to `main`.

The Slack steps arrive with the second pull request.

## Planning docs

| Doc                                                                  | What it is                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [docs/planning/wave-1.md](docs/planning/wave-1.md)                   | The wave 1 plan: six slices, each with a demo, exit criteria, and what is known to be hard |
| [docs/planning/slice-1.md](docs/planning/slice-1.md)                 | The current slice in full: what gets built, the manual steps, how the work is done         |
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
