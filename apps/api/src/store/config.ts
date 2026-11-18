import { z } from "zod";
import type { Env } from "../config.ts";
import type { Logger } from "../log.ts";

export interface DbConfig {
  url: string;
}

const databaseUrlSchema = z
  .string()
  .regex(/^postgres(ql)?:\/\/\S+$/, "must be a postgres:// connection string");

/**
 * Reads only what storage needs. Never throws: a missing or bad value is logged (never its
 * value, which contains the database password) and the features that need storage fail
 * closed while the rest of the app keeps running.
 */
export function readDbConfig(env: Env, log: Logger): DbConfig | undefined {
  const raw = env.DATABASE_URL;
  if (raw === undefined || raw === "") {
    log.warn("config.database_url_missing", { variable: "DATABASE_URL" });
    return undefined;
  }
  const parsed = databaseUrlSchema.safeParse(raw);
  if (!parsed.success) {
    log.error("config.database_url_invalid", {
      variable: "DATABASE_URL",
      reason: "must be a postgres:// connection string",
    });
    return undefined;
  }
  return { url: parsed.data };
}
