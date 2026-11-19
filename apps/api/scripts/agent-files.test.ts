import {
  customToolNameSchema,
  linkProjectInputSchema,
  recordApprovalInputSchema,
} from "@hippidy/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  digest,
  parseAgentFile,
  parseEnvironmentFile,
  readAgentFile,
  readEnvironmentFile,
} from "./agent-files.ts";

// The real files in the repo must always parse, so a bad edit fails CI, not the sync.
describe("agent and environment files", () => {
  it("reads agents/hippidy.md", () => {
    const agent = readAgentFile("agents/hippidy.md");
    expect(agent).toMatchObject({ name: "hippidy-bot", model: "claude-opus-5-5" });
    expect(agent.system).toContain("You are hippidy-bot");
    expect(agent.system).not.toContain("---");
  });

  it("reads agents/product.md: same model, no GitHub, web off, the two custom tools", () => {
    const engineer = readAgentFile("agents/hippidy.md");
    const product = readAgentFile("agents/product.md");
    expect(product).toMatchObject({ name: "hippidy-bot-product", model: engineer.model });
    expect(product.tools).toContainEqual(
      engineer.tools.find(
        (tool) => z.object({ type: z.literal("agent_toolset_20260401") }).safeParse(tool).success,
      ),
    );
    expect(customTools(product.tools).map((tool) => tool.name)).toEqual(
      customToolNameSchema.options,
    );
    expect(customTools(engineer.tools)).toEqual([]);
  });

  it("gives the product agent Atlassian's MCP server and no other (decision 147, part F)", () => {
    const product = readAgentFile("agents/product.md");
    expect(product.mcp_servers).toEqual([
      { type: "url", name: "atlassian", url: "https://mcp.atlassian.com/v2/mcp" },
    ]);
    expect(mcpToolsets(product.tools).map((toolset) => toolset.mcp_server_name)).toEqual([
      "atlassian",
    ]);
    // The engineer keeps GitHub's server alone.
    const engineer = readAgentFile("agents/hippidy.md");
    expect(engineer.mcp_servers.map((server) => server.name)).toEqual(["github"]);
  });

  it("enables exactly the listed Atlassian tools, each running without asking", () => {
    const [atlassian] = mcpToolsets(readAgentFile("agents/product.md").tools);
    // Every tool not listed is off, so a tool the server adds later stays off.
    expect(atlassian?.default_config).toEqual({ enabled: false });
    expect(atlassian?.configs.map((config) => config.name)).toEqual([
      "atlassianUserInfo",
      "getAccessibleAtlassianResources",
      "discover",
      "executeRead",
      "search",
      "searchJiraIssuesUsingJql",
      "getJiraIssue",
      "createJiraIssue",
      "editJiraIssue",
      "transitionJiraIssue",
      "listJiraIssueComments",
      "addOrEditJiraIssueComment",
      "searchConfluence",
      "getConfluenceContent",
      "createConfluenceContent",
      "updateConfluenceContent",
    ]);
    for (const config of atlassian?.configs ?? []) {
      expect(config, config.name).toEqual({
        name: config.name,
        enabled: true,
        permission_policy: { type: "always_allow" },
      });
    }
  });

  it("tells the product agent where the plan and tickets live, and to say who asked", () => {
    const { system } = readAgentFile("agents/product.md");
    expect(system).toContain("levelforward-hippidy-bot.atlassian.net");
    expect(system).toContain("space with key `SD`");
    expect(system).toContain("project with key `SCRUM`");
    expect(system).toContain("says who asked for it");
    expect(system).toContain("Never delete anything");
  });

  it("never enables a generic write or anything that deletes for the product agent", () => {
    const [atlassian] = mcpToolsets(readAgentFile("agents/product.md").tools);
    const enabled = (atlassian?.configs ?? [])
      .filter((config) => config.enabled)
      .map((config) => config.name);
    expect(enabled).not.toContain("executeWrite");
    expect(enabled).not.toContain("executeDestructive");
    expect(enabled.filter((name) => /delete|remove|destroy|destructive/i.test(name))).toEqual([]);
  });

  it("reads environments/hippidy.yaml", () => {
    expect(readEnvironmentFile("environments/hippidy.yaml")).toMatchObject({
      name: "hippidy-bot",
      config: { type: "cloud", networking: { type: "limited" } },
    });
  });
});

const agentWith = (frontmatter: string) =>
  `---\nname: a\ndescription: d\nmodel: m\n${frontmatter}\n---\n\nPrompt.\n`;

