import type { Deliverer, OutboundDelivery } from "@hippidy/contracts";
import { webApi } from "@slack/bolt";
import type { Env } from "../config.ts";
import type { Logger } from "../log.ts";
import { readSlackConfig } from "./config.ts";
import { RECEIVED_REACTION } from "./handler.ts";
import { markdownToSlack, splitForSlack } from "./markdown.ts";

/** The Slack Web API calls deliveries make. */
export interface SlackPoster {
  postMessage(input: { channel: string; thread_ts: string; text: string }): Promise<void>;
  addReaction(input: { channel: string; timestamp: string; name: string }): Promise<void>;
  removeReaction(input: { channel: string; timestamp: string; name: string }): Promise<void>;
}

const STATUS_REACTION = { answered: "white_check_mark", failed: "x", stopped: "octagonal_sign" };

/** Slack errors that mean the reaction is already in the state we want. */
const HARMLESS = new Set(["already_reacted", "no_reaction"]);

/**
 * Delivers the API's outbound messages to Slack (decision 53): replies go in the thread as
 * Slack-formatted text, and a status swaps the 🫡 on each settled message for ✅, ❌ or 🛑.
 * Throws if anything did not go out, so the API retries it.
 */
export function createSlackDeliverer(poster: SlackPoster | (() => SlackPoster)): Deliverer {
  const getPoster = typeof poster === "function" ? poster : () => poster;
  return {
    async deliver(delivery: OutboundDelivery) {
      const slack = getPoster();
      const channel = delivery.target.channelId;
      if (delivery.kind === "reply") {
        for (const text of splitForSlack(markdownToSlack(delivery.text))) {
          await slack.postMessage({ channel, thread_ts: delivery.target.threadId, text });
        }
        return;
      }
      for (const timestamp of delivery.messageIds) {
        await ignoreHarmless(
          slack.addReaction({ channel, timestamp, name: STATUS_REACTION[delivery.status] }),
        );
        await ignoreHarmless(slack.removeReaction({ channel, timestamp, name: RECEIVED_REACTION }));
      }
    },
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
      client = new webApi.WebClient(config.botToken, { retryConfig: { retries: 1 } });
    }
    const web = client;
    return {
      postMessage: async (input) => {
        await web.chat.postMessage({ ...input, unfurl_links: false, unfurl_media: false });
      },
      addReaction: async (input) => {
        await web.reactions.add(input);
      },
      removeReaction: async (input) => {
        await web.reactions.remove(input);
      },
    };
  };
}
