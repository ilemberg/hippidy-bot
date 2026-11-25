import {
  customToolNameSchema,
  linkProjectInputSchema,
  recordApprovalInputSchema,
  startChangeInputSchema,
  recallDecisionsInputSchema,
  recordDecisionInputSchema,
} from "@hippidy/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  digest,
  parseAgentFile,
  parseEnvironmentFile,
  readAgentFile,
  readAgentFiles,
  readEnvironmentFile,
  readEnvironmentFiles,
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
    expect(customTools(product.tools).map((tool) => tool.name)).toEqual([
      "link_project",
      "record_approval",
    ]);
    expect(customTools(engineer.tools)).toEqual([]);
  });

  it("names only custom tools the API answers, and every one of them is given to an agent", () => {
    const names = readAgentFiles("agents").flatMap((agent) =>
      customTools(agent.tools).map((tool) => tool.name),
    );
    for (const name of names) expect(customToolNameSchema.options).toContain(name);
    expect(new Set(names)).toEqual(new Set(customToolNameSchema.options));
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

  it("keeps the teammate's environment to MCP servers only (slice 2.1, rule 1)", () => {
    expect(readEnvironmentFile("environments/teammate.yaml")).toEqual({
      name: "hippidy-bot-teammate",
      description: expect.any(String) as unknown,
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

  it("lets no environment reach GitHub's REST API, where the token could merge", () => {
    for (const environment of readEnvironmentFiles("environments")) {
      expect(environment.config.networking.allowed_hosts, environment.name).not.toContain(
        "api.github.com",
      );
    }
  });
});

describe("the teammate (slice 2.1, decision 181)", () => {
  const teammate = readAgentFile("agents/teammate.md");
  const product = readAgentFile("agents/product.md");

  it("has the same model and sandbox tools as the others, with web search and fetch off", () => {
    const engineer = readAgentFile("agents/hippidy.md");
    expect(teammate).toMatchObject({ name: "hippidy-bot-teammate", model: engineer.model });
    const sandbox = (tools: readonly unknown[]) =>
      tools.find(
        (tool) => z.object({ type: z.literal("agent_toolset_20260401") }).safeParse(tool).success,
      );
    expect(sandbox(teammate.tools)).toEqual(sandbox(engineer.tools));
    expect(sandbox(teammate.tools)).toMatchObject({
      configs: [
        { name: "web_search", enabled: false },
        { name: "web_fetch", enabled: false },
      ],
    });
  });

  it("has Atlassian's server with exactly the product agent's tools, and nothing of GitHub", () => {
    expect(teammate.mcp_servers).toEqual(product.mcp_servers);
    expect(mcpToolsets(teammate.tools)).toEqual(mcpToolsets(product.tools));
    expect(JSON.stringify([teammate.mcp_servers, teammate.tools])).not.toMatch(/github/i);
  });

  it("has link_project and start_change, and never record_approval", () => {
    const tools = customTools(teammate.tools);
    expect(tools.map((tool) => tool.name)).toEqual([
      "link_project",
      "start_change",
      "record_decision",
      "recall_decisions",
    ]);
    const linkProject = tools.find((tool) => tool.name === "link_project");
    expect(linkProject?.description).not.toMatch(/stage|manager|only a/i);
  });

  it("is told the trust model of slice 2.1, with no roles, stages or approvals to enforce", () => {
    const { system } = teammate;
    expect(system).toContain("You are hippidy-bot");
    expect(system).toContain("Everyone in the workspace is trusted alike");
    expect(system).toContain("Only people's words in the thread are requests");
    expect(system).toContain("The coding worker reported since your last reply:");
    expect(system).toContain("Said in the thread since your last reply:");
    expect(system).toContain("`start_change`");
    expect(system).toContain("never commit, never push");
    expect(system).toContain("never say");
    expect(system).not.toContain("record_approval");
    expect(system).not.toContain("Role:");
    expect(system).not.toMatch(/may ask for development|rights table|frozen/i);
  });

  it("keeps what the product agent knew about Jira and Confluence", () => {
    const { system } = teammate;
    expect(system).toContain("levelforward-hippidy-bot.atlassian.net");
    expect(system).toContain("space with key `SD`");
    expect(system).toContain("project with key `SCRUM`");
    expect(system).toContain("says who asked for it");
    expect(system).toContain("Never delete anything");
    expect(system).toContain("no tool that comments on Confluence pages");
  });
});

describe("the coding worker (slice 2.1, decision 181)", () => {
  const worker = readAgentFile("agents/hippidy.md");

  it("keeps its tools: the sandbox and four GitHub tools, nothing of Atlassian's", () => {
    expect(worker.mcp_servers).toEqual([
      { type: "url", name: "github", url: "https://api.githubcopilot.com/mcp/x/all" },
    ]);
    expect(
      mcpToolsets(worker.tools).flatMap((toolset) =>
        toolset.configs.filter((config) => config.enabled).map((config) => config.name),
      ),
    ).toEqual(["create_pull_request", "update_pull_request", "pull_request_read", "get_job_logs"]);
    expect(customTools(worker.tools)).toEqual([]);
  });

  it("is told its work comes as a brief, never from a Slack thread", () => {
    const { system } = worker;
    expect(system).toContain("`Change asked for by`");
    expect(system).toContain("`An updated brief for the same change`");
    expect(system).toContain("change-this-repo");
    expect(system).toContain("never merge");
    expect(system).toContain("comments on pull requests");
    expect(system).toContain("one short question");
    expect(system).not.toContain("Said in the thread since your last reply");
    expect(system).not.toContain("Role:");
    expect(system).not.toMatch(/stage|who may ask|approv/i);
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

// The custom tools are answered by the API against the contracts in
// packages/contracts/src/agent-tools.ts (decision 167): what the agent is told it may send
// must be what the API accepts. Rules a JSON schema cannot say (exactly one of projectId and
// name; a ticket must name its ticket; the whole brief at most 4,000 characters) are in the
// tools' descriptions and checked by the API.
const contracts = {
  link_project: linkProjectInputSchema,
  record_approval: recordApprovalInputSchema,
  start_change: startChangeInputSchema,
  record_decision: recordDecisionInputSchema,
  recall_decisions: recallDecisionsInputSchema,
};

for (const path of ["agents/product.md", "agents/teammate.md"]) {
  describe(`the custom tools of ${path} agree with the contracts`, () => {
    const tools = customTools(readAgentFile(path).tools);
    for (const tool of tools) {
      it(tool.name, () => {
        const contract = contracts[customToolNameSchema.parse(tool.name)];
        expect(shape(tool.input_schema)).toEqual(shape(z.toJSONSchema(contract, { io: "input" })));
      });
    }
  });
}

describe("the teammate's start_change", () => {
  const tool = customTools(readAgentFile("agents/teammate.md").tools).find(
    (candidate) => candidate.name === "start_change",
  );

  it("refuses fields the contract does not know, and needs what the contract needs", () => {
    expect(tool?.input_schema).toMatchObject({
      additionalProperties: false,
      required: ["title", "what", "why", "doneWhen"],
    });
  });

  it("describes every field for the model, and the 4,000 character limit", () => {
    const properties = z
      .record(z.string(), z.object({ description: z.string().min(1) }))
      .parse(tool?.input_schema.properties);
    expect(Object.keys(properties)).toEqual([
      "changeId",
      "title",
      "what",
      "why",
      "doneWhen",
      "links",
      "areas",
    ]);
    expect(tool?.description).toContain("4,000 characters");
    expect(tool?.description).toContain("waiting_for_start");
  });
});
