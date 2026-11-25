import type { Anthropic } from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  digest,
  parseAgentFile,
  readAgentFiles,
  readEnvironmentFiles,
  type AgentFile,
} from "./agent-files.ts";
import {
  DIGEST_KEY,
  MCP_SERVER_SECRETS,
  secretForMcpServer,
  syncAll,
  vaultNameFor,
} from "./sync-lib.ts";

interface Stored {
  id: string;
  name: string;
  archived_at: string | null;
  metadata: Record<string, string>;
  version: number;
  body: Record<string, unknown>;
}

interface StoredCredential {
  id: string;
  vault: string;
  archived_at: string | null;
  display_name: string;
  auth: Record<string, string>;
}

/** An in-memory stand-in for the parts of Anthropic's API the sync uses. */
function fakeClient() {
  const agents: Stored[] = [];
  const environments: Stored[] = [];
  const vaults: { id: string; display_name: string; archived_at: string | null }[] = [];
  const credentials: StoredCredential[] = [];
  const calls: string[] = [];
  let next = 1;
  const list = <T>(items: T[]) =>
    async function* () {
      for (const item of items) yield await Promise.resolve(item);
    };
  const vaultName = (id: string) => vaults.find((vault) => vault.id === id)?.display_name ?? id;
  const store = (items: Stored[], kind: string) => ({
    list: () => list(items)(),
    create: (
      body: Record<string, unknown> & { name: string; metadata: Record<string, string> },
    ) => {
      const stored = {
        id: `${kind}_${next++}`,
        name: body.name,
        archived_at: null,
        metadata: body.metadata,
        version: 1,
        body,
      };
      items.push(stored);
      calls.push(`${kind}.create ${body.name}`);
      return Promise.resolve(stored);
    },
    update: (id: string, body: Record<string, unknown> & { metadata: Record<string, string> }) => {
      const stored = items.find((item) => item.id === id);
      if (stored === undefined) throw new Error(`no ${id}`);
      stored.metadata = body.metadata;
      stored.version += 1;
      stored.body = { ...stored.body, ...body };
      calls.push(`${kind}.update ${stored.name}`);
      return Promise.resolve(stored);
    },
  });
  const addVault = (displayName: string) => {
    const vault = { id: `vlt_${next++}`, display_name: displayName, archived_at: null };
    vaults.push(vault);
    return vault;
  };
  const addCredential = (vault: string, displayName: string, auth: Record<string, string>) => {
    credentials.push({
      id: `cred_${next++}`,
      vault,
      archived_at: null,
      display_name: displayName,
      auth,
    });
  };
  const credentialIn = (id: string, vault: string) => {
    const stored = credentials.find((credential) => credential.id === id);
    if (stored?.vault !== vault) throw new Error(`no ${id} in ${vault}`);
    return stored;
  };
  const client = {
    beta: {
      agents: store(agents, "agent"),
      environments: store(environments, "env"),
      vaults: {
        list: () => list(vaults)(),
        create: (body: { display_name: string }) => {
          calls.push(`vault.create ${body.display_name}`);
          return Promise.resolve(addVault(body.display_name));
        },
        credentials: {
          list: (vault: string) =>
            list(credentials.filter((credential) => credential.vault === vault))(),
          create: (vault: string, body: { display_name: string; auth: Record<string, string> }) => {
            addCredential(vault, body.display_name, body.auth);
            calls.push(`credential.create ${vaultName(vault)} ${String(body.auth.mcp_server_url)}`);
            return Promise.resolve({});
          },
          update: (id: string, body: { vault_id: string; auth: { token: string } }) => {
            const stored = credentialIn(id, body.vault_id);
            stored.auth = { ...stored.auth, token: body.auth.token };
            calls.push(
              `credential.update ${vaultName(stored.vault)} ${String(stored.auth.mcp_server_url)}`,
            );
            return Promise.resolve({});
          },
          archive: (id: string, body: { vault_id: string }) => {
            const stored = credentialIn(id, body.vault_id);
            stored.archived_at = "2026-11-25T00:00:00Z";
            calls.push(
              `credential.archive ${vaultName(stored.vault)} ${String(stored.auth.mcp_server_url)}`,
            );
            return Promise.resolve({});
          },
        },
      },
    },
  } as unknown as Anthropic;
  /** What each vault holds now: its live credentials' server URLs and tokens. */
  const held = () =>
    Object.fromEntries(
      vaults.map((vault) => [
        vault.display_name,
        credentials
          .filter((credential) => credential.vault === vault.id && credential.archived_at === null)
          .map((credential) => [credential.auth.mcp_server_url, credential.auth.token]),
      ]),
    );
  return {
    client,
    agents,
    environments,
    vaults,
    credentials,
    calls,
    held,
    addVault,
    addCredential,
  };
}

