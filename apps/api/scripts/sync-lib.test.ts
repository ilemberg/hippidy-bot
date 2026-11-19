import type { Anthropic } from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { digest, parseAgentFile, readAgentFiles, readEnvironmentFile } from "./agent-files.ts";
import {
  DIGEST_KEY,
  MCP_SERVER_SECRETS,
  secretForMcpServer,
  syncAll,
  VAULT_NAME,
} from "./sync-lib.ts";

interface Stored {
  id: string;
  name: string;
  archived_at: string | null;
  metadata: Record<string, string>;
  version: number;
  body: Record<string, unknown>;
}

/** An in-memory stand-in for the parts of Anthropic's API the sync uses. */
function fakeClient() {
  const agents: Stored[] = [];
  const environments: Stored[] = [];
  const vaults: { id: string; display_name: string; archived_at: string | null }[] = [];
  const credentials: {
    id: string;
    archived_at: null;
    display_name: string;
    auth: Record<string, string>;
  }[] = [];
  const calls: string[] = [];
  let next = 1;
  const list = <T>(items: T[]) =>
    async function* () {
      for (const item of items) yield await Promise.resolve(item);
    };
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
  const client = {
    beta: {
      agents: store(agents, "agent"),
      environments: store(environments, "env"),
      vaults: {
        list: () => list(vaults)(),
        create: (body: { display_name: string }) => {
          const vault = { id: `vlt_${next++}`, display_name: body.display_name, archived_at: null };
          vaults.push(vault);
          calls.push(`vault.create ${body.display_name}`);
          return Promise.resolve(vault);
        },
        credentials: {
          list: () => list(credentials)(),
          create: (
            _vault: string,
            body: { display_name: string; auth: Record<string, string> },
          ) => {
            credentials.push({
              id: `cred_${next++}`,
              archived_at: null,
              display_name: body.display_name,
              auth: body.auth,
            });
            calls.push(`credential.create ${String(body.auth.mcp_server_url)}`);
            return Promise.resolve({});
          },
          update: (id: string, body: { auth: { token: string } }) => {
            const stored = credentials.find((credential) => credential.id === id);
            if (stored === undefined) throw new Error(`no ${id}`);
            stored.auth = { ...stored.auth, token: body.auth.token };
            calls.push(`credential.update ${String(stored.auth.mcp_server_url)}`);
            return Promise.resolve({});
          },
          archive: (id: string) => {
            const stored = credentials.find((credential) => credential.id === id);
            calls.push(`credential.archive ${String(stored?.auth.mcp_server_url)}`);
            return Promise.resolve({});
          },
        },
      },
    },
  } as unknown as Anthropic;
  return { client, agents, environments, vaults, credentials, calls };
}

const environment = readEnvironmentFile("environments/hippidy.yaml");
const agentFiles = readAgentFiles("agents");

const GITHUB_URL = "https://api.githubcopilot.com/mcp/x/all";
const ATLASSIAN_URL = "https://mcp.atlassian.com/v2/mcp";
const bothSecrets = {
  AGENT_GITHUB_TOKEN: "github_pat_test",
  ATLASSIAN_SERVICE_KEY: "atlassian_key_test",
};

function run(
  client: Anthropic,
  agents = agentFiles,
  secrets: Record<string, string | undefined> = bothSecrets,
) {
  const said: string[] = [];
  return syncAll({
    client,
    agents,
    environment,
    secrets,
    dryRun: false,
    say: (line) => said.push(line),
    warn: (line) => said.push(line),
  }).then(() => said);
}

describe("syncAll", () => {
  it("reads every agent file in agents/, the engineer and the product agent", () => {
    expect(agentFiles.map((agent) => agent.name)).toEqual(["hippidy-bot", "hippidy-bot-product"]);
  });

  it("creates each agent once, by name, in the one environment, with one vault", async () => {
    const fake = fakeClient();
    await run(fake.client);
    expect(fake.calls).toEqual([
      "env.create hippidy-bot",
      `vault.create ${VAULT_NAME}`,
      `credential.create ${GITHUB_URL}`,
      `credential.create ${ATLASSIAN_URL}`,
      "agent.create hippidy-bot",
      "agent.create hippidy-bot-product",
    ]);
    expect(fake.environments).toHaveLength(1);
    expect(fake.vaults).toHaveLength(1);
    const product = fake.agents.find((agent) => agent.name === "hippidy-bot-product");
    expect(product?.body).toMatchObject({
      model: "claude-opus-5-5",
      mcp_servers: [{ type: "url", name: "atlassian", url: ATLASSIAN_URL }],
    });
  });

  it("sends the engineer exactly what it sent before there were two agents", async () => {
    const fake = fakeClient();
    await run(fake.client);
    const wanted = agentFiles.find((agent) => agent.name === "hippidy-bot");
    if (wanted === undefined) throw new Error("no engineer agent file");
    const body = {
      name: wanted.name,
      description: wanted.description,
      model: wanted.model,
      system: wanted.system,
      mcp_servers: wanted.mcp_servers,
      tools: wanted.tools,
    };
    const engineer = fake.agents.find((agent) => agent.name === "hippidy-bot");
    expect(engineer?.body).toEqual({ ...body, metadata: { [DIGEST_KEY]: digest(body) } });
  });

  it("changes nothing on a second run, and updates only the agent whose file changed", async () => {
    const fake = fakeClient();
    await run(fake.client);
    fake.calls.length = 0;
    await run(fake.client);
    expect(fake.calls).toEqual([
      `credential.update ${GITHUB_URL}`,
      `credential.update ${ATLASSIAN_URL}`,
    ]);

    fake.calls.length = 0;
    const changed = agentFiles.map((agent) =>
      agent.name === "hippidy-bot-product" ? { ...agent, system: `${agent.system}\nMore.` } : agent,
    );
    const said = await run(fake.client, changed);
    expect(fake.calls).toEqual([
      `credential.update ${GITHUB_URL}`,
      `credential.update ${ATLASSIAN_URL}`,
      "agent.update hippidy-bot-product",
    ]);
    expect(said).toContainEqual(expect.stringMatching(/agent "hippidy-bot": unchanged/));
    expect(fake.agents.map((agent) => [agent.name, agent.version])).toEqual([
      ["hippidy-bot", 1],
      ["hippidy-bot-product", 2],
    ]);
  });

  it("refuses two agent files with the same name, before changing anything", async () => {
    const fake = fakeClient();
    const twin = parseAgentFile(
      "---\nname: hippidy-bot\ndescription: d\nmodel: m\ntools: []\n---\n\nP.",
    );
    await expect(run(fake.client, [...agentFiles, twin])).rejects.toThrow(/two agent files/);
    expect(fake.calls).toEqual([]);
  });
});

