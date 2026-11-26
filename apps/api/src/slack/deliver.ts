import type { Deliverer, OutboundDelivery } from "@hippidy/contracts";
import { type types, webApi } from "@slack/bolt";
import { z } from "zod";
import type { Env } from "../config.ts";
import type { Logger } from "../log.ts";
import { readSlackConfig } from "./config.ts";
import { CONFIRM_DECISION_ACTION, RECEIVED_REACTION, START_CHANGE_ACTION } from "./handler.ts";
import { markdownToSlack, splitForSlack } from "./markdown.ts";

/** The Slack Web API calls deliveries make. */
export interface SlackPoster {
  /**
   * With `blocks`, Slack shows the blocks and uses `text` for notifications only. Without
   * `thread_ts` the message goes in the channel itself (a direct message, slice 3.4).
   */
  postMessage(input: {
    channel: string;
    thread_ts?: string;
    text: string;
    blocks?: types.KnownBlock[];
  }): Promise<void>;
  addReaction(input: { channel: string; timestamp: string; name: string }): Promise<void>;
  removeReaction(input: { channel: string; timestamp: string; name: string }): Promise<void>;
  /** Opens (or finds) the bot's direct message with a person: its channel id (slice 3.4). */
  openDirect(userId: string): Promise<string>;
  /** The person's `tz` from `users.info`, as Slack gives it, or undefined if it has none. */
  userTimeZone(userId: string): Promise<string | undefined>;
}

const STATUS_REACTION = { answered: "white_check_mark", failed: "x", stopped: "octagonal_sign" };

/** Slack's limit on the text of a section block. */
const SECTION_TEXT_CHARS = 3000;

/** Slack errors that mean the reaction is already in the state we want. */
const HARMLESS = new Set(["already_reacted", "no_reaction"]);

/** Slack errors that mean it has no time zone to give for that person. */
const NO_SUCH_USER = new Set(["user_not_found", "user_not_visible", "account_inactive"]);

/** How long a person's time zone is kept per server instance. */
const TIME_ZONE_TTL_MS = 60 * 60 * 1000;

/**
 * Turns each `{@id}` the delivery lists into a Slack mention (`<@id>`), so the person is told
 * (slice 3.1). Any other `{@…}` in the text, from an agent's words for instance, stays as text.
 */
export function withMentions(text: string, mentions: readonly string[] | undefined): string {
  let out = text;
  for (const actorId of new Set(mentions ?? [])) {
    out = out.replaceAll(`{@${actorId}}`, `<@${actorId}>`);
  }
  return out;
}

