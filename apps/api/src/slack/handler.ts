import type { ConfirmDecisionResult, ContextMessage, StartBriefResult } from "@hippidy/contracts";
import type { Logger } from "../log.ts";
import type { ApiClient } from "./api-client.ts";
import { z } from "zod";
import { handleListenCommand, listenCommand, type ListenOutcome } from "./listening.ts";
import {
  appMentionEnvelopeSchema,
  botUserIdOf,
  toInboundMessage,
  type AppMentionEnvelope,
} from "./map.ts";
import {
  fitContext,
  readThreadContext,
  THREAD_READ_TIMEOUT_MS,
  type SlackThreadMessage,
} from "./thread.ts";

/** The Slack Web API calls the adapter makes. */
export interface SlackActions {
  addReaction(input: { channel: string; timestamp: string; name: string }): Promise<void>;
  /** The person's display name, or undefined if Slack could not say. */
  userName(userId: string): Promise<string | undefined>;
  /** One page of a thread's messages, oldest first (`conversations.replies`). */
  threadReplies(channel: string, threadTs: string): Promise<SlackThreadMessage[]>;
  /** Posts a message in a channel, or in a thread with `threadTs` (`chat.postMessage`). */
  postMessage(input: { channel: string; text: string; threadTs?: string }): Promise<void>;
  /** A message only `user` sees (`chat.postEphemeral`). */
  postEphemeral(input: {
    channel: string;
    user: string;
    text: string;
    threadTs?: string;
  }): Promise<void>;
}

