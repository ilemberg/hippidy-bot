// Syncs the agents and environments defined in `agents/` and `environments/` to Anthropic
// (decision 58): creates them the first time, updates them when the files change (an agent
// update is a new version), and does nothing when they already match. Every file in `agents/`
// is its own agent and every file in `environments/` its own environment, each found by its
// name (slice 2.1: the coding worker, the teammate and the product agent; the teammate has an
// environment of its own). It also keeps one vault per agent, named after it, holding the
// credentials of that agent's MCP servers only: GitHub's for the worker (decisions 121, 122),
// Atlassian's for the teammate and the product agent (slice 5A part F).
//
//   pnpm agent:sync --dry-run   print what would change
//   pnpm agent:sync             apply it
//
// Needs ANTHROPIC_API_KEY for the hippidy-bot workspace, and for the vaults AGENT_GITHUB_TOKEN
// (GitHub's MCP server) and ATLASSIAN_SERVICE_KEY (Atlassian's); see MCP_SERVER_SECRETS.
// CI runs it on merge to main, from the `release` environment.
import { Anthropic } from "@anthropic-ai/sdk";
import { readAgentFiles, readEnvironmentFiles } from "./agent-files.ts";
import { syncAll } from "./sync-lib.ts";

const AGENTS_DIRECTORY = "agents";
const ENVIRONMENTS_DIRECTORY = "environments";

const dryRun = process.argv.includes("--dry-run");

await syncAll({
  client: new Anthropic(),
  agents: readAgentFiles(AGENTS_DIRECTORY),
  environments: readEnvironmentFiles(ENVIRONMENTS_DIRECTORY),
  secrets: process.env,
  dryRun,
  say: (line) => {
    console.log(dryRun ? `[dry run] ${line}` : line);
  },
  warn: (line) => {
    console.log(line);
  },
});
