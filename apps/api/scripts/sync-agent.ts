// Syncs the agent and environment defined in `agents/` and `environments/` to Anthropic
// (decision 58): creates them the first time, updates them when the files change (an agent
// update is a new version), and does nothing when they already match. It also keeps the vault
// that holds the GitHub MCP server's credential (decisions 121, 122).
//
//   pnpm agent:sync --dry-run   print what would change
//   pnpm agent:sync             apply it
//
// Needs ANTHROPIC_API_KEY for the hippidy-bot workspace, and AGENT_GITHUB_TOKEN for the vault.
// CI runs it on merge to main, from the `release` environment.
import { Anthropic } from "@anthropic-ai/sdk";
import type { BetaCloudConfigParams } from "@anthropic-ai/sdk/resources/beta/environments";
import {
  digest,
  readAgentFile,
  readEnvironmentFile,
  type AgentFile,
  type EnvironmentFile,
} from "./agent-files.ts";

const AGENT_FILE = "agents/hippidy.md";
const ENVIRONMENT_FILE = "environments/hippidy.yaml";
/** Must match VAULT_NAME in src/agent/config.ts: the API finds the vault by this name. */
const VAULT_NAME = "hippidy-bot";
/** Where the digest of what was last sent is kept, on the agent and the environment. */
const DIGEST_KEY = "synced_digest";

const dryRun = process.argv.includes("--dry-run");
const client = new Anthropic();
const say = (line: string) => {
  console.log(dryRun ? `[dry run] ${line}` : line);
};

function cloudConfig(wanted: EnvironmentFile): BetaCloudConfigParams {
  const { networking, packages } = wanted.config;
  return {
    type: "cloud",
    networking,
    ...(packages === undefined ? {} : { packages: { type: "packages", ...packages } }),
  };
}

async function syncEnvironment(): Promise<void> {
  const wanted = readEnvironmentFile(ENVIRONMENT_FILE);
  const config = cloudConfig(wanted);
  const metadata = { [DIGEST_KEY]: digest({ description: wanted.description, config }) };
  let existing;
  for await (const environment of client.beta.environments.list()) {
    if (environment.name === wanted.name && environment.archived_at === null)
      existing = environment;
  }
  if (existing === undefined) {
    say(`environment "${wanted.name}": create`);
    if (!dryRun) {
      const created = await client.beta.environments.create({
        name: wanted.name,
        description: wanted.description,
        config,
        metadata,
      });
      say(`environment "${wanted.name}": created ${created.id}`);
    }
    return;
  }
  if (existing.metadata[DIGEST_KEY] === metadata[DIGEST_KEY]) {
    say(`environment "${wanted.name}": unchanged (${existing.id})`);
    return;
  }
  say(`environment "${wanted.name}": update ${existing.id}`);
  if (!dryRun) {
    await client.beta.environments.update(existing.id, {
      description: wanted.description,
      config,
      metadata,
    });
  }
}

async function syncAgent(wanted: AgentFile): Promise<void> {
  const body = {
    name: wanted.name,
    description: wanted.description,
    model: wanted.model,
    system: wanted.system,
    mcp_servers: wanted.mcp_servers,
    // Checked against the API's types by Anthropic, not here: the file is the source of truth.
    tools: wanted.tools as [],
  };
  const metadata = { [DIGEST_KEY]: digest(body) };
  let existing;
  for await (const agent of client.beta.agents.list()) {
    if (agent.name === wanted.name && agent.archived_at === null) existing = agent;
  }
  if (existing === undefined) {
    say(`agent "${wanted.name}": create`);
    if (!dryRun) {
      const created = await client.beta.agents.create({ ...body, metadata });
      say(`agent "${wanted.name}": created ${created.id} version ${String(created.version)}`);
    }
    return;
  }
  if (existing.metadata[DIGEST_KEY] === metadata[DIGEST_KEY]) {
    say(`agent "${wanted.name}": unchanged (${existing.id} version ${String(existing.version)})`);
    return;
  }
  say(`agent "${wanted.name}": update ${existing.id} -> new version`);
  if (!dryRun) {
    const updated = await client.beta.agents.update(existing.id, {
      ...body,
      metadata,
      version: existing.version,
    });
    say(`agent "${wanted.name}": now version ${String(updated.version)}`);
  }
}

/**
 * Keeps one static bearer credential per MCP server in the vault, holding AGENT_GITHUB_TOKEN.
 * A stored token cannot be read back, so it is written on every sync: running the sync after
 * the token is replaced is all that rotating it takes.
 */
async function syncVault(wanted: AgentFile): Promise<void> {
  const urls = wanted.mcp_servers.map((server) => server.url);
  const token = process.env.AGENT_GITHUB_TOKEN;
  let vault;
  for await (const candidate of client.beta.vaults.list()) {
    if (candidate.display_name === VAULT_NAME && candidate.archived_at === null) vault = candidate;
  }
  if (token === undefined || token === "") {
    // Without the token, sessions cannot start once the agent needs a vault: say so loudly.
    console.log(
      `::warning::AGENT_GITHUB_TOKEN is not set, so vault "${VAULT_NAME}" was not ${
        vault === undefined ? "made" : "updated"
      }. See the README's "Slice 4 setup: the GitHub token".`,
    );
    return;
  }
  if (vault === undefined) {
    say(`vault "${VAULT_NAME}": create`);
    if (dryRun) {
      for (const url of urls) say(`vault "${VAULT_NAME}": add credential for ${url}`);
      return;
    }
    vault = await client.beta.vaults.create({ display_name: VAULT_NAME });
    say(`vault "${VAULT_NAME}": created ${vault.id}`);
  }
  const credentials = [];
  for await (const credential of client.beta.vaults.credentials.list(vault.id)) {
    if (credential.archived_at === null) credentials.push(credential);
  }
  for (const url of urls) {
    const existing = credentials.find(
      (credential) =>
        credential.auth.type === "static_bearer" && credential.auth.mcp_server_url === url,
    );
    if (existing === undefined) {
      say(`vault "${VAULT_NAME}": add credential for ${url}`);
      if (!dryRun) {
        await client.beta.vaults.credentials.create(vault.id, {
          display_name: "GitHub (AGENT_GITHUB_TOKEN)",
          auth: { type: "static_bearer", mcp_server_url: url, token },
        });
      }
    } else {
      say(`vault "${VAULT_NAME}": refresh the token for ${url}`);
      if (!dryRun) {
        await client.beta.vaults.credentials.update(existing.id, {
          vault_id: vault.id,
          auth: { type: "static_bearer", token },
        });
      }
    }
  }
  for (const credential of credentials) {
    const url = "mcp_server_url" in credential.auth ? credential.auth.mcp_server_url : undefined;
    if (url !== undefined && !urls.includes(url)) {
      say(`vault "${VAULT_NAME}": archive the credential for ${url}, no longer used`);
      if (!dryRun) {
        await client.beta.vaults.credentials.archive(credential.id, { vault_id: vault.id });
      }
    }
  }
}

const agent = readAgentFile(AGENT_FILE);
await syncEnvironment();
// The vault before the agent: the API needs it the moment the agent can use MCP tools.
await syncVault(agent);
await syncAgent(agent);
