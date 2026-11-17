# Slice 1: mention goes to the API, bot reacts

Status: **specified, not started.**

**Demo:** mention `@hippidy-bot` in a Slack channel. Within a couple of seconds the message
gets an 👀 reaction, and the API log shows the message with who sent it and where.

No agent, no database, no replies. Those are slices 2 and 3.

## What gets built

### Repo and tooling

- pnpm workspace with two packages: `apps/api` (the deployable) and `packages/contracts`
  (the API's request and response schemas, shared later with the UI).
- TypeScript in strict mode.
- ESLint with typescript-eslint's strict type-checked rules, and Prettier.
- Vitest for unit tests.
- Scripts at the root: `lint`, `typecheck`, `test`, `format`, `dev`.
- `CLAUDE.md` with the commands and conventions, so local Claude Code and (from slice 4) the
  cloud agent work from the same instructions.
- `.env.example` listing every variable, with no values.
- MIT license (assumed; say so if you want something else or none).

### Core API (Hono)

- `GET /health` returns 200. Used to confirm the Vercel deployment works before Slack exists.
- `POST /v1/messages` accepts one inbound message in a channel-agnostic shape and returns 200:
  - `source` (`slack` now, `ui` later) and the source's own event id
  - `conversation`: workspace, channel, thread, message timestamp
  - `actor`: the sender's id in the source system
  - `text`
- The request is validated against the schema in `packages/contracts`. Invalid input is a 400.
- The endpoint requires a service token. A missing or wrong token is a 401.
- In this slice the handler only writes a structured log line. Storage arrives in slice 2.

### Slack adapter (Bolt)

- Bolt for JavaScript with the `@vercel/slack-bolt` adapter, mounted at `POST /slack/events`.
- Bolt handles the signature check, the URL verification handshake and acknowledging Slack
  within its 3 second limit.
- On `app_mention`: map the Slack event to the API's message shape, call `POST /v1/messages`
  with the adapter's service token, and on a 200 add the 👀 reaction to the message.
- If the API call fails, no reaction is added and the failure is logged.
- Slack retries (marked by a retry header) are acknowledged and dropped. Real deduplication
  needs storage and arrives in slice 2.
- The adapter contains no business logic and imports nothing from the API except the shared
  contract.

How the adapter reaches the API: it goes through the same route, auth check and validation
as any outside caller, dispatched inside the process rather than over the network. That keeps
the contract exercised from day one without a second network hop, and it can be switched to a
real network call by changing one small client.

### Slack app definition

- `slack/manifest.yaml` in the repo: app name, bot user, the `app_mention` event, and the
  scopes `app_mentions:read`, `reactions:write`, `chat:write` (the last is for slice 2, added
  now to avoid reinstalling the app).

### Tests

- API: valid message returns 200; invalid body returns 400; missing or wrong token returns 401.
- Adapter: a correctly signed `app_mention` leads to one API call and one reaction; a bad
  signature is rejected; a retry is dropped; an API failure leads to no reaction.
- Mapping from a real recorded Slack event to the API's message shape.
- Slack and the network are faked in tests. No test talks to real Slack.

### CI and deployment

- GitHub Actions on every pull request and on `main`: install, lint, typecheck, test.
- Vercel deploys `main` to production and every pull request to a preview URL, through
  Vercel's GitHub integration.
- Structured JSON logs carrying one correlation id per Slack event.

### Docs

- `README.md`: how to run, test and deploy, and the setup steps below.
- A retro appended to `wave-1.md`, and slice 2 rewritten in detail from what was learned.

## What you need to do by hand

Nothing is needed before work starts. These come up in order during the slice.

| When | Step | Why it is manual |
|---|---|---|
| After the first pull request merges | Create a Vercel project from the GitHub repo, root directory `apps/api`, and open `/health` on the production URL | Needs your Vercel account |
| Same time | In GitHub settings, turn on secret scanning and push protection | Needs repo admin rights |
| After the second pull request is up | Create the Slack app at api.slack.com from `slack/manifest.yaml` and install it to your workspace | Needs your Slack account |
| Same time | Add three environment variables in Vercel: the Slack bot token, the Slack signing secret, and a random service token (the README gives the command to generate one) | Secrets go into Vercel directly, never into chat or the repo |
| After that deploy | Paste the production URL plus `/slack/events` into the Slack app's event settings; Slack checks it and shows "verified" | Slack only accepts a URL that is already live |
| Last | Invite the bot to a channel and mention it | The live demo. Real Slack cannot be tested from the build session |
| Optional | Require the CI check before merging to `main` | Needs repo admin rights. Becomes important at slice 4 |

Also from you: review and merge each pull request.

## How the work is done

- Two pull requests, so the Vercel setup can be confirmed before Slack is involved:
  1. Scaffold, tooling, CI, `CLAUDE.md`, and the API with `/health` and `/v1/messages`.
  2. Slack adapter, manifest, and setup docs.
- One session does the build. No sub-agents for building: the slice is about twenty small
  files that depend on each other, and splitting it would cost more in hand-offs than it saves.
- One independent review agent per pull request before it is handed over, given the code and
  not the author's summary, so the review is not anchored on the author's view.
- No multi-agent workflow.

## Done when

- Mentioning the bot in Slack produces the 👀 reaction and a log line with sender, channel,
  thread and text.
- A request with a bad Slack signature is rejected.
- A call to `/v1/messages` without the service token is rejected.
- Lint, typecheck and tests pass in CI on both pull requests.
- The API contract exists as a schema in `packages/contracts`.

## Known unknowns

- The exact wiring of `@vercel/slack-bolt` with Hono is taken from Vercel's template when the
  work starts; it has not been run by us yet.
- Vercel's settings for a project that lives in a subfolder of a workspace sometimes need one
  adjustment after the first deploy.
- With one Slack app, the adapter can only be tried against real Slack once it is deployed to
  production. Accepted for now (see `decisions.md`, "Deferred on purpose").

## Not in this slice

Agent sessions, replies in threads, Supabase, deduplication with storage, a second Slack app,
the UI, browser tests.
