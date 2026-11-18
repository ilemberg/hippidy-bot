import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/** The repo root, where `agents/` and `environments/` live. */
export const repoRoot = join(import.meta.dirname, "../../..");

const mcpServer = z.strictObject({
  type: z.literal("url"),
  name: z.string().min(1),
  url: z.url({ protocol: /^https$/ }),
});

const agentFrontmatter = z
  .strictObject({
    name: z.string().min(1),
    description: z.string().min(1),
    model: z.string().min(1),
    /** Remote MCP servers, by URL only: their credentials live in the vault (decision 122). */
    mcp_servers: z.array(mcpServer).default([]),
    tools: z.array(z.unknown()),
  })
  .superRefine((agent, context) => {
    // Anthropic rejects a server no toolset uses; say so before the sync does.
    const used = new Set(
      agent.tools.flatMap((tool) => {
        const parsed = z
          .object({ type: z.literal("mcp_toolset"), mcp_server_name: z.string() })
          .safeParse(tool);
        return parsed.success ? [parsed.data.mcp_server_name] : [];
      }),
    );
    for (const server of agent.mcp_servers) {
      if (!used.has(server.name)) {
        context.addIssue({
          code: "custom",
          message: `MCP server "${server.name}" has no mcp_toolset in tools`,
        });
      }
    }
    for (const name of used) {
      if (!agent.mcp_servers.some((server) => server.name === name)) {
        context.addIssue({ code: "custom", message: `mcp_toolset "${name}" has no MCP server` });
      }
    }
  });

export interface AgentFile {
  name: string;
  description: string;
  model: string;
  mcp_servers: z.infer<typeof mcpServer>[];
  tools: unknown[];
  system: string;
}

/** Reads an agent file: YAML frontmatter for the config, Markdown body for the system prompt. */
export function readAgentFile(path: string): AgentFile {
  return parseAgentFile(readFileSync(join(repoRoot, path), "utf8"), path);
}

export function parseAgentFile(text: string, path = "agent file"): AgentFile {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`${path}: expected YAML frontmatter between --- lines, then the prompt`);
  }
  const config = agentFrontmatter.parse(parse(match[1]));
  return { ...config, system: match[2].trim() };
}

const environmentFile = z
  .strictObject({
    name: z.string().min(1),
    description: z.string().min(1),
    config: z.strictObject({
      type: z.literal("cloud"),
      networking: z.strictObject({
        type: z.literal("limited"),
        allow_package_managers: z.boolean(),
        allow_mcp_servers: z.boolean(),
        /** Hosts the sandbox may reach besides package registries and MCP servers. */
        allowed_hosts: z.array(z.string().regex(/^[a-z0-9.-]+$/, "a bare host name")).default([]),
      }),
      /** Installed in every session's sandbox; needs `allow_package_managers`. */
      packages: z
        .strictObject({
          apt: z.array(z.string()).default([]),
          npm: z.array(z.string()).default([]),
          pip: z.array(z.string()).default([]),
        })
        .optional(),
    }),
  })
  .refine(
    (file) => file.config.packages === undefined || file.config.networking.allow_package_managers,
    { message: "packages need networking.allow_package_managers: true" },
  );
export type EnvironmentFile = z.infer<typeof environmentFile>;

export function readEnvironmentFile(path: string): EnvironmentFile {
  return parseEnvironmentFile(readFileSync(join(repoRoot, path), "utf8"));
}

export function parseEnvironmentFile(text: string): EnvironmentFile {
  return environmentFile.parse(parse(text));
}

/**
 * A short digest of what the sync sends, kept in the agent's and environment's metadata. What
 * Anthropic returns is filled in with defaults, so comparing it with the file would always
 * find a change; comparing digests finds only real ones.
 */
export function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 16);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
