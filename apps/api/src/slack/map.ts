import type { InboundMessage } from "@hippidy/contracts";
import { z } from "zod";

const slackTs = z.string().regex(/^\d+\.\d+$/);

/** The parts of an Events API `app_mention` delivery the adapter relies on. */
export const appMentionEnvelopeSchema = z.object({
  team_id: z.string().min(1),
  event_id: z.string().min(1),
  authorizations: z.array(z.object({ user_id: z.string().min(1) })).optional(),
  authed_users: z.array(z.string().min(1)).optional(),
  event: z.object({
    type: z.literal("app_mention"),
    user: z.string().min(1),
    text: z.string(),
    ts: slackTs,
    thread_ts: slackTs.optional(),
    channel: z.string().min(1),
  }),
});
export type AppMentionEnvelope = z.infer<typeof appMentionEnvelopeSchema>;

/** The bot's own user id, as Slack reports it in the delivery. */
export function botUserIdOf(envelope: AppMentionEnvelope): string | undefined {
  return envelope.authorizations?.[0]?.user_id ?? envelope.authed_users?.[0];
}

/** Removes every mention of the bot (`<@U123>` or `<@U123|name>`) and collapses the spaces left. */
export function stripBotMention(text: string, botUserId: string | undefined): string {
  if (botUserId === undefined) return text.trim();
  const mention = new RegExp(`<@${escapeRegExp(botUserId)}(\\|[^>]*)?>`, "g");
  return text
    .replace(mention, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** Converts a Slack `ts` ("seconds.micros") to an ISO 8601 timestamp, exact to the millisecond. */
export function slackTsToIso(ts: string): string {
  const [seconds = "0", fraction = ""] = ts.split(".");
  const millis = Number(seconds) * 1000 + Number(fraction.padEnd(3, "0").slice(0, 3));
  return new Date(millis).toISOString();
}

/** Maps a Slack mention to the API's channel-agnostic message. */
export function toInboundMessage(envelope: AppMentionEnvelope): InboundMessage {
  const { event } = envelope;
  return {
    source: "slack",
    sourceEventId: envelope.event_id,
    conversation: {
      workspaceId: envelope.team_id,
      channelId: event.channel,
      // A top-level message starts its own thread, identified by its own ts.
      threadId: event.thread_ts ?? event.ts,
      messageId: event.ts,
    },
    actor: { id: event.user },
    text: stripBotMention(event.text, botUserIdOf(envelope)),
    sentAt: slackTsToIso(event.ts),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
