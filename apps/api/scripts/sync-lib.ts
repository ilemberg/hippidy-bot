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
  /**
   * Where the MCP servers' credentials come from: the process environment, read by the
   * variable names in MCP_SERVER_SECRETS. A missing or empty one leaves its own credential as
   * it is.
   */
  secrets: Readonly<Record<string, string | undefined>>;
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

/** The secret that holds each MCP server's credential, by the server's host. */
export interface McpServerSecret {
  host: string;
  /** The environment variable (a secret in `release`) holding the bearer token. */
  variable: string;
  /** The credential's display name in the vault. */
  displayName: string;
  /** Where the README says how to set it, for the warning when it is missing. */
  readme: string;
}

export const MCP_SERVER_SECRETS: readonly McpServerSecret[] = [
  // GitHub's MCP server, for the engineer agent (decisions 105, 116, 122).
  {
    host: "api.githubcopilot.com",
    variable: "AGENT_GITHUB_TOKEN",
    displayName: "GitHub (AGENT_GITHUB_TOKEN)",
    readme: "Slice 4 setup: the GitHub token",
  },
  // Atlassian's MCP server, for the product agent: the service account's key (decisions 151,
  // 166; slice 5A part F).
  {
    host: "mcp.atlassian.com",
    variable: "ATLASSIAN_SERVICE_KEY",
    displayName: "Atlassian (ATLASSIAN_SERVICE_KEY)",
    readme: "Slice 5A: the product agent",
  },
];

/** The secret for an MCP server's URL, by its exact host; undefined when none is known. */
export function secretForMcpServer(url: string): McpServerSecret | undefined {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  return MCP_SERVER_SECRETS.find((secret) => secret.host === host);
}

/**
 * Keeps one static bearer credential per MCP server URL in the one vault, for the servers of
 * every agent file, each from its own secret (MCP_SERVER_SECRETS): GitHub's from
 * AGENT_GITHUB_TOKEN, Atlassian's from ATLASSIAN_SERVICE_KEY. A stored token cannot be read
 * back, so each is written on every sync: running the sync after a secret is replaced is all
 * that rotating it takes. A missing secret leaves its own credential as it is, with a warning;
 * a server with no known secret is skipped, with a warning. Neither touches another server's
 * credential.
 */
async function syncVault(options: SyncOptions) {
  const { client, agents, secrets, dryRun, say, warn } = options;
  const urls = [...new Set(agents.flatMap((agent) => agent.mcp_servers.map((s) => s.url)))];
  let vault;
  for await (const candidate of client.beta.vaults.list()) {
    if (candidate.display_name === VAULT_NAME && candidate.archived_at === null) vault = candidate;
  }
  const wanted: { url: string; token: string; secret: McpServerSecret }[] = [];
  for (const url of urls) {
    const secret = secretForMcpServer(url);
    if (secret === undefined) {
      warn(
        `::warning::MCP server ${url} has no known secret, so it has no credential in vault ` +
          `"${VAULT_NAME}". Add its host to MCP_SERVER_SECRETS in apps/api/scripts/sync-lib.ts.`,
      );
      continue;
    }
    const token = secrets[secret.variable];
    if (token === undefined || token === "") {
      // Without it, sessions that need this server cannot use it: say so loudly.
      warn(
        `::warning::${secret.variable} is not set, so the credential for ${url} in vault ` +
          `"${VAULT_NAME}" was not ${vault === undefined ? "made" : "updated"}. See the ` +
          `README's "${secret.readme}".`,
      );
      continue;
    }
    wanted.push({ url, token, secret });
  }
  if (vault === undefined) {
    if (wanted.length === 0) return;
    say(`vault "${VAULT_NAME}": create`);
    if (dryRun) {
      for (const { url } of wanted) say(`vault "${VAULT_NAME}": add credential for ${url}`);
      return;
    }
    vault = await client.beta.vaults.create({ display_name: VAULT_NAME });
    say(`vault "${VAULT_NAME}": created ${vault.id}`);
  }
  const credentials = [];
  for await (const credential of client.beta.vaults.credentials.list(vault.id)) {
    if (credential.archived_at === null) credentials.push(credential);
  }
  for (const { url, token, secret } of wanted) {
    const existing = credentials.find(
      (credential) =>
        credential.auth.type === "static_bearer" && credential.auth.mcp_server_url === url,
    );
    if (existing === undefined) {
      say(`vault "${VAULT_NAME}": add credential for ${url}`);
      if (!dryRun) {
        await client.beta.vaults.credentials.create(vault.id, {
          display_name: secret.displayName,
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
  // Only a server no agent file names any more loses its credential: a missing secret or an
  // unknown server above never archives anything.
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
