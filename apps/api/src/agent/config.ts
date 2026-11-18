import { z } from "zod";
import type { Env } from "../config.ts";
import type { Logger } from "../log.ts";

export interface AgentConfig {
  apiKey: string;
  /** Signs Anthropic's webhooks. Without it the webhook route rejects everything. */
  webhookSigningKey: string | undefined;
  /** The agent and environment names in `agents/` and `environments/`. */
  agentName: string;
  environmentName: string;
  /** Hard spend cap per session, in US cents (decision 55). */
  sessionBudgetCents: number;
}

export const AGENT_NAME = "hippidy-bot";
export const ENVIRONMENT_NAME = "hippidy-bot";
export const DEFAULT_SESSION_BUDGET_CENTS = 200;

const schema = z.object({
  ANTHROPIC_API_KEY: z.string().regex(/^sk-ant-\S+$/, "must be an Anthropic API key"),
  ANTHROPIC_WEBHOOK_SIGNING_KEY: z
    .string()
    .regex(/^whsec_\S+$/, "must be a whsec_ signing key")
    .optional(),
  SESSION_BUDGET_CENTS: z.coerce.number().int().min(1).max(10_000).optional(),
});

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
  return {
    apiKey: parsed.data.ANTHROPIC_API_KEY,
    webhookSigningKey: parsed.data.ANTHROPIC_WEBHOOK_SIGNING_KEY,
    agentName: AGENT_NAME,
    environmentName: ENVIRONMENT_NAME,
    sessionBudgetCents: parsed.data.SESSION_BUDGET_CENTS ?? DEFAULT_SESSION_BUDGET_CENTS,
  };
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}
