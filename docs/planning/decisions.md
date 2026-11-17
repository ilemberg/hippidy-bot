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

## Deferred on purpose

| Topic | Revisit |
|---|---|
| Protecting the bot from breaking itself (rollback, paths that never auto-merge) | Before slice 4 ships |
| Evals | Slice 6, or earlier if a prompt change causes a regression |
| Testing new code against Slack without taking the real bot offline. One Slack app sends events to one URL, so trying a change means repointing the real bot. Becomes painful at slice 4, when the bot is used to build the bot | When it first hurts, slice 4 at the latest |
| The experiment for decision 24 (does Chromium run in the sandbox) | When there is a UI to test |
| Details of the testing split (decision 17) | Before implementing; starting point recorded in `wave-1.md` |

## Assumed, awaiting confirmation

| # | Assumption | Question |
|---|---|---|
| a | One Slack workspace, one user, one channel to start | - |
| b | MIT license for the public repo | Say so if you want another or none |

## Recommended, not yet decided

See `open-questions.md`. Each question carries a recommendation.
