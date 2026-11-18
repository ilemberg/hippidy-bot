import { z } from "zod";
import type { Logger } from "./log.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export const MIN_SERVICE_TOKEN_LENGTH = 32;

export interface ApiConfig {
  /** For clients of `/v1/messages`. Undefined when not configured: every request is rejected. */
  serviceToken: string | undefined;
  /** For the scheduled caller of `/v1/reconcile` only. Undefined: every request is rejected. */
  reconcileToken: string | undefined;
}

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
  };
}
