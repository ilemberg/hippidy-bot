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

/**
 * Who decides for anything with no owner (slice 3.1, rule 10 of `wave-3.md`): a Slack user id
 * in `FALLBACK_OWNER`. Unset or bad: logged, and lines about an area with no owner name nobody.
 */
export function readFallbackOwner(env: Env, log: Logger): { actorId: string } | undefined {
  const raw = env.FALLBACK_OWNER;
  if (raw === undefined || raw === "") {
    log.warn("config.fallback_owner_missing", { variable: "FALLBACK_OWNER" });
    return undefined;
  }
  if (!/^[UW][A-Z0-9]{2,30}$/.test(raw.trim())) {
    log.error("config.fallback_owner_invalid", {
      variable: "FALLBACK_OWNER",
      reason: "must be a Slack user id, like U0123456789",
    });
    return undefined;
  }
  return { actorId: raw.trim() };
}

/** Where tasks come from (slice 3.3, decision 210). */
export type TaskConfig =
  | { kind: "builtin" }
  | { kind: "jira"; baseUrl: string; email: string; token: string; project: string }
  /** `TASK_PROVIDER` is `jira`, but its settings are missing or bad: tasks fail closed. */
  | { kind: "jira_unconfigured" };

/**
 * Reads `TASK_PROVIDER` and, for Jira, `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` and
 * `JIRA_PROJECT_KEY` (default `SCRUM`). Unset, the built-in tracker. Never throws.
 */
export function readTaskConfig(env: Env, log: Logger): TaskConfig {
  const provider = (env.TASK_PROVIDER ?? "").trim().toLowerCase();
  if (provider === "" || provider === "builtin") return { kind: "builtin" };
  if (provider !== "jira") {
    log.error("config.task_provider_invalid", {
      variable: "TASK_PROVIDER",
      reason: "must be builtin or jira",
    });
    return { kind: "jira_unconfigured" };
  }
  const baseUrl = (env.JIRA_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const email = (env.JIRA_EMAIL ?? "").trim();
  const token = (env.JIRA_API_TOKEN ?? "").trim();
  const project = (env.JIRA_PROJECT_KEY ?? "SCRUM").trim().toUpperCase();
  const problems: string[] = [];
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(baseUrl)) problems.push("JIRA_BASE_URL");
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) problems.push("JIRA_EMAIL");
  if (token === "") problems.push("JIRA_API_TOKEN");
  if (!/^[A-Z][A-Z0-9]{0,19}$/.test(project)) problems.push("JIRA_PROJECT_KEY");
  if (problems.length > 0) {
    // Names only: never a value.
    log.error("config.jira_invalid", { variables: problems });
    return { kind: "jira_unconfigured" };
  }
  return { kind: "jira", baseUrl, email, token, project };
}