const environmentFiles = readEnvironmentFiles("environments");
const agentFiles = readAgentFiles("agents");

const GITHUB_URL = "https://api.githubcopilot.com/mcp/x/all";
const ATLASSIAN_URL = "https://mcp.atlassian.com/v2/mcp";
const WORKER = "hippidy-bot";
const PRODUCT = "hippidy-bot-product";
const TEAMMATE = "hippidy-bot-teammate";
const bothSecrets = {
  AGENT_GITHUB_TOKEN: "github_pat_test",
  ATLASSIAN_SERVICE_KEY: "atlassian_key_test",
};

function run(
  client: Anthropic,
  agents: readonly AgentFile[] = agentFiles,
  secrets: Record<string, string | undefined> = bothSecrets,
  environments = environmentFiles,
) {
  const said: string[] = [];
  return syncAll({
    client,
    agents,
    environments,
    secrets,
    dryRun: false,
    say: (line) => said.push(line),
    warn: (line) => said.push(line),
  }).then(() => said);
}

/** The credential refreshes every run makes with both secrets set, in order. */
const refreshes = [
  `credential.update ${WORKER} ${GITHUB_URL}`,
  `credential.update ${PRODUCT} ${ATLASSIAN_URL}`,
  `credential.update ${TEAMMATE} ${ATLASSIAN_URL}`,
];

const allHeld = (github: string, atlassian: string) => ({
  [WORKER]: [[GITHUB_URL, github]],
  [PRODUCT]: [[ATLASSIAN_URL, atlassian]],
  [TEAMMATE]: [[ATLASSIAN_URL, atlassian]],
});

describe("syncAll", () => {
  it("reads every agent file in agents/ and every environment in environments/", () => {
    expect(agentFiles.map((agent) => agent.name)).toEqual([WORKER, PRODUCT, TEAMMATE]);
    expect(environmentFiles.map((environment) => environment.name)).toEqual([
      "hippidy-bot",
      "hippidy-bot-teammate",
    ]);
  });

  it("creates each environment, vault and agent once, by name", async () => {
    const fake = fakeClient();
    await run(fake.client);
    expect(fake.calls).toEqual([
      "env.create hippidy-bot",
      "env.create hippidy-bot-teammate",
      `vault.create ${WORKER}`,
      `credential.create ${WORKER} ${GITHUB_URL}`,
      `vault.create ${PRODUCT}`,
      `credential.create ${PRODUCT} ${ATLASSIAN_URL}`,
      `vault.create ${TEAMMATE}`,
      `credential.create ${TEAMMATE} ${ATLASSIAN_URL}`,
      `agent.create ${WORKER}`,
      `agent.create ${PRODUCT}`,
      `agent.create ${TEAMMATE}`,
    ]);
    const teammate = fake.agents.find((agent) => agent.name === TEAMMATE);
    expect(teammate?.body).toMatchObject({
      model: "claude-opus-5-5",
      mcp_servers: [{ type: "url", name: "atlassian", url: ATLASSIAN_URL }],
    });
    const environment = fake.environments.find((stored) => stored.name === TEAMMATE);
    expect(environment?.body).toMatchObject({
      config: {
        type: "cloud",
        networking: {
          type: "limited",
          allow_package_managers: false,
          allow_mcp_servers: true,
          allowed_hosts: [],
        },
      },
    });
  });

  it("gives each agent a vault named after it, with its own servers' credentials only", async () => {
    const fake = fakeClient();
    await run(fake.client);
    expect(agentFiles.map(vaultNameFor)).toEqual([WORKER, PRODUCT, TEAMMATE]);
    expect(fake.held()).toEqual(allHeld("github_pat_test", "atlassian_key_test"));
  });

  it("sends the engineer exactly what its file says", async () => {
    const fake = fakeClient();
    await run(fake.client);
    const wanted = agentFiles.find((agent) => agent.name === WORKER);
    if (wanted === undefined) throw new Error("no engineer agent file");
    const body = {
      name: wanted.name,
      description: wanted.description,
      model: wanted.model,
      system: wanted.system,
      mcp_servers: wanted.mcp_servers,
      tools: wanted.tools,
    };
    const engineer = fake.agents.find((agent) => agent.name === WORKER);
    expect(engineer?.body).toEqual({ ...body, metadata: { [DIGEST_KEY]: digest(body) } });
  });

  it("changes nothing on a second run, and updates only the agent whose file changed", async () => {
    const fake = fakeClient();
    await run(fake.client);
    fake.calls.length = 0;
    await run(fake.client);
    expect(fake.calls).toEqual(refreshes);

    fake.calls.length = 0;
    const changed = agentFiles.map((agent) =>
      agent.name === PRODUCT ? { ...agent, system: `${agent.system}\nMore.` } : agent,
    );
    const said = await run(fake.client, changed);
    expect(fake.calls).toEqual([...refreshes, `agent.update ${PRODUCT}`]);
    expect(said).toContainEqual(expect.stringMatching(/agent "hippidy-bot": unchanged/));
    expect(fake.agents.map((agent) => [agent.name, agent.version])).toEqual([
      [WORKER, 1],
      [PRODUCT, 2],
      [TEAMMATE, 1],
    ]);
  });

  it("updates only the environment whose file changed", async () => {
    const fake = fakeClient();
    await run(fake.client);
    fake.calls.length = 0;
    const changed = environmentFiles.map((environment) =>
      environment.name === TEAMMATE
        ? { ...environment, description: `${environment.description} More.` }
        : environment,
    );
    const said = await run(fake.client, agentFiles, bothSecrets, changed);
    expect(fake.calls).toEqual([`env.update ${TEAMMATE}`, ...refreshes]);
    expect(said).toContainEqual(expect.stringMatching(/environment "hippidy-bot": unchanged/));
  });

  it("refuses two agent files with the same name, before changing anything", async () => {
    const fake = fakeClient();
    const twin = parseAgentFile(
      "---\nname: hippidy-bot\ndescription: d\nmodel: m\ntools: []\n---\n\nP.",
    );
    await expect(run(fake.client, [...agentFiles, twin])).rejects.toThrow(/two agent files/);
    expect(fake.calls).toEqual([]);
  });

  it("refuses two environment files with the same name, before changing anything", async () => {
    const fake = fakeClient();
    const [first] = environmentFiles;
    if (first === undefined) throw new Error("no environment file");
    await expect(
      run(fake.client, agentFiles, bothSecrets, [...environmentFiles, first]),
    ).rejects.toThrow(/two environment files/);
    expect(fake.calls).toEqual([]);
  });
});

