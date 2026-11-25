import { z } from "zod";
import type { Env } from "../config.ts";
import type { Logger } from "../log.ts";
import type { AgentKind } from "./runtime.ts";

export interface AgentConfig {
  apiKey: string;
  /** Signs Anthropic's webhooks. Without it the webhook route rejects everything. */
  webhookSigningKey: string | undefined;
  /** The agent and environment names in `agents/` and `environments/`. */
  agentName: string;
  /** The product agent's name in `agents/product.md` (decisions 139, 167). */
  productAgentName: string;
  /** The teammate's name in `agents/teammate.md` (slice 2.1, decision 181). */
  teammateAgentName: string;
  /** The environment the engineer's and the product agent's sessions run in. */
  environmentName: string;
  /**
   * The teammate's own environment in `environments/teammate.yaml`: MCP servers only, no
   * package registries and no hosts (rule 1 of slice 2.1).
   */
  teammateEnvironmentName: string;
  /** Hard spend cap per session, in US cents (decision 55). */
  sessionBudgetCents: number;
  /**
   * The repo every session mounts (decision 15) and the token that mounts it (decision 122).
   * Undefined when the token is missing or bad: sessions then fail to start, so a message is
   * answered with a note instead of reaching an agent without its repo.
   */
  repository: { url: string; token: string } | undefined;
  /**
   * The same repo, for the product agent and the teammate: mounted without a token, so their
   * sessions can read and clone the public repo but not push (decisions 147, 167, 181).
   */
  repositoryUrl: string;
  /**
   * Each agent's own vault, made by the agent sync and named after the agent, holding the
   * credentials of that agent's MCP servers only: GitHub's for the engineer, Atlassian's for
   * the product agent and the teammate (slice 2.1, part E). A session attaches its agent's.
   */
  vaultNames: Readonly<Record<AgentKind, string>>;
}

export const AGENT_NAME = "hippidy-bot";
export const PRODUCT_AGENT_NAME = "hippidy-bot-product";
export const TEAMMATE_AGENT_NAME = "hippidy-bot-teammate";
export const ENVIRONMENT_NAME = "hippidy-bot";
export const TEAMMATE_ENVIRONMENT_NAME = "hippidy-bot-teammate";
/** Must match vaultNameFor in scripts/sync-lib.ts: each vault is named after its agent. */
export const VAULT_NAMES: Readonly<Record<AgentKind, string>> = {
  engineer: AGENT_NAME,
  product: PRODUCT_AGENT_NAME,
  teammate: TEAMMATE_AGENT_NAME,
};
export const REPOSITORY_URL = "https://github.com/ilemberg/hippidy-bot";
/** A coding session's starting cap (decision 107). */
export const DEFAULT_SESSION_BUDGET_CENTS = 500;

const schema = z.object({
  ANTHROPIC_API_KEY: z.string().regex(/^sk-ant-\S+$/, "must be an Anthropic API key"),
  ANTHROPIC_WEBHOOK_SIGNING_KEY: z
    .string()
    .regex(/^whsec_\S+$/, "must be a whsec_ signing key")
    .optional(),
  SESSION_BUDGET_CENTS: z.coerce.number().int().min(1).max(10_000).optional(),
});

/** A fine-grained personal access token (decision 122). */
const githubToken = z.string().regex(/^github_pat_\w+$/, "must be a fine-grained GitHub token");

/** Reads what the agent runtime needs. Never throws; logs variable names, never values. */
export function readAgentConfig(env: Env, log: Logger): AgentConfig | undefined {
  const parsed = schema.safeParse({
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    ANTHROPIC_WEBHOOK_SIGNING_KEY: emptyToUndefined(env.ANTHROPIC_WEBHOOK_SIGNING_KEY),
    SESSION_BUDGET_CENTS: emptyToUndefined(env.SESSION_BUDGET_CENTS),
  });
  if (!parsed.success) {
    log.warn("config.agent_not_configured", {
      problems: parsed.error.issues.map((issue) => ({
        variable: issue.path.join("."),
        message: issue.message,
      })),
    });
    return undefined;
  }
  if (parsed.data.ANTHROPIC_WEBHOOK_SIGNING_KEY === undefined) {
    log.warn("config.webhook_signing_key_missing", { variable: "ANTHROPIC_WEBHOOK_SIGNING_KEY" });
  }
  const token = githubToken.safeParse(env.AGENT_GITHUB_TOKEN);
  if (!token.success) {
    log.error("config.agent_github_token_missing", {
      variable: "AGENT_GITHUB_TOKEN",
      reason:
        env.AGENT_GITHUB_TOKEN === undefined || env.AGENT_GITHUB_TOKEN === ""
          ? "not set"
          : "not a fine-grained GitHub token",
    });
  }
  return {
    apiKey: parsed.data.ANTHROPIC_API_KEY,
    webhookSigningKey: parsed.data.ANTHROPIC_WEBHOOK_SIGNING_KEY,
    agentName: AGENT_NAME,
    productAgentName: PRODUCT_AGENT_NAME,
    teammateAgentName: TEAMMATE_AGENT_NAME,
    environmentName: ENVIRONMENT_NAME,
    teammateEnvironmentName: TEAMMATE_ENVIRONMENT_NAME,
    sessionBudgetCents: parsed.data.SESSION_BUDGET_CENTS ?? DEFAULT_SESSION_BUDGET_CENTS,
    repository: token.success ? { url: REPOSITORY_URL, token: token.data } : undefined,
    repositoryUrl: REPOSITORY_URL,
    vaultNames: VAULT_NAMES,
  };
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}