describe("the vault: one credential per MCP server, each from its own secret", () => {
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

  it("writes each server's own secret into its credential, with both present", async () => {
    const fake = fakeClient();
    await run(fake.client);
    expect(
      fake.credentials.map((credential) => [
        credential.display_name,
        credential.auth.mcp_server_url,
        credential.auth.token,
      ]),
    ).toEqual([
      ["GitHub (AGENT_GITHUB_TOKEN)", GITHUB_URL, "github_pat_test"],
      ["Atlassian (ATLASSIAN_SERVICE_KEY)", ATLASSIAN_URL, "atlassian_key_test"],
    ]);

    await run(fake.client, agentFiles, {
      AGENT_GITHUB_TOKEN: "github_pat_new",
      ATLASSIAN_SERVICE_KEY: "atlassian_key_new",
    });
    expect(fake.credentials.map((credential) => credential.auth.token)).toEqual([
      "github_pat_new",
      "atlassian_key_new",
    ]);
  });

  it("without the Atlassian key, leaves GitHub's credential working and warns", async () => {
    const fake = fakeClient();
    const said = await run(fake.client, agentFiles, { AGENT_GITHUB_TOKEN: "github_pat_test" });
    expect(fake.calls).toContain(`credential.create ${GITHUB_URL}`);
    expect(fake.calls).not.toContain(`credential.create ${ATLASSIAN_URL}`);
    expect(said).toContainEqual(
      expect.stringMatching(/^::warning::ATLASSIAN_SERVICE_KEY is not set, .* was not made/),
    );

    // Once both exist, a run without the key refreshes GitHub's and leaves Atlassian's alone.
    await run(fake.client);
    fake.calls.length = 0;
    const later = await run(fake.client, agentFiles, { AGENT_GITHUB_TOKEN: "github_pat_new" });
    expect(fake.calls).toEqual([`credential.update ${GITHUB_URL}`]);
    expect(fake.credentials.map((credential) => credential.auth.token)).toEqual([
      "github_pat_new",
      "atlassian_key_test",
    ]);
    expect(later).toContainEqual(
      expect.stringMatching(/^::warning::ATLASSIAN_SERVICE_KEY is not set, .* was not updated/),
    );
  });

  it("without the GitHub token, warns as before and leaves GitHub's credential alone", async () => {
    const fake = fakeClient();
    await run(fake.client);
    fake.calls.length = 0;
    const said = await run(fake.client, agentFiles, { ATLASSIAN_SERVICE_KEY: "atlassian_key_new" });
    expect(fake.calls).toEqual([`credential.update ${ATLASSIAN_URL}`]);
    expect(fake.credentials.map((credential) => credential.auth.token)).toEqual([
      "github_pat_test",
      "atlassian_key_new",
    ]);
    expect(said).toContainEqual(
      expect.stringMatching(/^::warning::AGENT_GITHUB_TOKEN is not set, .*Slice 4 setup/),
    );
  });

  it("makes no vault when no secret is set", async () => {
    const fake = fakeClient();
    const said = await run(fake.client, agentFiles, {});
    expect(fake.vaults).toEqual([]);
    expect(said.filter((line) => line.startsWith("::warning::"))).toHaveLength(2);
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
    expect(fake.calls).toEqual([
      `credential.update ${GITHUB_URL}`,
      `credential.update ${ATLASSIAN_URL}`,
      "agent.create stranger",
    ]);
    expect(fake.credentials.map((credential) => credential.auth.mcp_server_url)).toEqual([
      GITHUB_URL,
      ATLASSIAN_URL,
    ]);
  });
});
