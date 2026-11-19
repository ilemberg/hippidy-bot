import type { ComponentStatus, StatusResponse } from "@hippidy/contracts";
import type { Logger } from "../log.ts";
import type { Db } from "../store/db.ts";

export interface StatusDeps {
  /** Undefined when storage is not configured. */
  db: Db | undefined;
  /** Which parts have valid configuration. Only the database is asked whether it answers. */
  configured: { agent: boolean; slack: boolean; github: boolean };
  /** How long the database has to answer. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;

/** The health of each part the API depends on, for `GET /status`. */
export async function readStatus(deps: StatusDeps, log: Logger): Promise<StatusResponse> {
  const checks = {
    database: await checkDatabase(deps, log),
    agent: configured(deps.configured.agent),
    slack: configured(deps.configured.slack),
    github: configured(deps.configured.github),
  };
  const healthy = Object.values(checks).every((check) => check === "ok");
  return { status: healthy ? "ok" : "degraded", checks };
}

function configured(value: boolean): ComponentStatus {
  return value ? "ok" : "not_configured";
}

async function checkDatabase(deps: StatusDeps, log: Logger): Promise<ComponentStatus> {
  if (deps.db === undefined) return "not_configured";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("database did not answer in time"));
    }, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  });
  try {
    await Promise.race([deps.db.query("select 1"), timeout]);
    return "ok";
  } catch (error) {
    log.error("status.database_down", { error });
    return "down";
  } finally {
    clearTimeout(timer);
  }
}
