# hippidy-bot

A Slack bot (and later a web UI) in front of a single API that drives Claude agents, built to
explore how an AI teammate fits into a SaaS product engineering team: engineers (tech lead,
team lead, senior, mid, junior), product manager, designer, QA, engineering manager and other
stakeholders.

**Status: planning only. No code yet.**

## Planning docs

| Doc | What it is |
|---|---|
| [docs/planning/wave-1.md](docs/planning/wave-1.md) | The wave 1 plan: six slices, each with a demo, exit criteria, and what is known to be hard |
| [docs/planning/open-questions.md](docs/planning/open-questions.md) | The grill: decisions that are open, grouped by when they block |
| [docs/planning/decisions.md](docs/planning/decisions.md) | Decision log. Things move here from open-questions once decided |
| [docs/planning/stack-and-tools.md](docs/planning/stack-and-tools.md) | Stack options, MCP servers, and off-the-shelf pieces that make this cheaper or better |

## How these docs are maintained

- Only the next slice is planned in detail. Later slices stay as sketches and are rewritten
  after each slice ships, because each one teaches something that changes the next.
- Every slice ends with a short retro appended to `wave-1.md` (what was learned, what changed).
- A decision is not real until it is in `decisions.md` with a date and a reason.