export interface MentionDeps {
  api: ApiClient;
  slack: SlackActions;
  log: Logger;
  /** How long reading the thread may take; `THREAD_READ_TIMEOUT_MS` unless a test says. */
  threadReadTimeoutMs?: number;
  /** The web app, for the link in the listening note (slice 2.5). */
  webBaseUrl?: string | undefined;
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
  | "reacted"
  | "stopped"
  | "dropped_retry"
  | "invalid_event"
  | "api_rejected"
  | "reaction_failed"
  | ListenOutcome;

export const RECEIVED_REACTION = "eyes";
/** The reaction that stops the agent in a thread (decision 60). */
export const STOP_REACTION = "octagonal_sign";
/** The `action_id` of the Start button under a brief (slice 2.1, G17). */
export const START_CHANGE_ACTION = "start_change";
/** The Confirm button under a proposed decision (slice 2.2, decision 192). */
export const CONFIRM_DECISION_ACTION = "confirm_decision";

/** Said privately to someone whose Confirm was refused (decision 201). */
export const notAllowedText =
  "Only people who wrote to me in this thread, or the owner of its area, can confirm this decision. Mention me here to take part, then press Confirm again.";

/** What a person who pressed Confirm is told privately, when anything but done. */
const privateConfirmTexts: Partial<Record<ConfirmDecisionResult["status"], string>> = {
  not_allowed: notAllowedText,
  changed:
    "Its wording was changed in the web app after it was posted here, so it was not confirmed. Read it under Decisions in the web app, and confirm it there.",
  not_proposed: "This decision was already confirmed or rejected.",
};

/** A message that is only "stop" (after the bot's mention), never "don't stop". */
export function isStopCommand(text: string): boolean {
  return /^stop[.!]?$/i.test(text.trim());
}

/**
 * Handles one `app_mention`: send it to the API, and add 👀 once the API has accepted it.
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

  // "listen" or "stop listening" (slice 2.5) switches listening in the channel; it is not a
  // message for the teammate.
  const listen = listenCommand(message.text);
  if (listen !== undefined) {
    return handleListenCommand(envelope, listen, {
      api: deps.api,
      slack: deps.slack,
      log,
      webBaseUrl: deps.webBaseUrl,
    });
  }

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

  const [displayName, context] = await Promise.all([
    deps.slack.userName(envelope.event.user).catch((error: unknown): undefined => {
      log.warn("slack.user_lookup_failed", { error });
      return undefined;
    }),
    threadContext(envelope, deps, log),
  ]);
  if (displayName !== undefined) message.actor.displayName = displayName;
  if (context.length > 0) {
    message.context = context;
    const dropped = fitContext(message);
    log.info("slack.thread_read", { contextMessages: context.length - dropped, dropped });
  }

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
 * What was said in the thread since the bot's last message (decision 140). A top-level mention
 * starts its thread, so it has none. Any failure (`missing_scope` until the app is reinstalled
 * with the history scopes, a timeout, a bad response) is logged by its code and the mention
 * goes without context, exactly as before.
 *
 * Latency: Bolt acknowledges an Events API delivery before it calls the listener, and
 * `@vercel/slack-bolt` keeps the listener running after the response with `waitUntil`, so this
 * call is outside Slack's 3 second limit. It still delays 👀 and the agent, so it is bounded
 * by `THREAD_READ_TIMEOUT_MS` (1.5 s), and runs alongside the sender's name lookup.
 */
async function threadContext(
  envelope: AppMentionEnvelope,
  deps: MentionDeps,
  log: Logger,
): Promise<ContextMessage[]> {
  const { event } = envelope;
  if (event.thread_ts === undefined || event.thread_ts === event.ts) return [];
  try {
    return await readThreadContext(
      {
        channel: event.channel,
        threadTs: event.thread_ts,
        mentionTs: event.ts,
        botUserId: botUserIdOf(envelope),
      },
      deps.slack,
      deps.threadReadTimeoutMs ?? THREAD_READ_TIMEOUT_MS,
    );
  } catch (error) {
    log.warn("slack.thread_read_failed", { slackError: errorCode(error) });
    return [];
  }
}

/** Slack's error code (`missing_scope`), else the error's own code (`timeout`), else `unknown`. */
function errorCode(error: unknown): string {
  const slack = slackErrorCode(error);
  if (slack !== undefined) return slack;
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    if (typeof code === "string") return code;
  }
  return "unknown";
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

/**
 * The parts of a `block_actions` payload the Start button needs. The rest (including Slack's
 * legacy verification `token`) is left out and never logged.
 */
const blockActionsSchema = z.object({
  type: z.literal("block_actions"),
  team: z.object({ id: z.string().min(1) }),
  user: z.object({ id: z.string().min(1) }),
  trigger_id: z.string().min(1),
  channel: z.object({ id: z.string().min(1) }).optional(),
  container: z.object({ thread_ts: z.string().optional() }).optional(),
  actions: z
    .array(
      z.object({
        action_id: z.string(),
        value: z.string().optional(),
        action_ts: z.string().min(1).optional(),
      }),
    )
    .min(1),
});

const briefIdSchema = z.guid();

export type StartBriefOutcome =
  StartBriefResult["status"] | "ignored" | "invalid_action" | "api_rejected";

/**
 * Handles a press of the Start button under a brief (slice 2.1, G17): asks the API to start
 * it, as the person who pressed it. The API posts who started it in the thread, so this posts
 * nothing. Any other action is ignored. Never throws; every outcome is logged and returned.
 */
export async function handleStartBriefAction(
  body: unknown,
  deps: { api: ApiClient; slack: Pick<SlackActions, "userName">; log: Logger },
): Promise<StartBriefOutcome> {
  const parsed = blockActionsSchema.safeParse(body);
  if (!parsed.success) {
    deps.log.warn("slack.brief_start.invalid", {
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    });
    return "invalid_action";
  }
  const payload = parsed.data;
  const [action] = payload.actions;
  if (action?.action_id !== START_CHANGE_ACTION) return "ignored";

  const correlationId = action.action_ts ?? payload.trigger_id;
  const log = deps.log.child({ correlationId, source: "slack" });
  const briefId = briefIdSchema.safeParse(action.value);
  if (!briefId.success) {
    log.warn("slack.brief_start.invalid", { issues: ["actions.0.value: not a brief id"] });
    return "invalid_action";
  }

  const displayName = await deps.slack
    .userName(payload.user.id)
    .catch((error: unknown): undefined => {
      log.warn("slack.user_lookup_failed", { error });
      return undefined;
    });
  try {
    const start = await deps.api.startBrief(
      briefId.data,
      {
        source: "slack",
        workspaceId: payload.team.id,
        actor:
          displayName === undefined
            ? { id: payload.user.id }
            : { id: payload.user.id, displayName },
      },
      correlationId,
    );
    if (start.kind === "rejected") {
      log.error("slack.brief_start_rejected", {
        briefId: briefId.data,
        status: start.status,
        error: start.error,
      });
      return "api_rejected";
    }
    log.info("slack.brief_start", { briefId: briefId.data, result: start.result.status });
    return start.result.status;
  } catch (error) {
    log.error("slack.api_call_failed", { error });
    return "api_rejected";
  }
}

export type ConfirmDecisionOutcome =
  ConfirmDecisionResult["status"] | "ignored" | "invalid_action" | "api_rejected";

/**
 * Handles a press of the Confirm button under a proposed decision (slice 2.2, decision 192):
 * asks the API to confirm it, as the person who pressed it. The API says in the thread who
 * confirmed it. Any other action is ignored. Never throws; every outcome is logged and returned.
 */
export async function handleConfirmDecisionAction(
  body: unknown,
  deps: { api: ApiClient; slack: Pick<SlackActions, "userName" | "postEphemeral">; log: Logger },
): Promise<ConfirmDecisionOutcome> {
  const parsed = blockActionsSchema.safeParse(body);
  if (!parsed.success) {
    deps.log.warn("slack.decision_confirm.invalid", {
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    });
    return "invalid_action";
  }
  const payload = parsed.data;
  const [action] = payload.actions;
  if (action?.action_id !== CONFIRM_DECISION_ACTION) return "ignored";
  const correlationId = action.action_ts ?? payload.trigger_id;
  const log = deps.log.child({ correlationId, source: "slack" });
  const decisionId = briefIdSchema.safeParse(action.value);
  if (!decisionId.success) {
    log.warn("slack.decision_confirm.invalid", { issues: ["actions.0.value: not a decision id"] });
    return "invalid_action";
  }
  const displayName = await deps.slack
    .userName(payload.user.id)
    .catch((error: unknown): undefined => {
      log.warn("slack.user_lookup_failed", { error });
      return undefined;
    });
  try {
    const confirmed = await deps.api.confirmDecision(
      decisionId.data,
      {
        source: "slack",
        workspaceId: payload.team.id,
        actor:
          displayName === undefined
            ? { id: payload.user.id }
            : { id: payload.user.id, displayName },
      },
      correlationId,
    );
    if (confirmed.kind === "rejected") {
      log.error("slack.decision_confirm_rejected", {
        decisionId: decisionId.data,
        status: confirmed.status,
        error: confirmed.error,
      });
      return "api_rejected";
    }
    log.info("slack.decision_confirm", {
      decisionId: decisionId.data,
      result: confirmed.result.status,
    });
    // Refused, changed or already decided (201, 203): say so, to the person who pressed only.
    const privately = privateConfirmTexts[confirmed.result.status];
    if (privately !== undefined && payload.channel !== undefined) {
      const threadTs = payload.container?.thread_ts;
      await deps.slack
        .postEphemeral({
          channel: payload.channel.id,
          user: payload.user.id,
          text: privately,
          ...(threadTs === undefined ? {} : { threadTs }),
        })
        .catch((error: unknown) => {
          log.warn("slack.ephemeral_failed", { error });
        });
    }
    return confirmed.result.status;
  } catch (error) {
    log.error("slack.api_call_failed", { error });
    return "api_rejected";
  }
}
