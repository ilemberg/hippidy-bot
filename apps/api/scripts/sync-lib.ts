// What `pnpm agent:sync` does (sync-agent.ts), with the client passed in so it can be tested
// against a fake.
import type { Anthropic } from "@anthropic-ai/sdk";
import type { BetaCloudConfigParams } from "@anthropic-ai/sdk/resources/beta/environments";
import { digest, type AgentFile, type EnvironmentFile } from "./agent-files.ts";

/** Where the digest of what was last sent is kept, on each agent and environment. */
export const DIGEST_KEY = "synced_digest";

/**
 * Each agent has a vault of its own, named after the agent (slice 2.1, part E): `hippidy-bot`
 * for the coding worker, `hippidy-bot-product`, `hippidy-bot-teammate`. Must match the vault
 * names in src/agent/config.ts: the API finds each by this name.
 */
export function vaultNameFor(agent: Pick<AgentFile, "name">): string {
  return agent.name;
}

export interface SyncOptions {
  client: Anthropic;
  /** Every agent file in `agents/`, each synced on its own and found by its name. */
  agents: readonly AgentFile[];
  /** Every environment file in `environments/`, each synced on its own and found by its name. */
  environments: readonly EnvironmentFile[];
  /**
   * Where the MCP servers' credentials come from: the process environment, read by the
   * variable names in MCP_SERVER_SECRETS. A missing or empty one leaves its own credentials as
   * they are.
   */
  secrets: Readonly<Record<string, string | undefined>>;
  dryRun: boolean;
  say: (line: string) => void;
  /** A GitHub Actions annotation, printed as it is, even in a dry run. */
  warn: (line: string) => void;
}

/**
 * Syncs every environment, every agent's vault and every agent: creates each the first time,
 * updates it when its file changes (an agent update is a new version), and does nothing when
 * it already matches.
 */
export async function syncAll(options: SyncOptions): Promise<void> {
  refuseRepeatedNames(
    "agent",
    options.agents.map((agent) => agent.name),
  );
  refuseRepeatedNames(
    "environment",
    options.environments.map((environment) => environment.name),
  );
  for (const environment of options.environments) await syncEnvironment(options, environment);
  // The vaults before the agents: the API needs an agent's vault the moment the agent can use
  // its MCP tools.
  for (const agent of options.agents) await syncVault(options, agent);
  for (const agent of options.agents) await syncAgent(options, agent);
}

function refuseRepeatedNames(kind: string, names: readonly string[]): void {
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated !== undefined) {
    throw new Error(`two ${kind} files are named "${repeated}"; each ${kind} needs its own name`);
  }
}

function cloudConfig(wanted: EnvironmentFile): BetaCloudConfigParams {
  const { networking, packages } = wanted.config;
  return {
    type: "cloud",
    networking,
    ...(packages === undefined ? {} : { packages: { type: "packages", ...packages } }),
  };
}

async function syncEnvironment({ client, dryRun, say }: SyncOptions, wanted: EnvironmentFile) {
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
  // GitHub's MCP server, for the coding worker (decisions 105, 116, 122).
  {
    host: "api.githubcopilot.com",
    variable: "AGENT_GITHUB_TOKEN",
    displayName: "GitHub (AGENT_GITHUB_TOKEN)",
    readme: "Slice 4 setup: the GitHub token",
  },
  // Atlassian's MCP server, for the teammate and the product agent: the service account's key
  // (decisions 151, 166; slice 5A part F).
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
 * Keeps an agent's own vault (vaultNameFor): one static bearer credential for each MCP server
 * the agent declares, and nothing else (slice 2.1, part E), so that one agent's sessions never
 * hold another agent's credentials. Each comes from its own secret (MCP_SERVER_SECRETS):
 * GitHub's from AGENT_GITHUB_TOKEN, Atlassian's from ATLASSIAN_SERVICE_KEY. A stored token
 * cannot be read back, so each is written on every sync: running the sync after a secret is
 * replaced is all that rotating it takes. A missing secret leaves its own credential as it is,
 * with a warning; a server with no known secret is skipped, with a warning. A credential for a
 * server the agent does not declare is archived.
 */
async function syncVault(options: SyncOptions, agent: AgentFile) {
  const { client, secrets, dryRun, say, warn } = options;
  const name = vaultNameFor(agent);
  const urls = [...new Set(agent.mcp_servers.map((server) => server.url))];
  let vault;
  for await (const candidate of client.beta.vaults.list()) {
    if (candidate.display_name === name && candidate.archived_at === null) vault = candidate;
  }
  const wanted: { url: string; token: string; secret: McpServerSecret }[] = [];
  for (const url of urls) {
    const secret = secretForMcpServer(url);
    if (secret === undefined) {
      warn(
        `::warning::MCP server ${url} has no known secret, so it has no credential in vault ` +
          `"${name}". Add its host to MCP_SERVER_SECRETS in apps/api/scripts/sync-lib.ts.`,
      );
      continue;
    }
    const token = secrets[secret.variable];
    if (token === undefined || token === "") {
      // Without it, this agent's sessions cannot use this server: say so loudly.
      warn(
        `::warning::${secret.variable} is not set, so the credential for ${url} in vault ` +
          `"${name}" was not ${vault === undefined ? "made" : "updated"}. See the ` +
          `README's "${secret.readme}".`,
      );
      continue;
    }
    wanted.push({ url, token, secret });
  }
  if (vault === undefined) {
    if (wanted.length === 0) return;
    say(`vault "${name}": create`);
    if (dryRun) {
      for (const { url } of wanted) say(`vault "${name}": add credential for ${url}`);
      return;
    }
    vault = await client.beta.vaults.create({ display_name: name });
    say(`vault "${name}": created ${vault.id}`);
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
      say(`vault "${name}": add credential for ${url}`);
      if (!dryRun) {
        await client.beta.vaults.credentials.create(vault.id, {
          display_name: secret.displayName,
          auth: { type: "static_bearer", mcp_server_url: url, token },
        });
      }
    } else {
      say(`vault "${name}": refresh the token for ${url}`);
      if (!dryRun) {
        await client.beta.vaults.credentials.update(existing.id, {
          vault_id: vault.id,
          auth: { type: "static_bearer", token },
        });
      }
    }
  }
  // Only a server this agent does not declare loses its credential, whether another agent
  // uses it or none does: a missing secret or an unknown server above never archives anything.
  for (const credential of credentials) {
    const url = "mcp_server_url" in credential.auth ? credential.auth.mcp_server_url : undefined;
    if (url !== undefined && !urls.includes(url)) {
      say(`vault "${name}": archive the credential for ${url}, not a server of "${agent.name}"`);
      if (!dryRun) {
        await client.beta.vaults.credentials.archive(credential.id, { vault_id: vault.id });
      }
    }
  }
}
