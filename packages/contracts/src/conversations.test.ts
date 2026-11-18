import { describe, expect, it } from "vitest";
import {
  listAgentEventsQuerySchema,
  listConversationsQuerySchema,
  transcriptLineSchema,
} from "./conversations.ts";

describe("listConversationsQuerySchema", () => {
  it("defaults the page size and reads numbers from the query string", () => {
    expect(listConversationsQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(listConversationsQuerySchema.parse({ limit: "50" })).toEqual({ limit: 50 });
  });

  it("keeps the page size within bounds", () => {
    for (const limit of ["0", "101", "1.5", "many"]) {
      expect(listConversationsQuerySchema.safeParse({ limit }).success, limit).toBe(false);
    }
  });

  it("takes a conversation id as the cursor, and nothing it does not know", () => {
    const before = "0b1f8f3e-6f0f-4c3a-9d55-3f3a7a2a9c11";
    expect(listConversationsQuerySchema.parse({ before })).toEqual({ limit: 20, before });
    // Any UUID the database holds, whatever its version bits say.
    const byHand = "00000000-0000-0000-0000-000000000001";
    expect(listConversationsQuerySchema.parse({ before: byHand }).before).toBe(byHand);
    expect(listConversationsQuerySchema.safeParse({ before: "yesterday" }).success).toBe(false);
    expect(listConversationsQuerySchema.safeParse({ page: "2" }).success).toBe(false);
  });
});

describe("listAgentEventsQuerySchema", () => {
  it("defaults the page size and reads the position to continue after", () => {
    expect(listAgentEventsQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(listAgentEventsQuerySchema.parse({ limit: "200", after: "42" })).toEqual({
      limit: 200,
      after: 42,
    });
  });

  it("rejects a page size or position out of range", () => {
    expect(listAgentEventsQuerySchema.safeParse({ limit: "201" }).success).toBe(false);
    expect(listAgentEventsQuerySchema.safeParse({ after: "-1" }).success).toBe(false);
  });
});

describe("transcriptLineSchema", () => {
  const at = "2026-11-18T00:00:01.000Z";

  it("accepts each kind of line", () => {
    const lines = [
      {
        role: "user",
        text: "hello",
        at,
        actor: { id: "U1", displayName: "Ilya" },
        messageId: "1.1",
        status: "answered",
      },
      { role: "agent", text: "hi", at, eventId: "sevt_1", delivery: "sent" },
      { role: "note", text: "Stopped.", at, delivery: null },
    ];
    for (const line of lines) expect(transcriptLineSchema.parse(line)).toEqual(line);
  });

  it("keeps each kind to its own fields", () => {
    expect(
      transcriptLineSchema.safeParse({ role: "note", text: "x", at, delivery: null, actor: {} })
        .success,
    ).toBe(false);
    expect(transcriptLineSchema.safeParse({ role: "agent", text: "x", at }).success).toBe(false);
  });
});
