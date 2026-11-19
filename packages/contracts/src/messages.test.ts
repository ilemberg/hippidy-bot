import { describe, expect, it } from "vitest";
import {
  inboundMessageSchema,
  MAX_CONTEXT_MESSAGES,
  MAX_CONTEXT_TEXT,
  type InboundMessage,
} from "./messages.ts";

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

describe("inboundMessageSchema context (decision 140)", () => {
  const said = {
    actorId: "U1",
    actorName: "Ana",
    text: "what about caching?",
    sentAt: "2025-11-17T17:19:00.000Z",
  };

  it("accepts a message with context, with or without a name", () => {
    const { actorName: _omitted, ...nameless } = said;
    const message = { ...valid, context: [said, nameless] };
    expect(inboundMessageSchema.parse(message)).toEqual(message);
  });

  it("accepts an empty context", () => {
    expect(inboundMessageSchema.safeParse({ ...valid, context: [] }).success).toBe(true);
  });

  it("accepts 50 entries and rejects 51", () => {
    const context = Array.from({ length: MAX_CONTEXT_MESSAGES }, () => said);
    expect(inboundMessageSchema.safeParse({ ...valid, context }).success).toBe(true);
    const tooMany = { ...valid, context: [...context, said] };
    expect(inboundMessageSchema.safeParse(tooMany).success).toBe(false);
  });

  it("caps each text at 4000 characters", () => {
    const at = { ...said, text: "x".repeat(MAX_CONTEXT_TEXT) };
    const over = { ...said, text: "x".repeat(MAX_CONTEXT_TEXT + 1) };
    expect(inboundMessageSchema.safeParse({ ...valid, context: [at] }).success).toBe(true);
    expect(inboundMessageSchema.safeParse({ ...valid, context: [over] }).success).toBe(false);
  });

  it("rejects an entry without an actor, a bad time or unknown fields", () => {
    const { actorId: _omitted, ...anonymous } = said;
    for (const entry of [anonymous, { ...said, sentAt: "today" }, { ...said, channel: "C1" }]) {
      expect(inboundMessageSchema.safeParse({ ...valid, context: [entry] }).success).toBe(false);
    }
  });
});
