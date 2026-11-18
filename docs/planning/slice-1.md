# Slice 1: mention goes to the API, bot reacts

Status: **finalized after review, not started.**

**Demo:** mention `@hippidy-bot` in a Slack channel. Within a couple of seconds the message
gets an 👀 reaction, and the API log shows the message with who sent it and where.

No agent, no database, no replies. Those are slices 2 and 3.

Decisions behind this plan: `decisions.md` 18, 21 to 28 and 30 to 46.

## What gets built

### Repo and tooling

- pnpm workspace with two packages: `apps/api` (the deployable) and `packages/contracts`
  (the API's request and response schemas, shared later with the UI). If the workspace will
  not deploy cleanly on Vercel in the first pull request, collapse to one package and split
  the contracts out when the UI arrives (decision 33).
- Node: the newest LTS version Vercel supports when work starts, pinned in `engines`,
  `.nvmrc` and CI. pnpm pinned in the `packageManager` field (decision 32).
- TypeScript in strict mode.
- ESLint with typescript-eslint's strict type-checked rules, and Prettier.
- A lint rule (or a separate package) that lets the Slack adapter import only the shared
  contract, never the API's code (decision 43).
- Vitest for unit tests.
- Scripts at the root: `lint`, `typecheck`, `test`, `format`, `dev`.
- `CLAUDE.md` with the commands and conventions, so local Claude Code and (from slice 4) the
  cloud agent work from the same instructions.
- `.env.example` listing every variable, with no values.
- MIT license (decision 31).

### Core API (Hono)

- `GET /health` returns 200. Used to confirm the Vercel deployment works before Slack exists.
  It works with no Slack variables set.
- `POST /v1/messages` accepts one inbound message in a channel-agnostic shape (decision 42):
  - `source` (`slack` now, `ui` later) and the source's own event id (Slack's `event_id`)
  - `conversation`: workspace, channel, thread id, message timestamp. The thread id is always
    present: Slack's `thread_ts`, or the message's own timestamp for a top-level message.
    Channel plus timestamp identify the message itself, separately from the event id.
  - `actor`: the sender's id in the source system. For Slack, the user ID; with the workspace
    ID it identifies the person (decision 34)
  - `text`, with the bot's own mention removed (decision 35)
- It returns 202 with an id for the message. In this slice the id is generated and logged;
  nothing stores it yet.
- The request is validated against the schema in `packages/contracts`. Invalid input is a 400.
  Every error response uses one shape, also defined in `packages/contracts`.
- The endpoint requires a service token. A missing or wrong token is a 401. If the API has no
  token configured, every request is rejected. Tokens are compared in constant time
  (decision 38).
- The correlation id is the source event id. It arrives in a header and is on every log line.
- Configuration is validated with Zod. Each part checks only the variables it needs, so a
  missing Slack variable cannot stop the API from starting (decision 37).
- In this slice the handler only writes a structured log line. Storage arrives in slice 2.

### Slack adapter (Bolt)

- Bolt for JavaScript with the `@vercel/slack-bolt` receiver, mounted at `POST /slack/events`.
- The Bolt app is created on the first request to that route, not when the app starts. Until
  the Slack bot token and signing secret are set, the route returns 503 (decision 37).
- Bolt handles the signature check, the URL verification handshake and acknowledging Slack
  within its 3 second limit.
- On `app_mention`: map the Slack event to the API's message shape, remove the bot's own
  mention from the text, call `POST /v1/messages` with the adapter's service token, and when
  the API accepts the message add the 👀 reaction. Slack's `already_reacted` error counts as
  success.
- If the API call fails, no reaction is added and the failure is logged.
- Slack retries with reason `http_timeout` are dropped, because the first attempt is very
  likely still running. Other retries are processed, because the first attempt may have
  failed before doing anything (decision 40). Real deduplication needs storage and arrives in
  slice 2.
- The raw `app_mention` event is logged once per event, so a real one can be copied for the
  test fixture after the demo.
- Bolt and the receiver use the same JSON logger as the API.
- The mention handling is a plain function that receives the API client, the Slack client and
  the logger, so it can be tested without HTTP (decision 41).
- The adapter contains no business logic and imports nothing from the API except the shared
  contract.

How the adapter reaches the API (decision 30): it goes through the same route, auth check and
validation as any outside caller, dispatched inside the process rather than over the network.
The entry file (`apps/api/src/index.ts`) hands the API's request handler to the adapter as a
small client. That keeps the contract exercised from day one without a second network hop,
and it can be switched to a real network call by changing that one client.

### Slack app definition

- `slack/manifest.yaml` in the repo: app name, bot user, the `app_mention` event, and the
  scopes `app_mentions:read`, `reactions:write`, `chat:write` (the last is for slice 2, added
  now to avoid reinstalling the app). It includes the events URL with a placeholder domain,
  because Slack's docs do not say whether a manifest with events can omit it; you put your
  production domain in before creating the app.

### Tests

- API: a valid message returns 202 with an id; an invalid body returns 400 in the standard
  error shape; a missing or wrong token returns 401; with no token configured, every request
  is rejected; `/health` returns 200 with no Slack variables set.
