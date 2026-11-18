import { describe, expect, it } from "vitest";
import fixture from "./fixtures/app-mention.json" with { type: "json" };
import recorded from "./fixtures/recorded-app-mention.json" with { type: "json" };
import {
  appMentionEnvelopeSchema,
  slackTsToIso,
  stripBotMention,
  toInboundMessage,
} from "./map.ts";

describe("toInboundMessage", () => {
  // Captured from production on 2026-11-18 (the slice 1 demo), from the slack.mention.raw log
  // line. Slack's `token` was already redacted by the adapter; `blocks` is left out because the
  // log viewer collapsed it and the adapter does not read it.
  it("maps a real recorded app_mention to the API's message", () => {
    const envelope = appMentionEnvelopeSchema.parse(recorded);
    expect(toInboundMessage(envelope)).toEqual({
      source: "slack",
      sourceEventId: "Ev0CJTQ9C4AY",
      conversation: {
        workspaceId: "T0CHY9BFQ5Q",
        channelId: "C0CHT679Y1K",
        threadId: "1794971036.957189",
        messageId: "1794971036.957189",
      },
      actor: { id: "U0CHWFTRRJS" },
      text: "did it work?",
      sentAt: "2026-11-18T03:03:56.957Z",
    });
  });

  it("maps Slack's documented app_mention example to the API's message", () => {
    const envelope = appMentionEnvelopeSchema.parse(fixture);
    expect(toInboundMessage(envelope)).toEqual({
      source: "slack",
      sourceEventId: "Ev0LAN670R",
      conversation: {
        workspaceId: "T061EG9R6",
        channelId: "C0LAN2Q65",
        threadId: "1515449522.000016",
        messageId: "1515449522.000016",
      },
      actor: { id: "U061F7AUR" },
      text: "What is the hour of the pearl, ?",
      sentAt: "2018-01-08T22:12:02.000Z",
    });
  });

  it("uses the parent's thread_ts for a reply in a thread", () => {
    const envelope = appMentionEnvelopeSchema.parse({
      ...fixture,
      event: { ...fixture.event, ts: "1515449600.000100", thread_ts: "1515449522.000016" },
    });
    const message = toInboundMessage(envelope);
    expect(message.conversation.threadId).toBe("1515449522.000016");
    expect(message.conversation.messageId).toBe("1515449600.000100");
  });

  it("prefers the bot id from authorizations", () => {
    const envelope = appMentionEnvelopeSchema.parse({
      ...fixture,
      authorizations: [{ user_id: "UBOT" }],
      event: { ...fixture.event, text: "<@UBOT> hi <@U0LAN0Z89>" },
    });
    expect(toInboundMessage(envelope).text).toBe("hi <@U0LAN0Z89>");
  });

  it("rejects a mention with no sender", () => {
    const { user: _user, ...event } = fixture.event;
    expect(appMentionEnvelopeSchema.safeParse({ ...fixture, event }).success).toBe(false);
  });
});

describe("stripBotMention", () => {
  it.each([
    ["<@UBOT> deploy it", "deploy it"],
    ["deploy it <@UBOT>", "deploy it"],
    ["hey <@UBOT|hippidy-bot>, deploy it", "hey , deploy it"],
    ["<@UBOT> <@UBOT> twice", "twice"],
    ["<@UBOT>", ""],
    ["ask <@UOTHER> too", "ask <@UOTHER> too"],
    ["line one\nline two <@UBOT>", "line one\nline two"],
  ])("%j becomes %j", (input, expected) => {
    expect(stripBotMention(input, "UBOT")).toBe(expected);
  });

  it("leaves the text alone when the bot id is unknown", () => {
    expect(stripBotMention(" <@UBOT> hi ", undefined)).toBe("<@UBOT> hi");
  });
});

describe("slackTsToIso", () => {
  it("keeps millisecond precision", () => {
    expect(slackTsToIso("1515449522.123456")).toBe("2018-01-08T22:12:02.123Z");
  });
});
