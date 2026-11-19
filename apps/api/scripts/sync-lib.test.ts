import type { Anthropic } from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { digest, parseAgentFile, readAgentFiles, readEnvironmentFile } from "./agent-files.ts";
import { DIGEST_KEY, syncAll, VAULT_NAME } from "./sync-lib.ts";

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
  const credentials: { id: string; archived_at: null; auth: Record<string, string> }[] = [];
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
          create: (_vault: string, body: { auth: Record<string, string> }) => {
            credentials.push({ id: `cred_${next++}`, archived_at: null, auth: body.auth });
            calls.push(`credential.create ${String(body.auth.mcp_server_url)}`);
            return Promise.resolve({});
          },
          update: () => {
            calls.push("credential.update");
            return Promise.resolve({});
          },
          archive: () => {
            calls.push("credential.archive");
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

function run(client: Anthropic, agents = agentFiles, githubToken = "github_pat_test") {
  const said: string[] = [];
  return syncAll({
    client,
    agents,
    environment,
    githubToken,
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
      "credential.create https://api.githubcopilot.com/mcp/x/all",
      "agent.create hippidy-bot",
      "agent.create hippidy-bot-product",
    ]);
    expect(fake.environments).toHaveLength(1);
    expect(fake.vaults).toHaveLength(1);
    const product = fake.agents.find((agent) => agent.name === "hippidy-bot-product");
    expect(product?.body).toMatchObject({ model: "claude-opus-5-5", mcp_servers: [] });
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
    expect(fake.calls).toEqual(["credential.update"]);

    fake.calls.length = 0;
    const changed = agentFiles.map((agent) =>
      agent.name === "hippidy-bot-product" ? { ...agent, system: `${agent.system}\nMore.` } : agent,
    );
    const said = await run(fake.client, changed);
    expect(fake.calls).toEqual(["credential.update", "agent.update hippidy-bot-product"]);
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
