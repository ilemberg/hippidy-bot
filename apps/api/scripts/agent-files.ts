import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/** The repo root, where `agents/` and `environments/` live. */
export const repoRoot = join(import.meta.dirname, "../../..");

const agentFrontmatter = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  model: z.string().min(1),
  tools: z.array(z.unknown()),
});

export interface AgentFile {
  name: string;
  description: string;
  model: string;
  tools: unknown[];
  system: string;
}

/** Reads an agent file: YAML frontmatter for the config, Markdown body for the system prompt. */
export function readAgentFile(path: string): AgentFile {
  const text = readFileSync(join(repoRoot, path), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`${path}: expected YAML frontmatter between --- lines, then the prompt`);
  }
  const config = agentFrontmatter.parse(parse(match[1]));
  return { ...config, system: match[2].trim() };
}

const environmentFile = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  config: z.strictObject({
    type: z.literal("cloud"),
    networking: z.strictObject({
      type: z.literal("limited"),
      allow_package_managers: z.boolean(),
      allow_mcp_servers: z.boolean(),
    }),
  }),
});
export type EnvironmentFile = z.infer<typeof environmentFile>;

export function readEnvironmentFile(path: string): EnvironmentFile {
  return environmentFile.parse(parse(readFileSync(join(repoRoot, path), "utf8")));
}
