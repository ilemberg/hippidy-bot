// Syncs the agent and environment defined in `agents/` and `environments/` to Anthropic
// (decision 58): creates them the first time, updates them when the files change (an agent
// update is a new version), and does nothing when they already match.
//
//   pnpm agent:sync --dry-run   print what would change
//   pnpm agent:sync             apply it
//
// Needs ANTHROPIC_API_KEY for the hippidy-bot workspace. CI runs it on merge to main.
import { Anthropic } from "@anthropic-ai/sdk";
import { isDeepStrictEqual } from "node:util";
import { readAgentFile, readEnvironmentFile } from "./agent-files.ts";

const AGENT_FILE = "agents/hippidy.md";
const ENVIRONMENT_FILE = "environments/hippidy.yaml";

const dryRun = process.argv.includes("--dry-run");
const client = new Anthropic();
const say = (line: string) => {
  console.log(dryRun ? `[dry run] ${line}` : line);
};

async function syncEnvironment(): Promise<void> {
  const wanted = readEnvironmentFile(ENVIRONMENT_FILE);
  let existing;
  for await (const environment of client.beta.environments.list()) {
    if (environment.name === wanted.name && environment.archived_at === null)
      existing = environment;
  }
  if (existing === undefined) {
    say(`environment "${wanted.name}": create`);
    if (!dryRun) {
      const created = await client.beta.environments.create(wanted);
      say(`environment "${wanted.name}": created ${created.id}`);
    }
    return;
  }
  const networking =
    existing.config.type === "cloud" && existing.config.networking.type === "limited"
      ? {
          type: existing.config.networking.type,
          allow_package_managers: existing.config.networking.allow_package_managers,
          allow_mcp_servers: existing.config.networking.allow_mcp_servers,
        }
      : existing.config;
  const same =
    existing.description === wanted.description &&
    existing.config.type === wanted.config.type &&
    isDeepStrictEqual(networking, wanted.config.networking);
  if (same) {
    say(`environment "${wanted.name}": unchanged (${existing.id})`);
    return;
  }
  say(`environment "${wanted.name}": update ${existing.id}`);
  if (!dryRun) {
    await client.beta.environments.update(existing.id, {
      description: wanted.description,
      config: wanted.config,
    });
  }
}

async function syncAgent(): Promise<void> {
  const wanted = readAgentFile(AGENT_FILE);
  const body = {
    name: wanted.name,
    description: wanted.description,
    model: wanted.model,
    system: wanted.system,
    tools: wanted.tools as [],
  };
  let existing;
  for await (const agent of client.beta.agents.list()) {
    if (agent.name === wanted.name && agent.archived_at === null) existing = agent;
  }
  if (existing === undefined) {
    say(`agent "${wanted.name}": create`);
    if (!dryRun) {
      const created = await client.beta.agents.create(body);
      say(`agent "${wanted.name}": created ${created.id} version ${created.version}`);
    }
    return;
  }
  const changes = [
    existing.description !== wanted.description ? "description" : undefined,
    existing.model.id !== wanted.model ? "model" : undefined,
    (existing.system ?? "") !== wanted.system ? "system prompt" : undefined,
    !isDeepStrictEqual(existing.tools, wanted.tools) ? "tools" : undefined,
  ].filter((change) => change !== undefined);
  if (changes.length === 0) {
    say(`agent "${wanted.name}": unchanged (${existing.id} version ${existing.version})`);
    return;
  }
  say(`agent "${wanted.name}": update ${existing.id} (${changes.join(", ")}) -> new version`);
  if (!dryRun) {
    const updated = await client.beta.agents.update(existing.id, {
      ...body,
      version: existing.version,
    });
    say(`agent "${wanted.name}": now version ${updated.version}`);
  }
}

await syncEnvironment();
await syncAgent();
