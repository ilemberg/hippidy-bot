# Stack and tools

Options and picks. Items marked *verify* are from memory or docs that move quickly and should
be checked when the slice that needs them starts.

## Recommended baseline

| Layer | Pick | Why | Alternative |
|---|---|---|---|
| Language | TypeScript, strict | Stated | - |
| Repo layout | pnpm workspace: `apps/api`, later `apps/web`, `packages/*` | UI and API share types without sharing a runtime | Single package until the UI exists |
| API | Hono on Vercel (decided) | Small, testable without a server, portable, typed client for React | Next.js; NestJS |
| Validation and contract | Zod schemas, OpenAPI generated from them | One definition for API, Slack adapter and UI | tRPC |
| Lint and format | ESLint (typescript-eslint, strict type-checked) + Prettier (decided) | Largest rule ecosystem | Biome: one tool, much faster |
| Tests | Vitest | Fast, TypeScript-native | - |
| Database | Supabase Postgres, SQL migrations via Supabase CLI, generated types | Stated; least tooling | Drizzle ORM |
| Database tests | PGlite | Postgres without Docker, so tests run in the agent sandbox | Local Supabase in CI only |
| Slack | Bolt for JavaScript with `@vercel/slack-bolt` (decided) | Official framework; the adapter acknowledges within Slack's limit and keeps working in the background | Vercel Chat SDK (*verify*) |
| Agent runtime | Claude Managed Agents via `@anthropic-ai/sdk`, model Claude Opus 5.5 (decided) | Stated | See comparison below |
| Agent config | Files in repo synced with the `ant` CLI | Prompt changes go through PRs | Setup script |
| CI | GitHub Actions | Free for public repos | - |
| UI, later | Separate app in `apps/web`, expected Next.js, calling only the API through a typed client | Stated | Vite + React: runs only in the browser, so it cannot bypass the API even by accident |

## API framework comparison

All three deploy to Vercel with no configuration. The differences show up in later slices.

| | Hono | Next.js | NestJS |
|---|---|---|---|
| What it is | Small API-only framework | Web pages and API in one app | Large, structured server framework (modules, dependency injection, decorators) |
| On Vercel | First-class | First-class, made by Vercel | Supported; whole app runs as one function |
| Bolt (slice 1) | Official adapter and template | Official adapter and template | Not covered by the adapter. Bolt's Express receiver can be mounted, but that path is unpaved on Vercel |
| Webhooks and async loop (slice 2) | Simple | Simple | Works; raw request bodies need extra setup |
| Agent editing the code (slice 4) | Few files per change; tests run in-process in milliseconds; conventions must be written down for the agent | Same, plus page conventions | Strong built-in conventions guide the agent; more files per change; slower test startup |
| UI (later) | Separate app, typed client generated from the API, cannot bypass the API | Same app; pages can bypass the API unless a rule forbids it | Separate app, client generated from OpenAPI, cannot bypass the API |
| Leaving Vercel for an always-on server | Easy, runs anywhere | Hardest | Most at home there |
| Fits when | You want the thinnest plumbing | You want one app for everything | You want the structure common in larger backend teams |

## Browser access for the agent

Not needed until there is a UI. Nothing in the Managed Agents docs describes a built-in
browser, so each option below needs a short experiment before relying on it.

| Option | How it works | Cost | Unknowns |
|---|---|---|---|
| **Playwright in the sandbox** | The agent installs headless Chromium, starts the app or opens the PR's preview URL, runs Playwright scripts, saves screenshots and looks at them with its file-read tool (which is documented to read images) | Free | Whether Chromium installs and runs in the sandbox; the sandbox network must allow the browser download and the preview host |
| **Playwright in GitHub Actions** | Browser tests run on every PR against the preview URL; screenshots and traces are saved; failures are sent back to the agent session | Free for a public repo | None, this is well trodden. Slower loop: minutes, and the agent sees results rather than driving the browser |
| **Hosted browser over remote MCP** | A browser service the agent drives through an MCP server reached by URL | Paid, some free tiers (*verify*) | Managed Agents connects to MCP servers by URL only, so the local Playwright MCP that Claude Code uses does not carry over as is |
| **Agent runs where a browser exists** | Self-hosted sandbox, or the Agent SDK inside GitHub Actions | Free to low | A runtime swap behind `AgentRuntime` |

Decided: try the first. Keep the second as the merge gate regardless; reach for the others
only if the first fails.

Slack itself is not browser-tested. The bot's Slack behavior is tested by sending signed,
recorded Slack events to the API.

## Agent runtime comparison

