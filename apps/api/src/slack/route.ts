import type { ErrorResponse } from "@hippidy/contracts";
import { App, type webApi } from "@slack/bolt";
import { createHandler, VercelReceiver } from "@vercel/slack-bolt";
import { z } from "zod";
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

function botUserIdFromBody(body: unknown): string | undefined {
  const parsed = authorizationsSchema.safeParse(body);
  return parsed.success ? parsed.data.authorizations[0]?.user_id : undefined;
}

const authorizationsSchema = z.object({
  authorizations: z.array(z.object({ user_id: z.string().min(1) })),
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
      // Returning the bot's user id keeps Bolt's ignoreSelf filter working.
      authorize: (_source, body) => {
        const botUserId = botUserIdFromBody(body);
        return Promise.resolve(
          botUserId === undefined
            ? { botToken: config.botToken }
            : { botToken: config.botToken, botUserId },
        );
      },
      receiver,
      logger,
      deferInitialization: true,
      // The default retries Slack API calls for up to about 30 minutes, which would keep the
      // function running long after the event. One retry, then the failure is logged.
      clientOptions: { retryConfig: { retries: 1 } },
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
