import { Anthropic } from "@anthropic-ai/sdk";
import type { Hono } from "hono";
import { readAgentConfig } from "./agent/config.ts";
import { createManagedAgentRuntime } from "./agent/managed.ts";
import { createWebhookVerifier, type VerifyAgentWebhook } from "./agent/webhooks.ts";
import { createApi } from "./api/app.ts";
import type { ConversationDeps } from "./api/conversations.ts";
import { errorResponse } from "./api/errors.ts";
import type { ApiEnv } from "./api/types.ts";
import { readApiConfig, type Env } from "./config.ts";
import type { Logger } from "./log.ts";
import { createApiClient, type ResponseLike } from "./slack/api-client.ts";
import { createSlackDeliverer, slackPosterFromEnv, type SlackPoster } from "./slack/deliver.ts";
import { createSlackEventsHandler, type SlackRouteDeps } from "./slack/route.ts";
import { createGitHubChecks } from "./github/checks.ts";
import { readDbConfig } from "./store/config.ts";
import { createPostgresDb } from "./store/db.ts";

export interface AppDeps {
  env: Env;
  log: Logger;
  /** Replace the real services in tests, so nothing reaches Anthropic, Supabase or Slack. */
  services?: {
    conversations?: ConversationDeps;
    verifyAgentWebhook?: VerifyAgentWebhook;
    slackActions?: SlackRouteDeps["slackActions"];
    slackPoster?: SlackPoster;
  };
}

/** Base URL for in-process calls; never resolved over the network. */
const IN_PROCESS_BASE_URL = "http://in-process.invalid";

/**
 * Composition root: the only place that knows about every module. Everything deployed on
 * Vercel is mounted on `app` here. Each part reads only its own configuration and is left out
 * (failing closed) when that configuration is missing.
 */
export function configureApp(app: Hono<ApiEnv>, { env, log, services }: AppDeps): Hono<ApiEnv> {
  const config = readApiConfig(env, log);

  // Outbound: the API hands replies to each source's deliverer (decision 53).
  const slackDeliverer = createSlackDeliverer(
    services?.slackPoster ?? slackPosterFromEnv(env, log),
  );
  const real = realServices(env, log, { slack: slackDeliverer });

  app.route(
    "/",
    createApi({
      config,
      log,
      conversations: services?.conversations ?? real.conversations,
      verifyAgentWebhook: services?.verifyAgentWebhook ?? real.verifyAgentWebhook,
    }),
  );

  // Inbound: the Slack adapter reaches the API through the same route, auth and validation as
  // any outside caller, dispatched in-process to this app rather than over the network.
  const api = createApiClient({
    // Vercel's build type-checks with an empty global `Response`, so Hono's return type is
    // narrowed here to the shape the client reads. At runtime it is a standard Response.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- needed on Vercel
    fetch: (request) => app.fetch(request) as unknown as Promise<ResponseLike>,
    baseUrl: IN_PROCESS_BASE_URL,
    serviceToken: config.serviceToken,
  });
  const slackActions = services?.slackActions;
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

/** Builds the real storage, agent runtime and webhook check, when they are configured. */
function realServices(
  env: Env,
  log: Logger,
  deliverers: ConversationDeps["deliverers"],
): { conversations?: ConversationDeps; verifyAgentWebhook?: VerifyAgentWebhook } {
  const dbConfig = readDbConfig(env, log);
  const agentConfig = readAgentConfig(env, log);
  if (agentConfig === undefined) return {};

  const client = new Anthropic({ apiKey: agentConfig.apiKey, maxRetries: 2, timeout: 20_000 });
  const verifyAgentWebhook =
    agentConfig.webhookSigningKey === undefined
      ? undefined
      : createWebhookVerifier(agentConfig.webhookSigningKey, client);
  if (dbConfig === undefined) return verifyAgentWebhook === undefined ? {} : { verifyAgentWebhook };

  const conversations: ConversationDeps = {
    db: createPostgresDb(dbConfig.url),
    runtime: createManagedAgentRuntime(agentConfig, client),
    deliverers,
    // The same token that mounts the repo reads its pull requests' checks (decision 132).
    ...(agentConfig.repository === undefined
      ? {}
      : {
          checks: createGitHubChecks({
            repositoryUrl: agentConfig.repository.url,
            token: agentConfig.repository.token,
          }),
        }),
  };
  return verifyAgentWebhook === undefined
    ? { conversations }
    : { conversations, verifyAgentWebhook };
}
