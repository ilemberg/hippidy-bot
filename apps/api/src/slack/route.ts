import type { ErrorResponse } from "@hippidy/contracts";
import { App, type webApi } from "@slack/bolt";
import { createHandler, VercelReceiver } from "@vercel/slack-bolt";
import type { Env } from "../config.ts";
import type { Logger } from "../log.ts";
import type { ApiClient } from "./api-client.ts";
import { boltLogger } from "./bolt-logger.ts";
import { readSlackConfig } from "./config.ts";
import { handleMention, type SlackActions } from "./handler.ts";

export type SlackEventsHandler = (request: Request) => Promise<Response>;

export interface SlackRouteDeps {
  env: Env;
  log: Logger;
  api: ApiClient;
  /** Builds the Slack calls from Bolt's client. Replaced in tests so nothing reaches Slack. */
  slackActions?: (client: webApi.WebClient) => SlackActions;
}

const realSlackActions = (client: webApi.WebClient): SlackActions => ({
  async addReaction(input) {
    await client.reactions.add(input);
  },
});

function notConfigured(): Response {
  const body: ErrorResponse = {
    error: { code: "not_configured", message: "Slack is not configured on this deployment" },
  };
  return Response.json(body, { status: 503 });
}

/**
 * Handler for `POST /slack/events`. The Bolt app is created on the first request, not at
 * startup, because the receiver throws without a signing secret and that must never take
 * down the rest of the app. Until Slack is configured the route answers 503.
 */
export function createSlackEventsHandler(deps: SlackRouteDeps): SlackEventsHandler {
  let handler: SlackEventsHandler | null | undefined;

  const build = (): SlackEventsHandler | null => {
    const config = readSlackConfig(deps.env, deps.log);
    if (config === undefined) return null;

    const logger = boltLogger(deps.log);
    const receiver = new VercelReceiver({ signingSecret: config.signingSecret, logger });
    const app = new App({
      // Hands Bolt the token directly. With `token`, Bolt calls Slack's auth.test before it
      // acknowledges the first event on every cold start, which eats into Slack's 3 second
      // limit. The bot's own user id comes from each event's `authorizations` instead.
      authorize: () => Promise.resolve({ botToken: config.botToken }),
      receiver,
      logger,
      deferInitialization: true,
    });
    const slackActions = deps.slackActions ?? realSlackActions;

    app.event("app_mention", async ({ body, context, client }) => {
      await handleMention(
        { body, retryNum: context.retryNum ?? 0, retryReason: context.retryReason ?? "" },
        { api: deps.api, slack: slackActions(client), log: deps.log },
      );
    });
    app.error(async (error) => {
      deps.log.error("slack.bolt_error", { error });
      await Promise.resolve();
    });

    return createHandler(app, receiver);
  };

  return async (request) => {
    if (handler === undefined) handler = build();
    if (handler === null) return notConfigured();
    return handler(request);
  };
}
