# Decision log

A decision is recorded here with a date and a reason. Reversing one adds a new entry; old
entries are not edited.

## Decided

| # | Date | Decision | Reason |
|---|---|---|---|
| 1 | 2026-11-17 | Stack is TypeScript with linting, React for the future UI | Stated up front |
| 2 | 2026-11-17 | Slack and the UI talk only to the Core API | One door, so the record and the rules live in one place |
| 3 | 2026-11-17 | Supabase is the record of conversations with agents | Stated up front |
| 4 | 2026-11-17 | Agent runtime is Claude Managed Agents, one agent to start | Stated up front |
| 5 | 2026-11-17 | First repository the agent works on is this one | So the project is developed through itself after slice 4 |
| 6 | 2026-11-17 | Wave 1 has six slices; only the next slice is planned in detail | Each slice changes what the next should be |
| 7 | 2026-11-17 | No UI in wave 1; use the Anthropic Console to observe | Stated up front |
| 8 | 2026-11-17 | Slice 2 gets a minimal Supabase: only the tables Vercel needs to remember things between requests (thread-to-session mapping, event dedupe). Slice 3 expands it into the full record | Serverless keeps no state, and slice 2 cannot work without the mapping |
| 9 | 2026-11-17 | Personas are separate Slack users. The bot treats every user the same. The Slack adapter passes full sender details (user, channel, thread, timestamp, workspace) to the API from slice 1; the API stores them once storage exists | Realistic simulation with no role logic in the bot, and the data is there when roles matter |
| 10 | 2026-11-17 | Success measure for wave 1 is provisional: share of requests merged without edits, time from message to merge, cost per merged change | To be firmed up with real usage |
| 11 | 2026-11-17 | Budget is under $100 a month, all in | Drives model choice and per-session caps |
| 12 | 2026-11-17 | No user allowlist. Single user, personal Slack workspace, repo is public but not a production system | Revisit if anyone else joins the workspace. Slack request signature checks stay, since the endpoint is on the public internet |
| 13 | 2026-11-17 | Communication is asynchronous: immediate acknowledgement in Slack, then the API updates the thread when the agent asks a question or finishes | Slack needs an answer in 3 seconds; agent turns take minutes |
| 14 | 2026-11-17 | Trust in auto-merge is earned by use. Guardrails are added as problems appear, in skills, hooks, memory and instruction files in the repo | Evidence comes from real usage rather than a metric chosen in advance |
| 15 | 2026-11-17 | From slice 4, every session mounts the hippidy-bot repo | It is the only project; avoids threads that cannot be given a repo later |
| 16 | 2026-11-17 | Repo and bot are named `hippidy-bot` | Confirmed in conversation |
| 17 | 2026-11-17 | Testing split: as much as possible runs in the agent sandbox, the rest in GitHub Actions. Revisit the details before implementing | Fast feedback for the agent; Docker-dependent tests go where Docker exists |
| 18 | 2026-11-17 | Slack library is Bolt for JavaScript from slice 1, deployed with the `@vercel/slack-bolt` adapter | Use a library from the start instead of hand-written handling. The adapter handles Slack's 3 second limit on Vercel |
| 19 | 2026-11-17 | The second Slack app used for development and testing is named `hippidyAdminBot` | Keeps testing off the real bot |
| 20 | 2026-11-17 | Model is Claude Opus 5.5 for now | Revisit with measured cost per session |
| 21 | 2026-11-17 | API framework is Hono | Thinnest plumbing, official Bolt adapter on Vercel, easy to move off Vercel later |
| 22 | 2026-11-17 | The UI will be a separate app in the same repo (`apps/web`), expected to be Next.js, and it talks only to the API | Keeps the "API is the only door" rule structural. Framework confirmed when the UI slice starts |
| 23 | 2026-11-17 | Reverses 19: no second Slack app for now | Not solving it yet. The problem it addressed stays open, see "Deferred on purpose" |
| 24 | 2026-11-17 | Browser testing: try Playwright with headless Chromium inside the agent sandbox first | Free and closest to how the agent already works. Needs an experiment when there is a UI |
| 25 | 2026-11-17 | Tooling: pnpm workspace, ESLint (typescript-eslint strict, type-checked) with Prettier, Vitest, Zod at every boundary | Recommended picks accepted |
| 26 | 2026-11-17 | Every client of the API authenticates with a service token, starting with the Slack adapter | The API endpoint is on the public internet |
| 27 | 2026-11-17 | One Vercel deployment holds the Slack adapter and the API as separate modules. The adapter calls the API through its public route and contract | One thing to deploy, with the boundary still enforced |
| 28 | 2026-11-17 | Hosting is Vercel | Fits the acknowledge-now, update-later design; free tier covers wave 1 |
| 29 | 2026-11-17 | Slice 1 is specified in `slice-1.md` and has not started | Planning only until told to begin |
| 30 | 2026-11-17 | Refines 27: the adapter reaches the API inside the process, through the API's own route, auth check and validation. The entry file (`apps/api/src/index.ts`) hands the API's request handler to the adapter as a small client. Switching to a network call means changing that client only | No second network hop, and the contract is still exercised on every call |
| 31 | 2026-11-17 | Confirms assumption b: MIT license | Confirmed in conversation |
| 32 | 2026-11-17 | Node is the newest LTS version Vercel supports when work starts (24 is known to work; 26 if Vercel lists it), pinned in `engines`, `.nvmrc` and CI. pnpm is pinned in the `packageManager` field | Your machine, CI, Vercel and later the agent's sandbox run the same versions. `@vercel/slack-bolt` needs Node 22 or later |
| 33 | 2026-11-17 | If the two-package workspace will not deploy cleanly on Vercel in the first pull request, collapse to one package and split `packages/contracts` out when the UI arrives | Slice 1 proves the path, not the layout. Agreed in advance so it cannot stall the slice |
| 34 | 2026-11-17 | Sender identity is the Slack user ID plus the workspace ID, and slice 1 sends only those. Names, and roles when personas need them, are looked up from the ID from slice 2 | The ID never changes and is unique; names change. Needed later for addressing people, recording who asked and who approved, and deleting by person (C6) |
| 35 | 2026-11-17 | The adapter removes the bot's own mention from the message text. Other Slack markup is passed as is | The API should not need to know Slack's mention syntax |
| 36 | 2026-11-17 | Direct messages to the bot come later, not in slice 1. They need the `message.im` event, the `im:history` scope and a reinstall | Wanted, not urgent. `app_mention` does not fire in direct messages |
| 37 | 2026-11-17 | The app starts without Slack configuration. The Bolt app is created on the first `/slack/events` request, and that route returns 503 until the Slack variables are set. Configuration is validated with Zod, each part checking only what it needs | `@vercel/slack-bolt`'s receiver throws when it is created without a signing secret, which would take down `/health` and every preview |
| 38 | 2026-11-17 | The service token check fails closed: with no token configured, every request is rejected. Tokens are compared in constant time. The token is set in Vercel right after the first pull request merges | A missing variable must never let a request through, and `/v1/messages` ships before the Slack work |
| 39 | 2026-11-17 | Secrets (Slack bot token, signing secret, service token) are set for Vercel's Production environment only, never Preview | Previews get no Slack traffic. From slice 4 the agent writes the code that previews run |
| 40 | 2026-11-17 | Slack retries with reason `http_timeout` are dropped; other retries are processed. Slack's `already_reacted` error counts as success | After a timeout the first attempt is very likely still running; after a crash it did nothing, and dropping the retry would lose the message. Reacting twice is harmless |
| 41 | 2026-11-17 | The mention handling is a plain function that receives the API client, the Slack client and the logger, and is tested directly. One set of tests goes through the Slack route for the signature check, URL verification and the 503. The first fixture is Slack's documented example event, replaced after the demo by a real event with personal details removed | The receiver acknowledges Slack before the handler runs, so tests through the route alone would be racy. No real event exists until the app is live |
| 42 | 2026-11-17 | Message contract: the thread id is always present (Slack's `thread_ts`, or the message's own timestamp for a top-level message); the message carries both the source event id and its own identity (channel plus timestamp); the source event id is the correlation id and reaches the API in a header; `/v1/messages` returns 202 with an id for the message; all errors share one shape defined in `packages/contracts` | Cheap now, a breaking change later. Slice 2 maps threads to conversations and deduplicates from these fields, and listening to all channel messages (B3) would deliver one message as two events |
| 43 | 2026-11-17 | The Slack adapter is kept apart from the API by a lint rule or by being its own package, so it can import only the shared contract | The boundary should be enforced by tooling, as in decision 22, so the agent cannot break it by accident from slice 4 |
| 44 | 2026-11-17 | The CI check is required before merging to `main`, set right after the first pull request's CI has run | Wave 1 says CI blocks merge, and slice 4 depends on it. GitHub only offers checks that have run once |
| 45 | 2026-11-17 | Secret scanning and push protection are turned on before any code lands | The repo is public |
| 46 | 2026-11-17 | Slice 1 plan is finalized after review (decisions 30 to 45). Not started | Planning only until told to begin |
| 47 | 2026-11-18 | Refines 30: the API client is wired in `apps/api/src/compose.ts`, the composition root, which the entry file `src/index.ts` calls. The entry file only creates the Hono app | Vercel only accepts an entry file that creates the Hono app itself and prefers `src/app.ts`, found while building slice 1 |
| 48 | 2026-11-18 | Node 26 (Vercel's current LTS) is the pinned version, per decision 32 | Vercel lists Node 26 as generally available and the default for new projects |
| 49 | 2026-11-18 | Slice 1 is done: the demo works in production. Slice 2 is drafted in `slice-2.md` and has not started | Retro in `wave-1.md` |
| 50 | 2026-11-18 | The production domain is `hippidy-bot.vercel.app`; Slack's events URL points there | Vercel's branch addresses sit behind a login wall Slack cannot pass |
| 51 | 2026-11-18 | Answers B2: one Slack thread is one conversation is one agent session. A top-level mention starts a new one | Simplest mapping; matches how people already use Slack threads |
| 52 | 2026-11-18 | Answers B3: replies in a thread must mention the bot, at first | Smallest Slack scope (no reading every channel message) and no guessing which messages are for the bot |
| 53 | 2026-11-18 | Answers B10: the API sends replies back through a delivery interface it defines, keyed by source. `compose.ts` registers the Slack adapter's implementation, and the API calls it in-process | Keeps the API channel-agnostic in both directions; the mirror image of how the adapter calls the API (decision 30) |
| 54 | 2026-11-18 | Answers B11, and with it B4: a reconcile job finds conversations still waiting and fetches their replies directly; Supabase `pg_cron` calls the API's `/v1/reconcile` about every minute | Managed Agents webhooks give up silently after three attempts. Vercel's free plan limits scheduled jobs (to be confirmed when the slice starts) |
| 55 | 2026-11-18 | Answers B6: a budget cap of about $2 per agent session (one conversation), plus a monthly spend limit on the Anthropic workspace as the backstop. The slice 4 cap is set later from measured coding sessions | Fits the $100 a month budget (decision 11) |
| 56 | 2026-11-18 | Slice 2 plan updated with decisions 51 to 55. Not started; B5, B7, B8, B9 and B12 to B14 are still open | Planning only until told to begin |

## Deferred on purpose

| Topic | Revisit |
|---|---|
| Protecting the bot from breaking itself (rollback, paths that never auto-merge) | Before slice 4 ships |
| Evals | Slice 6, or earlier if a prompt change causes a regression |
| Testing new code against Slack without taking the real bot offline. One Slack app sends events to one URL, so trying a change means repointing the real bot. Becomes painful at slice 4, when the bot is used to build the bot. Leading candidate (found 2026-11-17): `@vercel/slack-bolt`'s `vercel-slack build` command, which creates a separate Slack app for each preview branch from the manifest and points it at that preview. Costs: a Slack configuration token that expires every 12 hours (renewed with a refresh token), a Vercel API token that can change the project, and a project setting that exposes system variables. The Vercel token is present in preview builds, which run agent-written code from slice 4. The manifest would also need the events URL in it | Decide before slice 4 |
| The experiment for decision 24 (does Chromium run in the sandbox) | When there is a UI to test |
| Details of the testing split (decision 17) | Before implementing; starting point recorded in `wave-1.md` |

## Assumed, awaiting confirmation

| # | Assumption | Question |
|---|---|---|
| a | One Slack workspace, one user, one channel to start | - |
| b | MIT license for the public repo | Confirmed: decision 31 |

## Recommended, not yet decided

See `open-questions.md`. Each question carries a recommendation.
