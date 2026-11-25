import { z } from "zod";
import type { Logger } from "./log.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export const MIN_SERVICE_TOKEN_LENGTH = 32;

export interface ApiConfig {
  /** For clients of `/v1/messages`. Undefined when not configured: every request is rejected. */
  serviceToken: string | undefined;
  /** For the scheduled caller of `/v1/reconcile` only. Undefined: every request is rejected. */
  reconcileToken: string | undefined;
  /**
   * For people signed in to the web app (decisions 193 and 194). Undefined when either
   * variable is missing or bad: every person token is rejected.
   */
  personAuth: PersonAuthConfig | undefined;
}

export interface PersonAuthConfig {
  /** Shared with the web app's server only; it signs the person tokens. */
  secret: string;
  /** The one Slack workspace whose members may sign in (Slack team id). */
  workspaceId: string;
}

/** A Slack team id (`T...`), or an Enterprise Grid organization's (`E...`). */
// A workspace's team id (`T…`), as the person token's `team` claim carries it.
const workspaceIdSchema = z.string().regex(/^T[A-Z0-9]{2,30}$/);

const tokenSchema = z
  .string()
  .min(MIN_SERVICE_TOKEN_LENGTH)
  .regex(/^\S+$/, "must not contain whitespace");

function readToken(env: Env, variable: string, log: Logger, name: string): string | undefined {
  const raw = env[variable];
  if (raw === undefined || raw === "") {
    log.warn(`config.${name}_missing`, { variable });
    return undefined;
  }
  const parsed = tokenSchema.safeParse(raw);
  if (!parsed.success) {
    log.error(`config.${name}_invalid`, {
      variable,
      reason: `must be at least ${MIN_SERVICE_TOKEN_LENGTH} characters, with no whitespace`,
    });
    return undefined;
  }
  return parsed.data;
}

/**
 * Reads only what the core API needs. Never throws: a missing or bad value is logged and
 * leaves the API running but closed, so `/health` and the rest of the app stay up.
 */
export function readApiConfig(env: Env, log: Logger): ApiConfig {
  return {
    serviceToken: readToken(env, "API_SERVICE_TOKEN", log, "service_token"),
    reconcileToken: readToken(env, "RECONCILE_TOKEN", log, "reconcile_token"),
    personAuth: readPersonAuth(env, log),
  };
}

function readPersonAuth(env: Env, log: Logger): PersonAuthConfig | undefined {
  const secret = readToken(env, "WEB_API_SECRET", log, "web_api_secret");
  const raw = env.SLACK_WORKSPACE_ID;
  let workspaceId: string | undefined;
  if (raw === undefined || raw === "") {
    log.warn("config.slack_workspace_id_missing", { variable: "SLACK_WORKSPACE_ID" });
  } else if (!workspaceIdSchema.safeParse(raw).success) {
    log.error("config.slack_workspace_id_invalid", {
      variable: "SLACK_WORKSPACE_ID",
      reason: "must be a Slack team id, like T0123456789",
    });
  } else {
    workspaceId = raw;
  }
  return secret === undefined || workspaceId === undefined ? undefined : { secret, workspaceId };
}

/** What capture may spend in a UTC day unless `CAPTURE_DAILY_BUDGET_CENTS` says otherwise. */
export const DEFAULT_CAPTURE_DAILY_BUDGET_CENTS = 100;

/**
 * Capture's daily budget in cents (slice 2.5, decision 199): $1 when unset. A bad value is
 * logged and gives 0, so capture fails closed and reads nothing.
 */
export function readCaptureBudgetCents(env: Env, log: Logger): number {
  const raw = env.CAPTURE_DAILY_BUDGET_CENTS;
  if (raw === undefined || raw === "") return DEFAULT_CAPTURE_DAILY_BUDGET_CENTS;
  const parsed = z.coerce.number().int().min(0).max(100_000).safeParse(raw.trim());
  if (!parsed.success) {
    log.error("config.capture_budget_invalid", {
      variable: "CAPTURE_DAILY_BUDGET_CENTS",
      reason: "must be a whole number of cents, from 0 to 100000",
    });
    return 0;
  }
  return parsed.data;
}