/** An IANA time zone this runtime knows, in its canonical spelling, or undefined. */
export function knownTimeZone(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/**
 * Delivers the API's outbound messages to Slack (decision 53): replies go in the thread as
 * Slack-formatted text; a brief goes in the thread with a Start button under it when a person
 * must start it (slice 2.1, G17); and a status swaps the 👀 on each settled message for ✅, ❌
 * or 🛑. Throws if anything did not go out, so the API retries it. It also sends a person a
 * direct message and reads their time zone, for daily briefs (slice 3.4).
 */
export function createSlackDeliverer(
  poster: SlackPoster | (() => SlackPoster),
  options: { now?: () => number } = {},
): Deliverer {
  const getPoster = typeof poster === "function" ? poster : () => poster;
  const now = options.now ?? Date.now;
  const timeZones = new Map<string, { timeZone: string | undefined; until: number }>();
  return {
    async deliver(delivery: OutboundDelivery) {
      const slack = getPoster();
      const channel = delivery.target.channelId;
      const thread_ts = delivery.target.threadId;
      switch (delivery.kind) {
        case "reply":
          for (const text of splitForSlack(
            withMentions(markdownToSlack(delivery.text), delivery.mentions),
          )) {
            await slack.postMessage({ channel, thread_ts, text });
          }
          return;
        case "brief": {
          const parts = splitForSlack(markdownToSlack(delivery.text), SECTION_TEXT_CHARS);
          if (parts.length === 0) parts.push("(The brief is empty.)");
          for (const [index, text] of parts.entries()) {
            const blocks: types.KnownBlock[] = [
              { type: "section", text: { type: "mrkdwn", text } },
            ];
            // The button belongs under the whole brief, so only the last part has it.
            if (delivery.needsStart && index === parts.length - 1) {
              blocks.push(button("Start", START_CHANGE_ACTION, delivery.briefId));
            }
            await slack.postMessage({ channel, thread_ts, text, blocks });
          }
          return;
        }
        case "decision": {
          const parts = splitForSlack(
            withMentions(markdownToSlack(delivery.text), delivery.mentions),
            SECTION_TEXT_CHARS,
          );
          if (parts.length === 0) parts.push("(The decision is empty.)");
          for (const [index, text] of parts.entries()) {
            const blocks: types.KnownBlock[] = [
              { type: "section", text: { type: "mrkdwn", text } },
            ];
            if (delivery.needsConfirm && index === parts.length - 1) {
              blocks.push(button("Confirm", CONFIRM_DECISION_ACTION, delivery.decisionId));
            }
            await slack.postMessage({ channel, thread_ts, text, blocks });
          }
          return;
        }
        case "status":
          for (const timestamp of delivery.messageIds) {
            await ignoreHarmless(
              slack.addReaction({ channel, timestamp, name: STATUS_REACTION[delivery.status] }),
            );
            await ignoreHarmless(
              slack.removeReaction({ channel, timestamp, name: RECEIVED_REACTION }),
            );
          }
          return;
      }
    },

    /**
     * Opens the direct message with the person (`conversations.open`, which needs `im:write`)
     * and posts the text there, converted and split like a reply, outside any thread and with
     * no previews (slice 3.4). Throws when it did not go out, so the API tries again. The
     * workspace is the bot token's own.
     */
    async direct(message) {
      const parts = splitForSlack(markdownToSlack(message.text));
      if (parts.length === 0) throw new Error("The direct message is empty");
      const slack = getPoster();
      const channel = await slack.openDirect(message.userId);
      for (const text of parts) {
        await slack.postMessage({ channel, text });
      }
    },

    /**
     * The person's time zone from `users.info`, kept for an hour (slice 3.4). Undefined when
     * Slack has none for them, one this runtime does not know, or does not know the person.
     * Any other failure throws, so a passing outage is not taken for "no time zone".
     */
    async timeZone(person) {
      const key = `${person.workspaceId}:${person.userId}`;
      const cached = timeZones.get(key);
      if (cached !== undefined && cached.until > now()) return cached.timeZone;
      let timeZone: string | undefined;
      try {
        timeZone = knownTimeZone(await getPoster().userTimeZone(person.userId));
      } catch (error) {
        if (!NO_SUCH_USER.has(slackErrorCode(error) ?? "")) throw error;
        timeZone = undefined;
      }
      timeZones.set(key, { timeZone, until: now() + TIME_ZONE_TTL_MS });
      return timeZone;
    },
  };
}

/**
 * A button under a brief (Start) or a proposed decision (Confirm). Pressing it sends a
 * `block_actions` payload to `/slack/events`, which the handler for its action turns into a
 * call to the API (`POST /v1/briefs/:id/start`, `POST /v1/decisions/:id/confirm`).
 */
function button(text: string, actionId: string, value: string): types.ActionsBlock {
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text },
        style: "primary",
        action_id: actionId,
        value,
      },
    ],
  };
}

async function ignoreHarmless(call: Promise<void>): Promise<void> {
  try {
    await call;
  } catch (error) {
    if (!HARMLESS.has(slackErrorCode(error) ?? "")) throw error;
  }
}

function slackErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("data" in error)) return undefined;
  const { data } = error;
  if (typeof data !== "object" || data === null || !("error" in data)) return undefined;
  return typeof data.error === "string" ? data.error : undefined;
}

/** The part of a `conversations.open` response the adapter reads. */
const openedSchema = z.object({ channel: z.object({ id: z.string().min(1) }) });

/** The part of a `users.info` response the adapter reads. */
const userInfoSchema = z.object({ user: z.object({ tz: z.string().nullish() }).nullish() });

/**
 * The real Slack poster, built from the bot token on first use. Throws while Slack is not
 * configured, which fails the delivery so it is retried once it is.
 */
export function slackPosterFromEnv(env: Env, log: Logger): () => SlackPoster {
  let client: webApi.WebClient | undefined;
  return () => {
    if (client === undefined) {
      const config = readSlackConfig(env, log);
      if (config === undefined) throw new Error("Slack is not configured");
      // A slow Slack must not hold reconcile, which sends briefs (from the review of 3.4).
      client = new webApi.WebClient(config.botToken, {
        retryConfig: { retries: 1 },
        timeout: 10_000,
      });
    }
    const web = client;
    return {
      postMessage: async (input) => {
        await web.chat.postMessage({
          channel: input.channel,
          text: input.text,
          ...(input.thread_ts === undefined ? {} : { thread_ts: input.thread_ts }),
          ...(input.blocks === undefined ? {} : { blocks: input.blocks }),
          unfurl_links: false,
          unfurl_media: false,
        });
      },
      addReaction: async (input) => {
        await web.reactions.add(input);
      },
      removeReaction: async (input) => {
        await web.reactions.remove(input);
      },
      // Needs `im:write` (slice 3.4). Until the app is reinstalled with it, Slack answers
      // `missing_scope`, which fails the send so it is tried again.
      openDirect: async (userId) => {
        const opened = openedSchema.safeParse(await web.conversations.open({ users: userId }));
        if (!opened.success) throw new Error("Unexpected conversations.open response");
        return opened.data.channel.id;
      },
      userTimeZone: async (userId) => {
        const info = userInfoSchema.safeParse(await web.users.info({ user: userId }));
        if (!info.success) throw new Error("Unexpected users.info response");
        return info.data.user?.tz ?? undefined;
      },
    };
  };
}
