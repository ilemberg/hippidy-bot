// Syncs the agents and environment defined in `agents/` and `environments/` to Anthropic
// (decision 58): creates them the first time, updates them when the files change (an agent
// update is a new version), and does nothing when they already match. Every file in `agents/`
// is its own agent, found by its name (decision 167: the engineer and the product agent);
// all run in the one environment. It also keeps the vault that holds the MCP servers'
// credentials: GitHub's (decisions 121, 122) and Atlassian's (slice 5A part F).
//
//   pnpm agent:sync --dry-run   print what would change
//   pnpm agent:sync             apply it
//
// Needs ANTHROPIC_API_KEY for the hippidy-bot workspace, and for the vault AGENT_GITHUB_TOKEN
// (GitHub's MCP server) and ATLASSIAN_SERVICE_KEY (Atlassian's); see MCP_SERVER_SECRETS.
// CI runs it on merge to main, from the `release` environment.
import { Anthropic } from "@anthropic-ai/sdk";
import { readAgentFiles, readEnvironmentFile } from "./agent-files.ts";
import { syncAll } from "./sync-lib.ts";

const AGENTS_DIRECTORY = "agents";
const ENVIRONMENT_FILE = "environments/hippidy.yaml";

const dryRun = process.argv.includes("--dry-run");

await syncAll({
  client: new Anthropic(),
  agents: readAgentFiles(AGENTS_DIRECTORY),
  environment: readEnvironmentFile(ENVIRONMENT_FILE),
  secrets: process.env,
  dryRun,
  say: (line) => {
    console.log(dryRun ? `[dry run] ${line}` : line);
  },
  warn: (line) => {
    console.log(line);
  },
});