describe("the vaults: one per agent, one credential per MCP server, each from its own secret", () => {
  it("knows the secret for each MCP server by its exact host, and no other", () => {
    expect(secretForMcpServer(GITHUB_URL)?.variable).toBe("AGENT_GITHUB_TOKEN");
    expect(secretForMcpServer(ATLASSIAN_URL)?.variable).toBe("ATLASSIAN_SERVICE_KEY");
    expect(secretForMcpServer("https://mcp.atlassian.com.example.com/v2/mcp")).toBeUndefined();
    expect(secretForMcpServer("https://example.com/mcp")).toBeUndefined();
    expect(secretForMcpServer("not a url")).toBeUndefined();
    // Every server an agent file names has a secret.
    for (const agent of agentFiles) {
      for (const server of agent.mcp_servers) {
        expect(secretForMcpServer(server.url), server.url).toBeDefined();
      }
    }
    expect(MCP_SERVER_SECRETS.map((secret) => secret.variable)).toEqual([
      "AGENT_GITHUB_TOKEN",
      "ATLASSIAN_SERVICE_KEY",
    ]);
  });

  it("writes each server's own secret into its credentials, and rotates them all", async () => {
    const fake = fakeClient();
    await run(fake.client);
    expect(
      fake.credentials.map((credential) => [credential.display_name, credential.auth.token]),
    ).toEqual([
      ["GitHub (AGENT_GITHUB_TOKEN)", "github_pat_test"],
      ["Atlassian (ATLASSIAN_SERVICE_KEY)", "atlassian_key_test"],
      ["Atlassian (ATLASSIAN_SERVICE_KEY)", "atlassian_key_test"],
    ]);

    await run(fake.client, agentFiles, {
      AGENT_GITHUB_TOKEN: "github_pat_new",
      ATLASSIAN_SERVICE_KEY: "atlassian_key_new",
    });
    expect(fake.held()).toEqual(allHeld("github_pat_new", "atlassian_key_new"));
  });

  it("splits the one shared vault of before: the worker's keeps GitHub's credential only", async () => {
    const fake = fakeClient();
    const shared = fake.addVault(WORKER);
    fake.addCredential(shared.id, "GitHub (AGENT_GITHUB_TOKEN)", {
      type: "static_bearer",
      mcp_server_url: GITHUB_URL,
      token: "github_pat_old",
    });
    fake.addCredential(shared.id, "Atlassian (ATLASSIAN_SERVICE_KEY)", {
      type: "static_bearer",
      mcp_server_url: ATLASSIAN_URL,
      token: "atlassian_key_old",
    });
    const said = await run(fake.client);
    expect(fake.calls).toContain(`credential.update ${WORKER} ${GITHUB_URL}`);
    expect(fake.calls).toContain(`credential.archive ${WORKER} ${ATLASSIAN_URL}`);
    expect(fake.calls).not.toContain(`vault.create ${WORKER}`);
    expect(fake.held()).toEqual(allHeld("github_pat_test", "atlassian_key_test"));
    expect(said).toContainEqual(
      `vault "${WORKER}": archive the credential for ${ATLASSIAN_URL}, not a server of "${WORKER}"`,
    );
  });

  it("archives a credential when its agent stops declaring the server, in that vault only", async () => {
    const fake = fakeClient();
    await run(fake.client);
    fake.calls.length = 0;
    const withoutAtlassian = agentFiles.map((agent) =>
      agent.name === TEAMMATE ? { ...agent, mcp_servers: [], tools: [] } : agent,
    );
    await run(fake.client, withoutAtlassian);
    expect(fake.calls).toEqual([
      `credential.update ${WORKER} ${GITHUB_URL}`,
      `credential.update ${PRODUCT} ${ATLASSIAN_URL}`,
      `credential.archive ${TEAMMATE} ${ATLASSIAN_URL}`,
      `agent.update ${TEAMMATE}`,
    ]);
    expect(fake.held()).toEqual({
      [WORKER]: [[GITHUB_URL, "github_pat_test"]],
      [PRODUCT]: [[ATLASSIAN_URL, "atlassian_key_test"]],
      [TEAMMATE]: [],
    });
  });

  it("without the Atlassian key, leaves GitHub's credential working and warns", async () => {
    const fake = fakeClient();
    const said = await run(fake.client, agentFiles, { AGENT_GITHUB_TOKEN: "github_pat_test" });
    expect(fake.calls).toContain(`credential.create ${WORKER} ${GITHUB_URL}`);
    expect(fake.vaults.map((vault) => vault.display_name)).toEqual([WORKER]);
    for (const vault of [PRODUCT, TEAMMATE]) {
      expect(said).toContainEqual(
        `::warning::ATLASSIAN_SERVICE_KEY is not set, so the credential for ${ATLASSIAN_URL} in ` +
          `vault "${vault}" was not made. See the README's "Slice 5A: the product agent".`,
      );
    }

    // Once all exist, a run without the key refreshes GitHub's and leaves Atlassian's alone.
    await run(fake.client);
    fake.calls.length = 0;
    const later = await run(fake.client, agentFiles, { AGENT_GITHUB_TOKEN: "github_pat_new" });
    expect(fake.calls).toEqual([`credential.update ${WORKER} ${GITHUB_URL}`]);
    expect(fake.held()).toEqual(allHeld("github_pat_new", "atlassian_key_test"));
    expect(later).toContainEqual(
      expect.stringMatching(/^::warning::ATLASSIAN_SERVICE_KEY is not set, .* was not updated/),
    );
  });

  it("without the GitHub token, warns as before and leaves GitHub's credential alone", async () => {
    const fake = fakeClient();
    await run(fake.client);
    fake.calls.length = 0;
    const said = await run(fake.client, agentFiles, { ATLASSIAN_SERVICE_KEY: "atlassian_key_new" });
    expect(fake.calls).toEqual([
      `credential.update ${PRODUCT} ${ATLASSIAN_URL}`,
      `credential.update ${TEAMMATE} ${ATLASSIAN_URL}`,
    ]);
    expect(fake.held()).toEqual(allHeld("github_pat_test", "atlassian_key_new"));
    expect(said).toContainEqual(
      expect.stringMatching(/^::warning::AGENT_GITHUB_TOKEN is not set, .*Slice 4 setup/),
    );
  });

  it("makes no vault when no secret is set", async () => {
    const fake = fakeClient();
    const said = await run(fake.client, agentFiles, {});
    expect(fake.vaults).toEqual([]);
    expect(said.filter((line) => line.startsWith("::warning::"))).toHaveLength(3);
  });

  it("skips an MCP server with no known secret, with a warning, and archives nothing", async () => {
    const fake = fakeClient();
    await run(fake.client);
    fake.calls.length = 0;
    const stranger = parseAgentFile(
      [
        "---",
        "name: stranger",
        "description: d",
        "model: m",
        "mcp_servers:",
        "  - { type: url, name: other, url: 'https://mcp.example.com/mcp' }",
        "tools:",
        "  - { type: mcp_toolset, mcp_server_name: other }",
        "---",
        "",
        "P.",
      ].join("\n"),
    );
    const said = await run(fake.client, [...agentFiles, stranger]);
    expect(said).toContainEqual(
      expect.stringMatching(/^::warning::MCP server https:\/\/mcp\.example\.com\/mcp has no known/),
    );
    expect(fake.calls).toEqual([...refreshes, "agent.create stranger"]);
    expect(fake.vaults.map((vault) => vault.display_name)).not.toContain("stranger");
    expect(fake.credentials.every((credential) => credential.archived_at === null)).toBe(true);
  });
});
