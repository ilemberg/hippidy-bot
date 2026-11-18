import { z } from "zod";
import type { Logger } from "./log.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export const MIN_SERVICE_TOKEN_LENGTH = 32;

export interface ApiConfig {
  /** Undefined when not configured. The API then rejects every request. */
  serviceToken: string | undefined;
}

const serviceTokenSchema = z
  .string()
  .min(MIN_SERVICE_TOKEN_LENGTH)
  .regex(/^\S+$/, "must not contain whitespace");

/**
 * Reads only what the core API needs. Never throws: a missing or bad value is logged and
 * leaves the API running but closed, so `/health` and the rest of the app stay up.
 */
export function readApiConfig(env: Env, log: Logger): ApiConfig {
  const raw = env.API_SERVICE_TOKEN;
  if (raw === undefined || raw === "") {
    log.warn("config.service_token_missing", { variable: "API_SERVICE_TOKEN" });
    return { serviceToken: undefined };
  }
  const parsed = serviceTokenSchema.safeParse(raw);
  if (!parsed.success) {
    log.error("config.service_token_invalid", {
      variable: "API_SERVICE_TOKEN",
      reason: `must be at least ${MIN_SERVICE_TOKEN_LENGTH} characters, with no whitespace`,
    });
    return { serviceToken: undefined };
  }
  return { serviceToken: parsed.data };
}
