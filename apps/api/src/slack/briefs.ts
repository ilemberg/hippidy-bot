import { briefsCommand } from "@hippidy/contracts";
import { z } from "zod";
import type { Logger } from "../log.ts";
import type { ApiClient } from "./api-client.ts";
import { stripBotMention } from "./map.ts";

// Daily briefs (slice 3.4, decision 212): "stop briefs" and "start briefs", written to the bot
// in a direct message or after a mention anywhere, and the one line the bot says to any other
// direct message. Sending the briefs themselves is the deliverer's `direct` (deliver.ts).

/** The answer to "stop briefs". */
export const BRIEFS_STOPPED_TEXT = "Briefs stopped. Write start briefs to get them again.";
/** The answer to "start briefs". */
export const BRIEFS_STARTED_TEXT =
  "Briefs started: one direct message on weekday mornings when something is new.";
/** The answer to any other direct message: talking to the bot there is not in 3.4. */
export const DIRECT_MESSAGE_HELP_TEXT =
  "I send a brief here on weekday mornings. Write stop briefs or start briefs; to ask me anything, mention me in a channel.";

/** The Slack calls switching briefs makes. */
export interface BriefsSlack {
  /** The person's display name, or undefined if Slack could not say. */
  userName(userId: string): Promise<string | undefined>;
  /** Posts a message in a channel, or in a thread with `threadTs` (`chat.postMessage`). */
  postMessage(input: { channel: string; text: string; threadTs?: string }): Promise<void>;
}

export interface BriefsDeps {
  api: ApiClient;
  slack: BriefsSlack;
  log: Logger;
}

export type BriefsOutcome = "briefs_set" | "api_rejected";

/**
 * Switches a person's briefs off or on through the API, as that person, and answers once
 * where they wrote, with what their briefs are now. When the API refuses, it logs and says
 * nothing, as the listen command does. Never throws.
 */
export async function switchBriefs(
  input: {
    workspaceId: string;
    userId: string;
    command: "on" | "off";
    /** Where to answer: the channel, and the thread if there is one. */
    channel: string;
    threadTs: string | undefined;
    correlationId: string;
  },
  deps: BriefsDeps,
): Promise<BriefsOutcome> {
  const { log } = deps;
  const displayName = await deps.slack.userName(input.userId).catch((error: unknown): undefined => {
    log.warn("slack.user_lookup_failed", { error });
    return undefined;
  });
  let result;
  try {
    result = await deps.api.setBriefs(
      {
        source: "slack",
        workspaceId: input.workspaceId,
        actor: displayName === undefined ? { id: input.userId } : { id: input.userId, displayName },
        on: input.command === "on",
      },
      input.correlationId,
    );
  } catch (error) {
    log.error("slack.api_call_failed", { error });
    return "api_rejected";
  }
  if (result.kind === "rejected") {
    log.error("slack.briefs_rejected", { status: result.status, error: result.error });
    return "api_rejected";
  }
  log.info("slack.briefs_set", { on: result.result.on });
  await deps.slack
    .postMessage({
      channel: input.channel,
      text: result.result.on ? BRIEFS_STARTED_TEXT : BRIEFS_STOPPED_TEXT,
      ...(input.threadTs === undefined ? {} : { threadTs: input.threadTs }),
    })
    .catch((error: unknown) => {
      log.warn("slack.briefs_reply_failed", { error });
    });
  return "briefs_set";
}

const slackTs = z.string().regex(/^\d+\.\d+$/);

/** The parts of a `message` event in the bot's direct message (`message.im`) the adapter reads. */
const directMessageEnvelopeSchema = z.object({
  team_id: z.string().min(1),
  event_id: z.string().min(1),
  authorizations: z.array(z.object({ user_id: z.string().min(1) })).optional(),
  event: z.object({
    type: z.literal("message"),
    channel: z.string().min(1),
    channel_type: z.literal("im"),
    subtype: z.string().optional(),
    user: z.string().min(1).optional(),
    bot_id: z.string().nullish(),
    text: z.string().optional(),
    ts: slackTs,
    thread_ts: slackTs.optional(),
  }),
});

/** Whether a `message` event was written in a direct message with the bot. */
export function isDirectMessageEvent(body: unknown): boolean {
  return z.object({ event: z.object({ channel_type: z.literal("im") }) }).safeParse(body).success;
}

export type DirectMessageOutcome =
  BriefsOutcome | "answered" | "ignored" | "dropped_retry" | "invalid_event" | "reply_failed";

/**
 * Handles a person's message in their direct message with the bot (slice 3.4): "stop briefs"
 * or "start briefs" switches their briefs; anything else gets one line saying what the bot
 * does there. The bot's own messages, other bots', edits, deletions and every other subtype
 * are ignored, so the bot never answers itself. Never throws.
 */
export async function handleDirectMessage(
  delivery: { body: unknown; retryNum: number; retryReason: string },
  deps: BriefsDeps,
): Promise<DirectMessageOutcome> {
  const parsed = directMessageEnvelopeSchema.safeParse(delivery.body);
  const eventId = parsed.success ? parsed.data.event_id : undefined;
  const log = deps.log.child({ correlationId: eventId, source: "slack" });
  // As for a mention: after a timeout the first attempt is very likely still running, and a
  // retry would answer twice.
  if (delivery.retryNum > 0 && delivery.retryReason === "http_timeout") {
    log.info("slack.retry_dropped", {
      retryNum: delivery.retryNum,
      retryReason: delivery.retryReason,
    });
    return "dropped_retry";
  }
  if (!parsed.success) {
    log.warn("slack.direct_message.invalid", {
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    });
    return "invalid_event";
  }
  const { event, team_id: workspaceId } = parsed.data;
  const botUserId = parsed.data.authorizations?.[0]?.user_id;
  if (
    event.subtype !== undefined ||
    (event.bot_id !== undefined && event.bot_id !== null) ||
    event.user === undefined ||
    event.user === botUserId
  ) {
    return "ignored";
  }

  const command = briefsCommand(stripBotMention(event.text ?? "", botUserId));
  if (command !== undefined) {
    return switchBriefs(
      {
        workspaceId,
        userId: event.user,
        command,
        channel: event.channel,
        threadTs: event.thread_ts,
        correlationId: parsed.data.event_id,
      },
      { ...deps, log },
    );
  }
  try {
    await deps.slack.postMessage({
      channel: event.channel,
      text: DIRECT_MESSAGE_HELP_TEXT,
      ...(event.thread_ts === undefined ? {} : { threadTs: event.thread_ts }),
    });
  } catch (error) {
    log.warn("slack.direct_message.reply_failed", { error });
    return "reply_failed";
  }
  log.info("slack.direct_message.answered");
  return "answered";
}
