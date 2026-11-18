import type { Logger } from "../log.ts";
import type { ApiClient } from "./api-client.ts";
import { appMentionEnvelopeSchema, toInboundMessage } from "./map.ts";

/** The Slack Web API calls the adapter makes. */
export interface SlackActions {
  addReaction(input: { channel: string; timestamp: string; name: string }): Promise<void>;
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
  "reacted" | "dropped_retry" | "invalid_event" | "api_rejected" | "reaction_failed";

export const RECEIVED_REACTION = "eyes";

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

  let result;
  try {
    result = await deps.api.postMessage(toInboundMessage(envelope), correlationId);
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
