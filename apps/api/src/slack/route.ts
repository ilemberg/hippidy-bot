import type { ErrorResponse } from "@hippidy/contracts";
import { handleChannelMessage } from "./listening.ts";
import { App, type webApi } from "@slack/bolt";
import { createHandler, VercelReceiver } from "@vercel/slack-bolt";
import { z } from "zod";
import type { Env } from "../config.ts";
import type { Logger } from "../log.ts";
import type { ApiClient } from "./api-client.ts";
import { boltLogger } from "./bolt-logger.ts";
import { readSlackConfig } from "./config.ts";
import {
  handleMention,
  handleReaction,
  handleConfirmDecisionAction,
  handleStartBriefAction,
  CONFIRM_DECISION_ACTION,
  START_CHANGE_ACTION,
  type SlackActions,
} from "./handler.ts";
import type { SlackThreadMessage } from "./thread.ts";

export type SlackEventsHandler = (request: Request) => Promise<Response>;

export interface SlackRouteDeps {
  env: Env;
  log: Logger;
  api: ApiClient;
  /** Builds the Slack calls from Bolt's client. Replaced in tests so nothing reaches Slack. */
  slackActions?: (client: webApi.WebClient) => SlackActions;
}

/** Display names by Slack user id, kept for an hour per server instance. */
const names = new Map<string, { name: string | undefined; until: number }>();
const NAME_TTL_MS = 60 * 60 * 1000;

const realSlackActions = (client: webApi.WebClient): SlackActions => ({
  async addReaction(input) {
    await client.reactions.add(input);
  },
  async userName(userId) {
    const cached = names.get(userId);
    if (cached !== undefined && cached.until > Date.now()) return cached.name;
    const { user } = await client.users.info({ user: userId });
    // Trimmed and capped: the contract allows 255 characters, and a longer name must not
    // cost the whole message.
    const name = [user?.profile?.display_name, user?.profile?.real_name, user?.name]
      .map((candidate) => candidate?.trim().slice(0, 255))
      .find((candidate) => candidate !== undefined && candidate !== "");
    names.set(userId, { name, until: Date.now() + NAME_TTL_MS });
    return name;
  },
  async postMessage(input) {
    await client.chat.postMessage({
      channel: input.channel,
      text: input.text,
      ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
      // A note about listening links one page; no preview of it.
      unfurl_links: false,
    });
  },
  async threadReplies(channel, threadTs) {
    // Needs `channels:history` and `groups:history` (decision 140). Slack returns a thread
    // oldest first, 200 at a time, and the newest messages are the ones that matter, so it
    // reads on through up to five pages (1,000 messages). The handler bounds the time it
    // waits for all of them. A longer thread gets no context at all (see below).
    const messages: SlackThreadMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_REPLY_PAGES; page++) {
      const response = await client.conversations.replies({
        channel,
        ts: threadTs,
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const parsed = repliesSchema.safeParse(response);
      if (!parsed.success) {
        throw Object.assign(new Error("Unexpected conversations.replies response"), {
          code: "invalid_response",
        });
      }
      for (const message of parsed.data.messages) {
        messages.push({
          ts: message.ts,
          ...(typeof message.user === "string" ? { user: message.user } : {}),
          ...(typeof message.bot_id === "string" ? { botId: message.bot_id } : {}),
          ...(typeof message.text === "string" ? { text: message.text } : {}),
        });
      }
      const next = parsed.data.response_metadata?.next_cursor;
      if (next === undefined || next === null || next === "") return messages;
      cursor = next;
    }
    // Still more after the last page: the newest messages, the ones that matter, are the ones
    // not read, so sending the rest as "since your last reply" would mislead. No context.
    throw Object.assign(new Error("Thread too long to read"), { code: "thread_too_long" });
  },
});

const MAX_REPLY_PAGES = 5;

/** The parts of a `conversations.replies` response the adapter reads. */
const repliesSchema = z.object({
  messages: z
    .array(
      z.object({
        ts: z.string().regex(/^\d+\.\d+$/),
        user: z.string().nullish(),
        bot_id: z.string().nullish(),
        text: z.string().nullish(),
      }),
    )
    .default([]),
  response_metadata: z.object({ next_cursor: z.string().nullish() }).nullish(),
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
        {
          api: deps.api,
          slack: slackActions(client),
          log: deps.log,
          webBaseUrl: config.webBaseUrl,
        },
      );
    });
    // Messages in channels the bot is in (slice 2.5). The API keeps only those of channels
    // listened to; nothing is ever posted in reply (176). Bolt drops the bot's own messages.
    app.event("message", async ({ body, context, client }) => {
      await handleChannelMessage(
        { body, retryNum: context.retryNum ?? 0, retryReason: context.retryReason ?? "" },
        {
          api: deps.api,
          userName: (userId) => slackActions(client).userName(userId),
          log: deps.log,
        },
      );
    });
    app.event("reaction_added", async ({ body }) => {
      await handleReaction(body, { api: deps.api, log: deps.log });
    });
    // The Start button under a brief (slice 2.1, G17). Interactivity comes to the same URL.
    // Slack wants the ack within 3 seconds; the receiver answers on ack and keeps the rest
    // running with `waitUntil`, so the API call is outside that limit.
    app.action(START_CHANGE_ACTION, async ({ ack, body, client }) => {
      await ack();
      await handleStartBriefAction(body, {
        api: deps.api,
        slack: slackActions(client),
        log: deps.log,
      });
    });
    // The Confirm button under a proposed decision (slice 2.2, decision 192).
    app.action(CONFIRM_DECISION_ACTION, async ({ ack, body, client }) => {
      await ack();
      await handleConfirmDecisionAction(body, {
        api: deps.api,
        slack: slackActions(client),
        log: deps.log,
      });
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
