import {
  OBSERVED_MESSAGE_RETENTION_DAYS,
  OBSERVED_TEXT_MAX,
  type Observation,
} from "@hippidy/contracts";
import { z } from "zod";
import type { Logger } from "../log.ts";
import type { ApiClient } from "./api-client.ts";
import type { AppMentionEnvelope } from "./map.ts";
import { slackTsToIso } from "./map.ts";

// Listening in channels (slice 2.5, decisions 176, 198 and 199): the "listen" and "stop
// listening" commands, and the channel messages Slack sends, mapped to the contract. The
// adapter forwards every message; the API keeps only those of listened channels.

/** The reaction on a listen command once the API has it. */
export const LISTEN_DONE_REACTION = "white_check_mark";

/**
 * "listen" or "stop listening", the whole message after the bot's mention, so a question that
 * mentions listening still goes to the teammate. "here" or "in this channel" may follow.
 */
export function listenCommand(text: string): "on" | "off" | undefined {
  const t = text.trim().replace(/\s+/g, " ").toLowerCase();
  const where = "(?: (?:here|in this channel))?[.!]?";
  if (new RegExp(`^(?:start )?listen(?:ing)?${where}$`).test(t)) return "on";
  if (new RegExp(`^stop listening${where}$`).test(t)) return "off";
  return undefined;
}

/** Direct messages and group DMs are never listened to. */
export function isChannel(channelId: string): boolean {
  return !channelId.startsWith("D");
}

/** The note posted in the channel when listening starts or stops (176, G9). */
export function listeningNote(
  listening: boolean,
  actorId: string,
  webBaseUrl: string | undefined,
): string {
  const page =
    webBaseUrl === undefined ? "" : ` What that means: <${webBaseUrl}/listening|listening>.`;
  if (!listening) {
    return `<@${actorId}> switched listening off: I no longer read this channel unless I'm mentioned. What I kept from it is deleted ${String(OBSERVED_MESSAGE_RETENTION_DAYS)} days after it was written.${page}`;
  }
  return [
    `<@${actorId}> switched listening on: I now read this channel, without replying to anything that doesn't mention me.`,
    `When a thread has been quiet for half an hour I may note decisions from it as proposals, each with a link to the message. People in the thread confirm them; I never record one on my own.`,
    `I keep the text of messages here for ${String(OBSERVED_MESSAGE_RETENTION_DAYS)} days. Deleting a message in Slack deletes my copy too. Say "@hippidy stop listening" to switch it off.${page}`,
  ].join("\n");
}

export interface ListenSlack {
  addReaction(input: { channel: string; timestamp: string; name: string }): Promise<void>;
  postMessage(input: { channel: string; text: string; threadTs?: string }): Promise<void>;
}

export type ListenOutcome = "listening_set" | "not_a_channel" | "api_rejected";

/** Handles "listen" or "stop listening" from a mention. Never throws. */
export async function handleListenCommand(
  envelope: AppMentionEnvelope,
  command: "on" | "off",
  deps: { api: ApiClient; slack: ListenSlack; log: Logger; webBaseUrl: string | undefined },
): Promise<ListenOutcome> {
  const { event } = envelope;
  const log = deps.log;
  if (!isChannel(event.channel)) {
    await deps.slack
      .postMessage({ channel: event.channel, text: "I only listen in channels." })
      .catch((error: unknown) => {
        log.warn("slack.listen_reply_failed", { error });
      });
    return "not_a_channel";
  }
  let result;
  try {
    result = await deps.api.setListening(
      {
        source: "slack",
        workspaceId: envelope.team_id,
        channelId: event.channel,
        listening: command === "on",
        actor: { id: event.user },
      },
      envelope.event_id,
    );
  } catch (error) {
    log.error("slack.api_call_failed", { error });
    return "api_rejected";
  }
  if (result.kind === "rejected") {
    log.error("slack.listen_rejected", { status: result.status, error: result.error });
    return "api_rejected";
  }
  if (result.result.changed) {
    try {
      await deps.slack.postMessage({
        channel: event.channel,
        text: listeningNote(command === "on", event.user, deps.webBaseUrl),
      });
    } catch (error) {
      log.error("slack.listen_note_failed", { error });
    }
  }
  await deps.slack
    .addReaction({ channel: event.channel, timestamp: event.ts, name: LISTEN_DONE_REACTION })
    .catch((error: unknown) => {
      log.warn("slack.reaction_failed", { error });
    });
  log.info("slack.listening_set", { listening: command === "on", changed: result.result.changed });
  return "listening_set";
}

