import type { InboundMessage } from "@hippidy/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachSession,
  claimDelivery,
  conversationsToReconcile,
  findConversationBySession,
  findOrCreateConversation,
  finishDelivery,
  lockConversation,
  markWaiting,
  MAX_DELIVERY_ATTEMPTS,
  recordInbound,
  settleConversation,
  type ConversationKey,
} from "./conversations.ts";
import { createTestDb } from "./testing.ts";

const key: ConversationKey = {
  source: "slack",
  workspaceId: "T1",
  channelId: "C1",
  threadId: "100.000001",
};

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    source: "slack",
    sourceEventId: "Ev1",
    conversation: { ...key, messageId: "100.000001" },
    actor: { id: "U1" },
    text: "hello",
    sentAt: "2026-11-18T00:00:00.000Z",
    ...overrides,
  };
}

let db: Awaited<ReturnType<typeof createTestDb>>;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.close();
});

describe("conversations", () => {
  it("creates a conversation once per thread", async () => {
    const first = await findOrCreateConversation(db, key);
    const again = await findOrCreateConversation(db, key);
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({ status: "new", agentSessionId: null, waitingSince: null });

    const other = await findOrCreateConversation(db, { ...key, threadId: "200.000002" });
    expect(other.id).not.toBe(first.id);
  });

  it("creates one conversation when two requests race for a new thread", async () => {
    const [a, b] = await Promise.all([
      findOrCreateConversation(db, key),
      findOrCreateConversation(db, key),
    ]);
    expect(a.id).toBe(b.id);
  });

  it("attaches a session and finds the conversation by it", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await attachSession(db, conversation.id, {
      sessionId: "sesn_1",
      agentId: "agent_1",
      agentVersion: 3,
    });
    expect(await findConversationBySession(db, "sesn_1")).toMatchObject({
      id: conversation.id,
      agentId: "agent_1",
      agentVersion: 3,
    });
    expect(await findConversationBySession(db, "sesn_other")).toBeUndefined();
  });

  it("locks a conversation inside a transaction", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const locked = await db.transaction((tx) => lockConversation(tx, conversation.id));
    expect(locked.id).toBe(conversation.id);
  });
});

describe("inbound messages", () => {
  it("records a message once; a retry with the same event id is a duplicate", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const first = await recordInbound(db, conversation.id, message());
    const retry = await recordInbound(db, conversation.id, message());
    expect(first.duplicate).toBe(false);
    expect(retry).toEqual({ id: first.id, duplicate: true });
  });

  it("treats the same message under a different event id as a duplicate", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const first = await recordInbound(db, conversation.id, message());
    const sameMessage = await recordInbound(
      db,
      conversation.id,
      message({ sourceEventId: "Ev-other" }),
    );
    expect(sameMessage).toEqual({ id: first.id, duplicate: true });
  });
});

describe("waiting and settling", () => {
  it("keeps the first waiting time, then settles every pending message in order", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await recordInbound(db, conversation.id, message());
    await recordInbound(
      db,
      conversation.id,
      message({
        sourceEventId: "Ev2",
        conversation: { ...key, messageId: "100.000009" },
        sentAt: "2026-11-18T00:00:05.000Z",
      }),
    );

    await markWaiting(db, conversation.id);
    const firstWait = (await lockConversation(db, conversation.id)).waitingSince;
    await markWaiting(db, conversation.id);
    const waiting = await lockConversation(db, conversation.id);
    expect(waiting.status).toBe("waiting");
    expect(waiting.waitingSince).toEqual(firstWait);

    expect(await settleConversation(db, conversation.id, "answered")).toEqual([
      "100.000001",
      "100.000009",
    ]);
    const settled = await lockConversation(db, conversation.id);
    expect(settled).toMatchObject({ status: "answered", waitingSince: null });
    // Nothing left pending: settling again returns no messages.
    expect(await settleConversation(db, conversation.id, "answered")).toEqual([]);
  });
});

describe("deliveries", () => {
  it("lets exactly one caller claim a delivery", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const claims = await Promise.all([
      claimDelivery(db, conversation.id, "sevt_1", "reply"),
      claimDelivery(db, conversation.id, "sevt_1", "reply"),
    ]);
    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
  });

  it("never re-sends a delivery that went out", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const id = await claimDelivery(db, conversation.id, "sevt_1", "reply");
    await finishDelivery(db, id ?? "", { ok: true });
    expect(await claimDelivery(db, conversation.id, "sevt_1", "reply")).toBeUndefined();
  });

  it("allows a failed delivery to be claimed again, up to the attempt limit", async () => {
    const conversation = await findOrCreateConversation(db, key);
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
      const id = await claimDelivery(db, conversation.id, "sevt_1", "reply");
      expect(id).toBeDefined();
      await finishDelivery(db, id ?? "", { ok: false, error: "slack down" });
    }
    expect(await claimDelivery(db, conversation.id, "sevt_1", "reply")).toBeUndefined();
  });

  it("reclaims a delivery stuck in sending", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await claimDelivery(db, conversation.id, "sevt_1", "reply");
    expect(await claimDelivery(db, conversation.id, "sevt_1", "reply")).toBeUndefined();
    await db.query(`update deliveries set updated_at = now() - interval '3 minutes'`);
    expect(await claimDelivery(db, conversation.id, "sevt_1", "reply")).toBeDefined();
  });
});

describe("conversationsToReconcile", () => {
  it("finds conversations waiting too long and ones with failed deliveries", async () => {
    const waitingLong = await findOrCreateConversation(db, key);
    const waitingShort = await findOrCreateConversation(db, { ...key, threadId: "2" });
    const failedDelivery = await findOrCreateConversation(db, { ...key, threadId: "3" });
    await findOrCreateConversation(db, { ...key, threadId: "4" }); // idle, nothing to do

    await markWaiting(db, waitingLong.id);
    await db.query(
      `update conversations set waiting_since = now() - interval '5 minutes' where id = $1`,
      [waitingLong.id],
    );
    await markWaiting(db, waitingShort.id);
    const delivery = await claimDelivery(db, failedDelivery.id, "sevt_9", "reply");
    await finishDelivery(db, delivery ?? "", { ok: false, error: "boom" });

    const found = await conversationsToReconcile(db, { waitingForSeconds: 60, limit: 10 });
    expect(found.map((c) => c.id)).toEqual([waitingLong.id, failedDelivery.id]);
  });
});

describe("schema", () => {
  it("has row level security on every table", async () => {
    const rows = await db.query(
      `select relname, relrowsecurity from pg_class
       where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname`,
    );
    expect(rows).toEqual([
      { relname: "conversations", relrowsecurity: true },
      { relname: "deliveries", relrowsecurity: true },
      { relname: "inbound_messages", relrowsecurity: true },
    ]);
  });
});
