import type { Logger } from "../log.ts";
import type { ApiClient } from "./api-client.ts";
import { z } from "zod";
import { appMentionEnvelopeSchema, toInboundMessage } from "./map.ts";

/** The Slack Web API calls the adapter makes. */
export interface SlackActions {
  addReaction(input: { channel: string; timestamp: string; name: string }): Promise<void>;
  /** The person's display name, or undefined if Slack could not say. */
  userName(userId: string): Promise<string | undefined>;
}

export interface MentionDeps {
  api: ApiClient;
  slack: SlackActions;
  log: Logger;
}

export interface MentionDelivery {
  /** The whole Events API body, exactly as Slack sent it. */
  body: unknown;
  /** From Slack's `x-slack-retry-num` header; 0 for a first delivery. */
  retryNum: number;
  /** From Slack's `x-slack-retry-reason` header, for example `http_timeout`. */
  retryReason: string;
}

export type MentionOutcome =
  "reacted" | "stopped" | "dropped_retry" | "invalid_event" | "api_rejected" | "reaction_failed";

export const RECEIVED_REACTION = "saluting_face";
/** The reaction that stops the agent in a thread (decision 60). */
export const STOP_REACTION = "octagonal_sign";

/** A message that is only "stop" (after the bot's mention), never "don't stop". */
export function isStopCommand(text: string): boolean {
  return /^stop[.!]?$/i.test(text.trim());
}

/**
 * Handles one `app_mention`: send it to the API, and add 🫡 once the API has accepted it.
 * Never throws; every outcome is logged and returned.
 */
export async function handleMention(
  delivery: MentionDelivery,
  deps: MentionDeps,
): Promise<MentionOutcome> {
  const parsed = appMentionEnvelopeSchema.safeParse(delivery.body);
  const eventId = parsed.success ? parsed.data.event_id : undefined;
  const log = deps.log.child({ correlationId: eventId, source: "slack" });

  // After a timeout the first attempt is very likely still running, so a retry would only
  // duplicate it. Any other retry means the first attempt may have done nothing.
  if (delivery.retryNum > 0 && delivery.retryReason === "http_timeout") {
    log.info("slack.retry_dropped", {
      retryNum: delivery.retryNum,
      retryReason: delivery.retryReason,
    });
    return "dropped_retry";
  }

  // Kept so a real event can be copied from the log for the test fixture. A processed retry
  // logs it again, which is harmless.
  log.info("slack.mention.raw", {
    body: redactBody(delivery.body),
    retryNum: delivery.retryNum,
    retryReason: delivery.retryReason,
  });

  if (!parsed.success) {
    log.warn("slack.mention.invalid", {
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    });
    return "invalid_event";
  }
  const envelope = parsed.data;
  const correlationId = envelope.event_id;
  const message = toInboundMessage(envelope);

  if (isStopCommand(message.text)) {
    try {
      const stop = await deps.api.stop(
        {
          source: "slack",
          sourceEventId: envelope.event_id,
          workspaceId: envelope.team_id,
          channelId: envelope.event.channel,
          threadId: message.conversation.threadId,
          stopMessage: { messageId: envelope.event.ts, sentAt: message.sentAt },
          actor: { id: envelope.event.user },
        },
        correlationId,
      );
      if (stop.kind === "rejected") {
        log.error("slack.stop_rejected", { status: stop.status, error: stop.error });
        return "api_rejected";
      }
      log.info("slack.stop_requested", { result: stop.result.status });
      return "stopped";
    } catch (error) {
      log.error("slack.api_call_failed", { error });
      return "api_rejected";
    }
  }

  const displayName = await deps.slack
    .userName(envelope.event.user)
    .catch((error: unknown): undefined => {
      log.warn("slack.user_lookup_failed", { error });
      return undefined;
    });
  if (displayName !== undefined) message.actor.displayName = displayName;

  let result;
  try {
    result = await deps.api.postMessage(message, correlationId);
  } catch (error) {
    log.error("slack.api_call_failed", { error });
    return "api_rejected";
  }
  if (result.kind === "rejected") {
    log.error("slack.api_rejected", { status: result.status, error: result.error });
    return "api_rejected";
  }

  try {
    await deps.slack.addReaction({
      channel: envelope.event.channel,
      timestamp: envelope.event.ts,
      name: RECEIVED_REACTION,
    });
  } catch (error) {
    if (slackErrorCode(error) !== "already_reacted") {
      log.error("slack.reaction_failed", { error, slackError: slackErrorCode(error) });
      return "reaction_failed";
    }
  }
  log.info("slack.mention.handled", { messageId: result.accepted.id });
  return "reacted";
}

/**
 * Every Events API body carries Slack's legacy verification `token` at the top level. It is a
 * credential, so it never reaches the logs.
 */
export function redactBody(body: unknown): unknown {
  if (typeof body !== "object" || body === null || !("token" in body)) return body;
  return { ...body, token: "[redacted]" };
}

/** The `error` string from a Slack Web API error (for example `already_reacted`), if any. */
function slackErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("data" in error)) return undefined;
  const { data } = error;
  if (typeof data !== "object" || data === null || !("error" in data)) return undefined;
  return typeof data.error === "string" ? data.error : undefined;
}

const reactionEnvelopeSchema = z.object({
  team_id: z.string().min(1),
  event_id: z.string().min(1),
  authorizations: z.array(z.object({ user_id: z.string().min(1) })).optional(),
  event: z.object({
    type: z.literal("reaction_added"),
    user: z.string().min(1),
    reaction: z.string(),
    item: z.object({ type: z.string(), channel: z.string().min(1), ts: z.string().min(1) }),
  }),
});

export type ReactionOutcome = "stopped" | "ignored" | "invalid_event" | "api_rejected";

/**
 * Handles `reaction_added`: a 🛑 on a message of a conversation stops the agent there
 * (decision 60). Every other reaction, and the bot's own, is ignored.
 */
export async function handleReaction(
  body: unknown,
  deps: { api: ApiClient; log: Logger },
): Promise<ReactionOutcome> {
  const parsed = reactionEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    deps.log.warn("slack.reaction.invalid", {
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    });
    return "invalid_event";
  }
  const { event, event_id: eventId, team_id: workspaceId } = parsed.data;
  const botUserId = parsed.data.authorizations?.[0]?.user_id;
  // The bot puts 🛑 on messages itself (the stopped status); without its id those can't be
  // told apart from a person's, so the event is ignored.
  if (
    event.reaction !== STOP_REACTION ||
    event.item.type !== "message" ||
    botUserId === undefined ||
    event.user === botUserId
  ) {
    return "ignored";
  }
  const log = deps.log.child({ correlationId: eventId, source: "slack" });
  try {
    const stop = await deps.api.stop(
      {
        source: "slack",
        sourceEventId: eventId,
        workspaceId,
        channelId: event.item.channel,
        messageId: event.item.ts,
        actor: { id: event.user },
      },
      eventId,
    );
    if (stop.kind === "rejected") {
      log.error("slack.stop_rejected", { status: stop.status, error: stop.error });
      return "api_rejected";
    }
    log.info("slack.stop_requested", { via: "reaction", result: stop.result.status });
    return "stopped";
  } catch (error) {
    log.error("slack.api_call_failed", { error });
    return "api_rejected";
  }
}