const slackTs = z.string().regex(/^\d+\.\d+$/);

const messageEnvelopeSchema = z.object({
  team_id: z.string().min(1),
  event_id: z.string().min(1),
  event: z.object({
    type: z.literal("message"),
    channel: z.string().min(1),
    channel_type: z.string().optional(),
    subtype: z.string().optional(),
    user: z.string().min(1).optional(),
    bot_id: z.string().optional(),
    text: z.string().optional(),
    ts: slackTs,
    thread_ts: slackTs.optional(),
    deleted_ts: slackTs.optional(),
    message: z
      .object({
        user: z.string().min(1).optional(),
        bot_id: z.string().optional(),
        text: z.string().optional(),
        ts: slackTs,
        edited: z.object({ ts: slackTs }).optional(),
      })
      .optional(),
  }),
});

/** Subtypes that are a person's message; joins, topic changes and the like are not. */
const POSTED_SUBTYPES = new Set([undefined, "thread_broadcast", "file_share"]);

function clipText(text: string): string {
  return text.length <= OBSERVED_TEXT_MAX ? text : `${text.slice(0, OBSERVED_TEXT_MAX - 1)}…`;
}

/**
 * A Slack `message` event as an observation, or undefined for one that is not a person's
 * message in a channel (a DM, a bot, an empty file share, a join, an unfurl).
 */
export function toObservation(body: unknown): Observation | undefined {
  const parsed = messageEnvelopeSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const { team_id: workspaceId, event } = parsed.data;
  if (event.channel_type === "im" || event.channel_type === "mpim") return undefined;
  if (!isChannel(event.channel)) return undefined;
  const where = { source: "slack" as const, workspaceId, channelId: event.channel };

  if (event.subtype === "message_deleted") {
    return event.deleted_ts === undefined
      ? undefined
      : { kind: "deleted", ...where, messageId: event.deleted_ts };
  }
  if (event.subtype === "message_changed") {
    const changed = event.message;
    // An unfurl or a bot's update changes a message without anyone editing it.
    if (changed?.edited === undefined || changed.bot_id !== undefined) return undefined;
    return {
      kind: "edited",
      ...where,
      messageId: changed.ts,
      text: clipText(changed.text ?? ""),
      editedAt: slackTsToIso(changed.edited.ts),
    };
  }
  if (!POSTED_SUBTYPES.has(event.subtype)) return undefined;
  if (event.bot_id !== undefined || event.user === undefined) return undefined;
  const text = (event.text ?? "").trim();
  if (text.length === 0) return undefined;
  return {
    kind: "posted",
    ...where,
    messageId: event.ts,
    threadId: event.thread_ts ?? event.ts,
    actor: { id: event.user },
    text: clipText(text),
    sentAt: slackTsToIso(event.ts),
  };
}

export type ChannelMessageOutcome = "observed" | "ignored" | "dropped_retry" | "api_rejected";

/**
 * Handles one `message` event: forwards a person's channel message to the API, which keeps it
 * only if the channel is listened to. A retry after a timeout is dropped, as for mentions; any
 * other retry is safe, since a message is kept once. Never throws.
 */
export async function handleChannelMessage(
  delivery: { body: unknown; retryNum: number; retryReason: string },
  deps: {
    api: ApiClient;
    userName: (userId: string) => Promise<string | undefined>;
    log: Logger;
  },
): Promise<ChannelMessageOutcome> {
  if (delivery.retryNum > 0 && delivery.retryReason === "http_timeout") return "dropped_retry";
  const observation = toObservation(delivery.body);
  if (observation === undefined) return "ignored";
  const eventId = z.object({ event_id: z.string() }).safeParse(delivery.body).data?.event_id;
  const log = deps.log.child({ correlationId: eventId, source: "slack" });
  if (observation.kind === "posted") {
    const name = await deps.userName(observation.actor.id).catch((error: unknown): undefined => {
      log.warn("slack.user_lookup_failed", { error });
      return undefined;
    });
    if (name !== undefined) observation.actor.displayName = name;
  }
  try {
    const result = await deps.api.observe(observation, eventId ?? "slack-message");
    if (result.kind === "rejected") {
      log.error("slack.observe_rejected", { status: result.status, error: result.error });
      return "api_rejected";
    }
    return "observed";
  } catch (error) {
    log.error("slack.api_call_failed", { error });
    return "api_rejected";
  }
}