- Mention handling, tested directly: one API call and one reaction; an API failure leads to no
  reaction; `already_reacted` counts as success; the bot's mention is removed from the text;
  a top-level message and a reply in a thread both get the right thread id; a retry after a
  timeout is dropped and other retries are processed.
- Through the Slack route: a bad signature is rejected; the URL verification handshake is
  answered; the route returns 503 when Slack is not configured.
- Mapping from a Slack event to the API's message shape, starting from Slack's documented
  example event. It is replaced by a real recorded event, with personal details removed,
  after the demo.
- Slack and the network are faked in tests. No test talks to real Slack.

### CI and deployment

- GitHub Actions on every pull request and on `main`: install, lint, typecheck, test, on the
  pinned Node version. The check is required before merging to `main` (decision 44).
- Vercel deploys `main` to production and every pull request to a preview URL, through
  Vercel's GitHub integration.
- Secrets are set for Vercel's Production environment only, never Preview (decision 39).
  Previews start without them: the Slack route returns 503 and `/v1/messages` rejects every
  request.
- Structured JSON logs carrying one correlation id per Slack event (the Slack `event_id`).

### Docs

- `README.md`: how to run, test and deploy, the setup steps below, and the commands to
  generate the service token and to check production after each deploy.
- A retro appended to `wave-1.md`, and slice 2 rewritten in detail from what was learned.

## What you need to do by hand

| When | Step | Why it is manual |
|---|---|---|
| Before work starts | In the repo's GitHub settings (Settings, then Advanced Security), turn on secret scanning and push protection | Needs repo admin rights. The repo is public (decision 45) |
| After the first pull request merges | Create a Vercel project from the GitHub repo, root directory `apps/api`. Check it uses the pinned Node version | Needs your Vercel account |
| Same time | Add the service token in Vercel, Production environment only (the README gives the command to generate one), then redeploy | Secrets go into Vercel directly, never into chat or the repo. Vercel only applies changed variables to new deployments |
| After that deploy | Check production with the README's commands: `/health` returns 200; `/v1/messages` returns 401 without the token and 202 with it | Shows the workspace and the contracts package deployed, not just one route |
| Same time | Require the CI check before merging to `main` | Needs repo admin rights. GitHub only offers checks that have run once (decision 44) |
| After the second pull request is up, before merging it | Create the Slack app at api.slack.com from `slack/manifest.yaml` and install it to your workspace | Needs your Slack account |
| Same time | Add the Slack bot token and signing secret in Vercel, Production environment only | Secrets go into Vercel directly, never into chat or the repo |
| Then | Merge the second pull request. Production deploys with the Slack variables | The deploy picks up the variables |
| After that deploy | In the Slack app's Event Subscriptions, check the URL is the production URL plus `/slack/events` and click Retry; Slack checks it and shows "Verified" | Slack only verifies a URL that is already live |
| Then | Invite the bot to a channel and mention it | The live demo. Real Slack cannot be tested from the build session |
| Soon after the demo | Copy the raw `app_mention` event from the Vercel log and hand it over for the test fixture | Only you can read the Vercel logs, and the free plan keeps them only briefly |

Also from you: review and merge each pull request.

## How the work is done

- Two pull requests, so the Vercel setup can be confirmed before Slack is involved, then a
  small third one after the demo:
  1. Scaffold, tooling, CI, `CLAUDE.md`, and the API with `/health` and `/v1/messages`.
  2. Slack adapter, manifest, and setup docs.
  3. The real recorded event as the test fixture, the retro, and slice 2 rewritten.
- One session does the build. No sub-agents for building: the slice is about twenty small
  files that depend on each other, and splitting it would cost more in hand-offs than it saves.
- One independent review agent per pull request before it is handed over, given the code and
  not the author's summary, so the review is not anchored on the author's view.
- No multi-agent workflow.

## Done when

- Mentioning the bot in Slack produces the 👀 reaction and a log line with sender, channel,
  thread, text and correlation id.
- A request with a bad Slack signature is rejected.
- A call to `/v1/messages` without the service token is rejected, and every call is rejected
  when no token is configured.
- A Slack retry after a timeout is dropped; other retries are processed.
- `/health` works with no Slack variables set.
- Lint, typecheck and tests pass in CI on every pull request, and the CI check is required on
  `main`.
- The API contract exists as a schema in `packages/contracts` (or inside the API package, if
  the fallback in decision 33 was used).
- The mapping test uses a real recorded Slack event.

## Known unknowns

- There is no Hono template to copy. The `@vercel/slack-bolt` README now leads with a Nitro
  template, and its Hono example link returned 404 when checked on 2026-11-17. The wiring is
  small: the Slack route passes the raw request to the handler from `createHandler`. The one
  catch is that no middleware may read the request body before the Slack route, because the
  signature check needs the raw body.
- Vercel's settings for a project that lives in a subfolder of a workspace sometimes need one
  adjustment after the first deploy. Fallback: decision 33.
- Which Node LTS versions Vercel offers when work starts (decision 32). 24 is known to work.
- With one Slack app, the adapter can only be tried against real Slack once it is deployed to
  production. Accepted for now; a candidate fix is recorded in `decisions.md`, "Deferred on
  purpose".

## Not in this slice

Agent sessions, replies in threads, Supabase, deduplication with storage, a second Slack app,
per-preview Slack apps, looking up sender names, direct messages, the UI, browser tests.
