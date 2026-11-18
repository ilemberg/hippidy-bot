import { describe, expect, it } from "vitest";
import { inboundMessageSchema, type InboundMessage } from "./messages.ts";

const valid: InboundMessage = {
  source: "slack",
  sourceEventId: "Ev0123456789",
  conversation: {
    workspaceId: "T0123456789",
    channelId: "C0123456789",
    threadId: "1763400000.000100",
    messageId: "1763400000.000100",
  },
  actor: { id: "U0123456789" },
  text: "hello",
  sentAt: "2025-11-17T17:20:00.000Z",
};

describe("inboundMessageSchema", () => {
  it("accepts a complete message", () => {
    expect(inboundMessageSchema.parse(valid)).toEqual(valid);
  });

  it("accepts empty text", () => {
    expect(inboundMessageSchema.safeParse({ ...valid, text: "" }).success).toBe(true);
  });

  it("rejects an unknown source", () => {
    expect(inboundMessageSchema.safeParse({ ...valid, source: "email" }).success).toBe(false);
  });

  it("rejects a missing thread id", () => {
    const { threadId: _omitted, ...conversation } = valid.conversation;
    expect(inboundMessageSchema.safeParse({ ...valid, conversation }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(inboundMessageSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });

  it("rejects a timestamp that is not ISO 8601", () => {
    expect(inboundMessageSchema.safeParse({ ...valid, sentAt: "yesterday" }).success).toBe(false);
  });
});
