import { Anthropic } from "@anthropic-ai/sdk";
import type { Hono } from "hono";
import { readAgentConfig } from "./agent/config.ts";
import { createAnthropicExtractor } from "./agent/extractor.ts";
import { BRIEF_TIMEOUT_MS, createAnthropicBriefWriter } from "./agent/brief-writer.ts";
import { REVIEW_TIMEOUT_MS, createAnthropicReviewer } from "./agent/reviewer.ts";
import { createManagedAgentRuntime } from "./agent/managed.ts";
import { createWebhookVerifier, type VerifyAgentWebhook } from "./agent/webhooks.ts";
import { createApi } from "./api/app.ts";
import type { CaptureDeps } from "./api/capture.ts";
import type { CheckerServices } from "./api/checker.ts";
import type { GoalServices } from "./api/goals.ts";
import type { ConversationDeps } from "./api/conversations.ts";
import { errorResponse } from "./api/errors.ts";
import type { StatusDeps } from "./api/status.ts";
import type { ApiEnv } from "./api/types.ts";
import {
  readApiConfig,
  readCaptureBudgetCents,
  readFallbackOwner,
  readReviewToken,
  readTaskConfig,
  readWebBaseUrl,
  type Env,
} from "./config.ts";
import { createTaskSource, type TaskSource } from "./tasks/provider.ts";
import type { Logger } from "./log.ts";
import { createApiClient, type ResponseLike } from "./slack/api-client.ts";
import { readSlackConfig } from "./slack/config.ts";
import { createSlackDeliverer, slackPosterFromEnv, type SlackPoster } from "./slack/deliver.ts";
import { createSlackEventsHandler, type SlackRouteDeps } from "./slack/route.ts";
import { createGitHubChecks } from "./github/checks.ts";
import { createGitHubPulls } from "./github/pulls.ts";
import { readDbConfig } from "./store/config.ts";
import { createPostgresDb } from "./store/db.ts";

export interface AppDeps {
  env: Env;
  log: Logger;
  /** Replace the real services in tests, so nothing reaches Anthropic, Supabase or Slack. */
  services?: {
    conversations?: ConversationDeps;
    capture?: CaptureDeps;
    checker?: CheckerServices;
    goals?: GoalServices;
    verifyAgentWebhook?: VerifyAgentWebhook;
    slackActions?: SlackRouteDeps["slackActions"];
    slackPoster?: SlackPoster;
    status?: StatusDeps;
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
      capture: services?.capture ?? real.capture,
      checker: services?.checker ?? real.checker,
      goals: services?.goals ?? real.goals,
      verifyAgentWebhook: services?.verifyAgentWebhook ?? real.verifyAgentWebhook,
      status: services?.status ?? real.status,
      tasks: services?.conversations?.tasks ?? real.tasks,
      webBaseUrl: readWebBaseUrl(env, log),
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
): {
  conversations?: ConversationDeps;
  capture?: CaptureDeps;
  checker?: CheckerServices;
  goals?: GoalServices;
  verifyAgentWebhook?: VerifyAgentWebhook;
  status: StatusDeps;
  tasks?: TaskSource;
} {
  const dbConfig = readDbConfig(env, log);
  const agentConfig = readAgentConfig(env, log);
  // Connects lazily, so creating it costs nothing until a query runs.
  const db = dbConfig === undefined ? undefined : createPostgresDb(dbConfig.url);
  const status: StatusDeps = {
    db,
    configured: {
      agent: agentConfig !== undefined,
      slack: readSlackConfig(env, log) !== undefined,
      github: agentConfig?.repository !== undefined,
    },
  };
  // The team's one home for tasks (slice 3.3, decisions 210 and 211): built whenever storage
  // is, so the tasks pages never fall back to another home when the agent is not configured.
  const tasks = db === undefined ? undefined : createTaskSource(readTaskConfig(env, log), db, log);
  if (agentConfig === undefined) return tasks === undefined ? { status } : { status, tasks };

  const client = new Anthropic({ apiKey: agentConfig.apiKey, maxRetries: 2, timeout: 20_000 });
  const verifyAgentWebhook =
    agentConfig.webhookSigningKey === undefined
      ? undefined
      : createWebhookVerifier(agentConfig.webhookSigningKey, client);
  if (db === undefined) {
    return verifyAgentWebhook === undefined ? { status } : { verifyAgentWebhook, status };
  }

  const conversations: ConversationDeps = {
    db,
    runtime: createManagedAgentRuntime(agentConfig, client),
    deliverers,
    fallback: readFallbackOwner(env, log),
    ...(tasks === undefined ? {} : { tasks }),
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
  // Capture from listened channels (slice 2.5) uses the same key, on the smallest model.
  const capture: CaptureDeps = {
    db,
    // Its own client: no retries and a short timeout keep three calls inside one reconcile; a
    // thread that fails is read again on a later one.
    extractor: createAnthropicExtractor(
      new Anthropic({ apiKey: agentConfig.apiKey, maxRetries: 0, timeout: 25_000 }),
    ),
    dailyBudgetCents: readCaptureBudgetCents(env, log),
    fallback: conversations.fallback,
  };
  // The checker (slice 4.3): reads pull requests with the same token as the checks, posts its
  // reviews with a token that can only comment, and writes them with its own client: no
  // retries, and a timeout long enough for one review at medium effort within the function's.
  const pulls =
    agentConfig.repository === undefined
      ? undefined
      : createGitHubPulls({
          repositoryUrl: agentConfig.repository.url,
          token: agentConfig.repository.token,
        });
  const checker: CheckerServices = {
    pulls,
    reviewToken: readReviewToken(env, log),
    reviewer: createAnthropicReviewer(
      new Anthropic({ apiKey: agentConfig.apiKey, maxRetries: 0, timeout: REVIEW_TIMEOUT_MS }),
    ),
  };
  // Goals (slice 4.4): read their pull requests with the same token, and write each brief with
  // their own client: no retries, and a timeout for one brief at medium effort.
  const goals: GoalServices = {
    pulls,
    writer: createAnthropicBriefWriter(
      new Anthropic({ apiKey: agentConfig.apiKey, maxRetries: 0, timeout: BRIEF_TIMEOUT_MS }),
    ),
  };
  return verifyAgentWebhook === undefined
    ? { conversations, capture, checker, goals, status }
    : { conversations, capture, checker, goals, verifyAgentWebhook, status };
}
