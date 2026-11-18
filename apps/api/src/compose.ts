import type { Hono } from "hono";
import type { ApiEnv } from "./api/types.ts";
import { createApi } from "./api/app.ts";
import { errorResponse } from "./api/errors.ts";
import { readApiConfig, type Env } from "./config.ts";
import type { Logger } from "./log.ts";
import { createApiClient, type ResponseLike } from "./slack/api-client.ts";
import { createSlackEventsHandler, type SlackRouteDeps } from "./slack/route.ts";

export interface AppDeps {
  env: Env;
  log: Logger;
  /** Id generator for accepted messages. Replaced in tests. */
  newId?: () => string;
  /** Slack Web API calls. Replaced in tests so nothing reaches Slack. */
  slackActions?: SlackRouteDeps["slackActions"];
}

/** Base URL for in-process calls; never resolved over the network. */
const IN_PROCESS_BASE_URL = "http://in-process.invalid";

/**
 * Composition root: the only place that knows about every module. Everything deployed on
 * Vercel is mounted on `app` here.
 */
export function configureApp(
  app: Hono<ApiEnv>,
  { env, log, newId, slackActions }: AppDeps,
): Hono<ApiEnv> {
  const config = readApiConfig(env, log);
  app.route("/", createApi(newId === undefined ? { config, log } : { config, log, newId }));

  // The Slack adapter reaches the API through the same route, auth and validation as any
  // outside caller, dispatched in-process to this app rather than over the network.
  const api = createApiClient({
    // Vercel's build type-checks with an empty global `Response`, so Hono's return type is
    // narrowed here to the shape the client reads. At runtime it is a standard Response.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- needed on Vercel
    fetch: (request) => app.fetch(request) as unknown as Promise<ResponseLike>,
    baseUrl: IN_PROCESS_BASE_URL,
    serviceToken: config.serviceToken,
  });
  const slackEvents = createSlackEventsHandler(
    slackActions === undefined ? { env, log, api } : { env, log, api, slackActions },
  );
  app.post("/slack/events", (c) => slackEvents(c.req.raw));

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
