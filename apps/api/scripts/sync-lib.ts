// What `pnpm agent:sync` does (sync-agent.ts), with the client passed in so it can be tested
// against a fake.
import type { Anthropic } from "@anthropic-ai/sdk";
import type { BetaCloudConfigParams } from "@anthropic-ai/sdk/resources/beta/environments";
import { digest, type AgentFile, type EnvironmentFile } from "./agent-files.ts";

/** Must match VAULT_NAME in src/agent/config.ts: the API finds the vault by this name. */
export const VAULT_NAME = "hippidy-bot";
/** Where the digest of what was last sent is kept, on each agent and the environment. */
export const DIGEST_KEY = "synced_digest";

export interface SyncOptions {
  client: Anthropic;
  /** Every agent file in `agents/`, each synced on its own and found by its name. */
  agents: readonly AgentFile[];
  /** The one environment every agent's sessions run in. */
  environment: EnvironmentFile;
  /** The GitHub token kept in the vault; undefined or empty leaves the vault as it is. */
  githubToken: string | undefined;
  dryRun: boolean;
  say: (line: string) => void;
  /** A GitHub Actions annotation, printed as it is, even in a dry run. */
  warn: (line: string) => void;
}

/**
 * Syncs the environment, the vault and every agent: creates each the first time, updates it
 * when its file changes (an agent update is a new version), and does nothing when it already
 * matches.
 */
export async function syncAll(options: SyncOptions): Promise<void> {
  const names = options.agents.map((agent) => agent.name);
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated !== undefined) {
    throw new Error(`two agent files are named "${repeated}"; each agent needs its own name`);
  }
  await syncEnvironment(options);
  // The vault before the agents: the API needs it the moment an agent can use MCP tools.
  await syncVault(options);
  for (const agent of options.agents) await syncAgent(options, agent);
}

function cloudConfig(wanted: EnvironmentFile): BetaCloudConfigParams {
  const { networking, packages } = wanted.config;
  return {
    type: "cloud",
    networking,
    ...(packages === undefined ? {} : { packages: { type: "packages", ...packages } }),
  };
}

async function syncEnvironment({ client, environment: wanted, dryRun, say }: SyncOptions) {
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

async function syncAgent({ client, dryRun, say }: SyncOptions, wanted: AgentFile): Promise<void> {
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
 * Keeps one static bearer credential per MCP server in the one vault, holding
 * AGENT_GITHUB_TOKEN, for the servers of every agent file (today only the engineer's, and
 * only its sessions attach the vault). A stored token cannot be read back, so it is written
 * on every sync: running the sync after the token is replaced is all that rotating it takes.
 */
async function syncVault(options: SyncOptions) {
  const { client, agents, githubToken: token, dryRun, say } = options;
  const urls = [...new Set(agents.flatMap((agent) => agent.mcp_servers.map((s) => s.url)))];
  let vault;
  for await (const candidate of client.beta.vaults.list()) {
    if (candidate.display_name === VAULT_NAME && candidate.archived_at === null) vault = candidate;
  }
  if (token === undefined || token === "") {
    // Without the token, sessions cannot start once the agent needs a vault: say so loudly.
    options.warn(
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