| Option | You get | You give up | Fits when |
|---|---|---|---|
| **Claude Managed Agents** | Hosted loop and sandbox, sessions, repo mounts, vaults, budgets, webhooks, outcomes with a grader, Console viewer | Beta; repo mount only on Anthropic's sandbox; less control of the container | Default. You want to build workflow, not infrastructure |
| **Claude Code GitHub Action** | Runs in your CI with your exact test setup; PR-native; also does PR review | Not conversational; a round trip per message; uses Actions minutes | Good for the review step in slice 6, and as a fallback coding path |
| **Claude Agent SDK, self-hosted** | Full Claude Code harness in a container you own; any tooling including Docker | You run and secure the container and session state | If the sandbox cannot run the test suite you need |
| **Claude in Slack (Claude Tag)** | Slices 1, 2 and 4 with no code | Team or Enterprise plan; no own API, record or workflow | As a benchmark to compare hippidy-bot against |

Keep an `AgentRuntime` interface in the API (`start`, `send`, `interrupt`, `onEvents`) so the
first row can be swapped for another without touching Slack or the database.

## Managed Agents features to use, by slice

| Slice | Feature | Use |
|---|---|---|
| 2 | Sessions, webhooks, session budgets | Conversation, return path, cost cap |
| 2 | Agent versioning | Record version per conversation |
| 4 | `github_repository` resource, limited networking | Repo access with a token the agent cannot read |
| 4 | Repo skills in `.claude/skills/` | Same skills locally and in the cloud |
| 4 | Vault credentials | GitHub MCP auth; any CLI secret |
| 4 | Outcomes | Rubric-graded "done" before the bot reports success |
| 4 | Permission policies | Slice 4: a short list of tools that run without asking, the rest off (`slice-4.md`, D11). Pausing risky calls for approval in Slack comes later |
| 5 | MCP servers | Ticket and document systems |
| 6 | Multi-agent roster | Separate reviewer; later, team personas |
| later | Memory stores | What the agent learns across sessions |

## MCP servers

For the cloud agent (runtime) and for local development with Claude Code. *Verify* each
server's current URL and auth method before use.

MCP servers come first where they do not make things worse (`decisions.md` 98). The "No"
rows below are the cases where they would: the agent would go around the API. For the
runtime agent a server is declared by URL in the agent file and its credential sits in an
Anthropic vault; its tools ask before running unless each is set not to (`slice-4.md`).

| Server | Runtime agent | Local development |
|---|---|---|
| GitHub | Slice 4: pull requests, checks and CI logs (decision 99). Issues from slice 5 | Yes |
| Atlassian (Jira, Confluence) | Slice 5 candidate | Yes |
| Linear | Slice 5 candidate | Yes |
| Notion | Slice 5 candidate | Yes |
| Supabase | No. The API is the only door to the database | Yes, read-only against production: the build session's eyes (decision 101). There is no dev project (decision 63) |
| Vercel | No | Yes: deployments and logs (decision 101) |
| Slack | No. The API posts to Slack | Optional |
| Context7 or similar docs server | Optional | Yes: current library docs |

## Work items and knowledge (slice 5)

| Option | Cost | Realism for your teams | Agent access | Note |
|---|---|---|---|---|
| GitHub Issues + Projects + `docs/` | Free, already there | Low | GitHub MCP already attached | Fastest way to prove the flow |
| Jira + Confluence | Free tier for small teams (*verify*) | High | Official remote MCP server | The real-world case |
| Linear + Notion | Free tiers (*verify*) | Medium | Official MCP servers | Lighter to administer |
| Internal, in Supabase | Build time | You define it | Through the Core API | Only if hippidy-bot is meant to own this |

## Cheaper or better

- **Webhooks instead of held connections.** No long-running compute, so the API fits a free
  serverless plan.
- **Supabase pg_cron** to call the reconcile endpoint, if Vercel's schedule limits get in the
  way (*verify* plan limits).
- **Session budgets** on every session from slice 2. A runaway agent stops at a number you set.
- **Model and effort as config, not code.** Run the cheaper model against the eval set before
  trusting it for routine changes. That is a decision for slice 6, with data.
- **Prompt caching** is built into sessions. Keep the system prompt stable to benefit.
- **Preview deployments per PR** give the agent's change a live URL to smoke test.
- **GitHub secret scanning and push protection**, free for public repos.
- **Slack app manifest in the repo**, so dev and prod apps are the same definition.
- **Durable steps**, if the webhook pattern proves too thin: Vercel Workflow, Inngest or
  Trigger.dev (*verify* free tiers). Not needed for slices 1 to 3.

## Cost shape

| Item | Cost |
|---|---|
| Vercel, Supabase, GitHub, Slack | Free tiers should cover wave 1 (*verify* limits) |
| Agent tokens | The real cost. Model list price per token |
| Agent runtime | $0.08 per session-hour |
| Claude in Slack, if used as a benchmark | Needs a Team or Enterprise plan |
