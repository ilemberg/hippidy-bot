# CLAUDE.md

Instructions for anyone, human or agent, changing this repo.

## Commands

Run from the repo root. Node 26, pnpm (pinned in `package.json`).

- `pnpm install`
- `pnpm dev`: local API on http://localhost:3000 (reads `apps/api/.env`)
- `pnpm lint`, `pnpm format` (writes), `pnpm format:check`, `pnpm typecheck`, `pnpm test`
- `pnpm build && pnpm smoke`: compiles workspace packages the way Vercel does and checks the
  app starts and answers without them being read from source

Before calling a change done: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`
all pass. CI runs these, then `pnpm build && pnpm smoke`.

## Shape of the system

- `apps/api` is the one deployable. `src/index.ts` is the Vercel entry; `src/compose.ts` is the
  composition root, the only file that wires modules together.
- `apps/api/src/slack` is the Slack adapter: Bolt with the `@vercel/slack-bolt` receiver at
  `POST /slack/events`. It maps Slack events to the contract and calls the API through
  `ApiClient`. A lint rule stops it importing `src/api` or `src/compose.ts`.
- `apps/api/src/agent` wraps the agent runtime (Claude Managed Agents) behind `AgentRuntime`,
  with a fake for tests. The agent itself is defined in `agents/hippidy.md` and
  `environments/hippidy.yaml` and synced by `pnpm agent:sync` (CI does it on merge); the
  runtime looks both up by name. Never create agents from the request path.
- `apps/api/src/api/conversations.ts` is the conversation loop: receive a message, start or
  reuse the thread's session, sync replies back exactly once, settle messages, reconcile.
- `apps/api/src/api` is the core API. It is channel-agnostic: it knows sources, conversations
  and messages, never Slack threads or Slack markup.
- Slack (and later the UI) reach the system only through the API's routes and contract. The
  Slack adapter imports nothing from `src/api`; it gets an API client from `compose.ts`, which
  dispatches in-process through the API's own route.
- `packages/contracts` holds every request, response and error schema (Zod). A change to the
  API's shape starts there.
- `apps/api/src/store` is the API's storage (Supabase Postgres): plain SQL with `$1` parameters
  through the small `Db` interface, rows checked with Zod. Only the API uses it.
- The record (`src/api/record.ts`, `src/store/record.ts`): every sync stores the agent
  session's events in `agent_events` and its usage on `conversations`, so a conversation can be
  rebuilt from the database alone. Keeping the record never fails the conversation loop: it
  logs and is retried. `src/store/reading.ts` reads it back for the `GET /v1/conversations`
  routes, which never call the agent runtime.
- `supabase/migrations` holds the schema. Add a new timestamped file for every change; never
  edit one that has been merged. CI applies them on merge to `main`, at the same time as Vercel
  deploys, so a migration must work with both the old and the new code (add first, remove
  later). Every table has row level
  security on and no policies: only the API's direct connection can read it.

## Conventions

- TypeScript strict, run natively by Node 26 (type stripping). Relative imports use the `.ts`
  extension. Only erasable syntax: no `enum`, no `namespace`, no parameter properties.
- Validate with Zod at every boundary: HTTP bodies, environment variables, external payloads.
- Configuration never throws at startup. A missing or bad variable is logged and the feature
  that needs it fails closed; `/health` must keep working with no configuration at all.
- Secrets live in Vercel (Production environment only), never in the repo, logs or chat.
  Never log a token or secret value.
- Logs are JSON, one object per line, through `src/log.ts`. Every line in a request carries the
  correlation id. Message names are `area.event`, for example `message.received`.
- Errors returned by the API use the shape in `packages/contracts` (`errorResponse` in
  `src/api/errors.ts`).
- Never hold a database transaction open across a call to another service (Anthropic, Slack).
- Database tests use `createTestDb()` from `src/store/testing.ts`: an in-process Postgres
  (PGlite) with every migration applied from scratch. No Docker.
- The production client (postgres.js) does not behave exactly like PGlite. Pass JSON as text
  made by `toJsonText` (`src/store/json.ts`) and cast it in the SQL (`$1::text::jsonb`): bound
  straight to a jsonb parameter, a string is stored as a JSON string. `toJsonText` also removes
  what Postgres cannot hold (null characters, lone surrogates), which agent output may contain.
  `bigint` columns come back as strings; cast (`::int`) or parse. Anything touching JSON or
  number types gets a test in `src/store/db.test.ts`, which runs through postgres.js.
- Nothing slow or optional runs while a conversation's sync lease is held: it would make the
  next webhook or a stop find the conversation busy.
- Tests sit next to the code as `*.test.ts` (Vitest). Slack, Anthropic and the network are
  faked; no test talks to a real service. Pass dependencies in, rather than mocking modules.
  Run Vitest from the repo root: from `apps/api` it resolves `@hippidy/contracts` to a stale
  `dist/` instead of the source.

## Vercel gotchas (learned the hard way)

- Vercel only treats a file as the Hono entry if it imports `hono` and creates the app itself,
  and it checks `src/app.ts` before `src/index.ts`. Do not add `src/app.ts` or `src/server.ts`.
- Vercel's build runs its own type check, in which the global `Response` type is empty. Code
  that reads a Response from Hono's `app.fetch` must go through `ResponseLike` (see
  `src/compose.ts`). Check a risky change with a local `vercel build` if in doubt.
- Vercel's type check also runs without strict null checks. `pnpm typecheck` runs a second
  check like it (`apps/api/tsconfig.vercel.json`). Tag unions with strings (`kind: "a"`), not
  booleans, and avoid type predicates (`x is T`) that only differ by nullability.
- Import the Anthropic SDK's named export (`import { Anthropic } from "@anthropic-ai/sdk"`):
  Vercel's type check does not see the default export as a class.
- Workspace packages export their TypeScript source under the `source` condition (used by
  `tsc`, Vitest and `pnpm dev`) and compiled `dist/` by default (used on Vercel). The API's
  `build` script compiles them; Vercel runs it.

## Planning

Plans and decisions are in `docs/planning`. A decision is recorded in `decisions.md` with a date
and a reason before it is relied on. Do not edit old decision entries; add a new one.
