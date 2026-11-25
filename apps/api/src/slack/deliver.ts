import type { Deliverer, OutboundDelivery } from "@hippidy/contracts";
import { type types, webApi } from "@slack/bolt";
import type { Env } from "../config.ts";
import type { Logger } from "../log.ts";
import { readSlackConfig } from "./config.ts";
import { CONFIRM_DECISION_ACTION, RECEIVED_REACTION, START_CHANGE_ACTION } from "./handler.ts";
import { markdownToSlack, splitForSlack } from "./markdown.ts";

/** The Slack Web API calls deliveries make. */
export interface SlackPoster {
  /** With `blocks`, Slack shows the blocks and uses `text` for notifications only. */
  postMessage(input: {
    channel: string;
    thread_ts: string;
    text: string;
    blocks?: types.KnownBlock[];
  }): Promise<void>;
  addReaction(input: { channel: string; timestamp: string; name: string }): Promise<void>;
  removeReaction(input: { channel: string; timestamp: string; name: string }): Promise<void>;
}

const STATUS_REACTION = { answered: "white_check_mark", failed: "x", stopped: "octagonal_sign" };

/** Slack's limit on the text of a section block. */
const SECTION_TEXT_CHARS = 3000;

/** Slack errors that mean the reaction is already in the state we want. */
const HARMLESS = new Set(["already_reacted", "no_reaction"]);

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

/**
 * Delivers the API's outbound messages to Slack (decision 53): replies go in the thread as
 * Slack-formatted text; a brief goes in the thread with a Start button under it when a person
 * must start it (slice 2.1, G17); and a status swaps the 👀 on each settled message for ✅, ❌
 * or 🛑. Throws if anything did not go out, so the API retries it.
 */
export function createSlackDeliverer(poster: SlackPoster | (() => SlackPoster)): Deliverer {
  const getPoster = typeof poster === "function" ? poster : () => poster;
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