describe("parseAgentFile", () => {
  it("reads MCP servers and their toolsets", () => {
    const agent = parseAgentFile(
      agentWith(
        [
          "mcp_servers:",
          "  - { type: url, name: github, url: 'https://api.githubcopilot.com/mcp/x/all' }",
          "tools:",
          "  - { type: mcp_toolset, mcp_server_name: github }",
        ].join("\n"),
      ),
    );
    expect(agent.mcp_servers).toEqual([
      { type: "url", name: "github", url: "https://api.githubcopilot.com/mcp/x/all" },
    ]);
  });

  it("has no MCP servers unless it lists some", () => {
    expect(parseAgentFile(agentWith("tools: []")).mcp_servers).toEqual([]);
  });

  it("rejects a server with no toolset, and a toolset with no server", () => {
    expect(() =>
      parseAgentFile(
        agentWith(
          "mcp_servers:\n  - { type: url, name: github, url: 'https://example.com/mcp' }\ntools: []",
        ),
      ),
    ).toThrow(/has no mcp_toolset/);
    expect(() =>
      parseAgentFile(agentWith("tools:\n  - { type: mcp_toolset, mcp_server_name: github }")),
    ).toThrow(/has no MCP server/);
  });

  it("rejects an MCP server that is not https", () => {
    expect(() =>
      parseAgentFile(
        agentWith(
          "mcp_servers:\n  - { type: url, name: g, url: 'http://example.com' }\ntools:\n  - { type: mcp_toolset, mcp_server_name: g }",
        ),
      ),
    ).toThrow();
  });
});

describe("parseEnvironmentFile", () => {
  const environment = (networking: string, extra = "") =>
    `name: e\ndescription: d\nconfig:\n  type: cloud\n  networking:\n${networking}\n${extra}`;

  it("reads allowed hosts and packages", () => {
    const parsed = parseEnvironmentFile(
      environment(
        "    type: limited\n    allow_package_managers: true\n    allow_mcp_servers: true\n    allowed_hosts: [github.com]",
        "  packages:\n    npm: [pnpm@10]",
      ),
    );
    expect(parsed.config.networking.allowed_hosts).toEqual(["github.com"]);
    expect(parsed.config.packages).toEqual({ apt: [], npm: ["pnpm@10"], pip: [] });
  });

  it("rejects packages without package managers", () => {
    expect(() =>
      parseEnvironmentFile(
        environment(
          "    type: limited\n    allow_package_managers: false\n    allow_mcp_servers: true",
          "  packages:\n    npm: [pnpm@10]",
        ),
      ),
    ).toThrow(/allow_package_managers/);
  });
});

describe("digest", () => {
  it("ignores key order and undefined values, and sees any real change", () => {
    expect(digest({ a: 1, b: [1, { c: 2 }] })).toBe(
      digest({ b: [1, { c: 2 }], a: 1, d: undefined }),
    );
    expect(digest({ a: 1 })).not.toBe(digest({ a: 2 }));
    expect(digest({ a: [1, 2] })).not.toBe(digest({ a: [2, 1] }));
  });
});

const customTool = z.strictObject({
  type: z.literal("custom"),
  name: z.string(),
  description: z.string().min(1),
  input_schema: z.looseObject({ type: z.literal("object") }),
});

function customTools(tools: readonly unknown[]): z.infer<typeof customTool>[] {
  return tools.flatMap((tool) => {
    if (z.object({ type: z.literal("custom") }).safeParse(tool).success) {
      return [customTool.parse(tool)];
    }
    return [];
  });
}

const mcpToolset = z.strictObject({
  type: z.literal("mcp_toolset"),
  mcp_server_name: z.string(),
  default_config: z.unknown(),
  configs: z.array(
    z.looseObject({ name: z.string(), enabled: z.boolean(), permission_policy: z.unknown() }),
  ),
});

function mcpToolsets(tools: readonly unknown[]): z.infer<typeof mcpToolset>[] {
  return tools.flatMap((tool) => {
    if (z.object({ type: z.literal("mcp_toolset") }).safeParse(tool).success) {
      return [mcpToolset.parse(tool)];
    }
    return [];
  });
}

/**
 * A JSON schema without what is there for the model to read (descriptions) or what the agent
 * file leaves to the contract alone: defaults, formats and patterns, and the `$schema` line.
 */
function shape(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(shape);
  if (typeof schema !== "object" || schema === null) return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !["description", "default", "format", "pattern", "$schema"].includes(key))
      .map(([key, value]) => [key, shape(value)]),
  );
}

// The product agent's custom tools are answered by the API against the contracts in
// packages/contracts/src/agent-tools.ts (decision 167): what the agent is told it may send
// must be what the API accepts. Rules a JSON schema cannot say (exactly one of projectId and
// name; a ticket must name its ticket) are in the tools' descriptions and checked by the API.
describe("the product agent's custom tools agree with the contracts", () => {
  const tools = customTools(readAgentFile("agents/product.md").tools);
  const contracts = {
    link_project: linkProjectInputSchema,
    record_approval: recordApprovalInputSchema,
  };

  for (const [name, contract] of Object.entries(contracts)) {
    it(name, () => {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(shape(tool?.input_schema)).toEqual(shape(z.toJSONSchema(contract, { io: "input" })));
    });
  }
});
