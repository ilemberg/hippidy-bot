import type { Hono } from "hono";
import type { ApiEnv } from "./api/types.ts";
import { createApi } from "./api/app.ts";
import { errorResponse } from "./api/errors.ts";
import { readApiConfig, type Env } from "./config.ts";
import type { Logger } from "./log.ts";

export interface AppDeps {
  env: Env;
  log: Logger;
  /** Id generator for accepted messages. Replaced in tests. */
  newId?: () => string;
}

/**
 * Composition root: the only place that knows about every module. Everything deployed on
 * Vercel is mounted on `app` here.
 */
export function configureApp(app: Hono<ApiEnv>, { env, log, newId }: AppDeps): Hono<ApiEnv> {
  const config = readApiConfig(env, log);
  app.route("/", createApi(newId === undefined ? { config, log } : { config, log, newId }));

  app.notFound((c) => errorResponse(c, 404, "not_found", "Not found"));
  app.onError((error, c) => {
    // The request's logger carries the correlation id; it is missing only if the error
    // happened before the API's first middleware ran.
    const requestLog = (c.get("log") as Logger | undefined) ?? log;
    requestLog.error("request.failed", { error, method: c.req.method, path: c.req.path });
    return errorResponse(c, 500, "internal", "Internal error");
  });

  return app;
}
