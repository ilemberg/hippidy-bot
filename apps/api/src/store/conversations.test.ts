import type { InboundMessage } from "@hippidy/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachSession,
  claimSessionStart,
  getConversation,
  pendingForwards,
  releaseSessionStart,
  claimDelivery,
  conversationsToReconcile,
  databaseNow,
  findConversationBySession,
  findOrCreateConversation,
  finishDelivery,
  lockConversation,
  markForwarded,
  markWaiting,
  MAX_DELIVERY_ATTEMPTS,
  recordInbound,
  sessionIdOf,
  setAgentEventCursor,
  settleConversation,
  type ConversationKey,
} from "./conversations.ts";
import { createTestDb } from "./testing.ts";

// PGlite runs on one connection, so these tests check behaviour, not true concurrency. The
// race-safety comes from the unique keys and `on conflict` clauses they exercise.

const key: ConversationKey = {
  source: "slack",
  workspaceId: "T1",
  channelId: "C1",
  threadId: "100.000001",
};

function message(n: number, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    source: "slack",
    sourceEventId: `Ev${n}`,
    conversation: { ...key, messageId: `100.00000${n}` },
    actor: { id: "U1" },
    text: `message ${n}`,
    sentAt: `2026-11-18T00:00:0${n}.000Z`,
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

/** Records, forwards and marks waiting, as the API will for each message. */
async function receive(conversationId: string, n: number): Promise<string> {
  const { id } = await recordInbound(db, conversationId, message(n));
  await markForwarded(db, id);
  await markWaiting(db, conversationId);
  return id;
}

describe("conversations", () => {
  it("returns the same conversation for the same thread", async () => {
    const first = await findOrCreateConversation(db, key);
    const again = await findOrCreateConversation(db, key);
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({
      status: "new",
      agentSessionId: null,
      waitingSince: null,
      agentEventCursor: null,
    });
    const other = await findOrCreateConversation(db, { ...key, threadId: "200.000002" });
    expect(other.id).not.toBe(first.id);
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

  it("stores the agent event cursor", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await setAgentEventCursor(db, conversation.id, "sevt_9");
    expect((await lockConversation(db, conversation.id)).agentEventCursor).toBe("sevt_9");
  });
});

describe("session starts", () => {
  it("lets one caller claim the start; the claim is not a session", async () => {
    const conversation = await findOrCreateConversation(db, key);
    expect(await claimSessionStart(db, conversation.id)).toBe(true);
    expect(await claimSessionStart(db, conversation.id)).toBe(false);
    expect(sessionIdOf(await getConversation(db, conversation.id))).toBeUndefined();

    await attachSession(db, conversation.id, {
      sessionId: "sesn_1",
      agentId: "agent_1",
      agentVersion: 1,
    });
    const started = await getConversation(db, conversation.id);
    expect(sessionIdOf(started)).toBe("sesn_1");
    expect(await claimSessionStart(db, conversation.id)).toBe(false);
  });

  it("can be released, or taken over when it went silent", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await claimSessionStart(db, conversation.id);
    await releaseSessionStart(db, conversation.id);
    expect(await claimSessionStart(db, conversation.id)).toBe(true);

    await db.query(`update conversations set updated_at = now() - interval '2 minutes'`);
    expect(await claimSessionStart(db, conversation.id)).toBe(true);
  });

  it("never releases a real session", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await attachSession(db, conversation.id, {
      sessionId: "sesn_1",
      agentId: "agent_1",
      agentVersion: 1,
    });
    await releaseSessionStart(db, conversation.id);
    expect((await getConversation(db, conversation.id)).agentSessionId).toBe("sesn_1");
  });
});

describe("pending forwards", () => {
  it("lists messages never handed to the agent, older than a threshold, oldest first", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const old = await recordInbound(db, conversation.id, message(1));
    const forwarded = await recordInbound(db, conversation.id, message(2));
    await markForwarded(db, forwarded.id);
    await db.query(`update inbound_messages set created_at = now() - interval '2 minutes'`);
    await recordInbound(db, conversation.id, message(3)); // too recent

    expect(await pendingForwards(db, conversation.id, 30)).toEqual([
      { id: old.id, actorId: "U1", text: "message 1" },
    ]);
    const found = await conversationsToReconcile(db, { waitingForSeconds: 30, limit: 10 });
    expect(found.map((c) => c.id)).toEqual([conversation.id]);
  });
});

describe("inbound messages", () => {
  it("records a message once; a retry with the same event id is a duplicate", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const first = await recordInbound(db, conversation.id, message(1));
    const retry = await recordInbound(db, conversation.id, message(1));
    expect(first.duplicate).toBe(false);
    expect(retry).toEqual({ id: first.id, duplicate: true, forwarded: false });
    await markForwarded(db, first.id);
    expect(await recordInbound(db, conversation.id, message(1))).toEqual({
      id: first.id,
      duplicate: true,
      forwarded: true,
    });
  });

  it("treats the same message under a different event id as a duplicate", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const first = await recordInbound(db, conversation.id, message(1));
    const sameMessage = await recordInbound(
      db,
      conversation.id,
      message(1, { sourceEventId: "Ev-other" }),
    );
    expect(sameMessage).toEqual({ id: first.id, duplicate: true, forwarded: false });
  });

  it("finds the earlier record when the event id and the message match different rows", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const a = await recordInbound(db, conversation.id, message(1));
    const b = await recordInbound(db, conversation.id, message(2));
    // Event id of message 2, message identity of message 1: both keys clash.
    const clash = await recordInbound(db, conversation.id, message(1, { sourceEventId: "Ev2" }));
    expect(clash.duplicate).toBe(true);
    expect([a.id, b.id]).toContain(clash.id);
  });
});

describe("waiting and settling", () => {
  it("keeps the first waiting time", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await markWaiting(db, conversation.id);
    const firstWait = (await lockConversation(db, conversation.id)).waitingSince;
    await markWaiting(db, conversation.id);
    const waiting = await lockConversation(db, conversation.id);
    expect(waiting.status).toBe("waiting");
    expect(waiting.waitingSince).toEqual(firstWait);
  });

  it("settles every message forwarded before the cutoff, oldest first", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await receive(conversation.id, 2);
    await receive(conversation.id, 1);
    const cutoff = await databaseNow(db);

    expect(
      await settleConversation(db, conversation.id, "answered", { forwardedBefore: cutoff }),
    ).toEqual(["100.000001", "100.000002"]);
    expect(await lockConversation(db, conversation.id)).toMatchObject({
      status: "answered",
      waitingSince: null,
    });
    expect(
      await settleConversation(db, conversation.id, "answered", { forwardedBefore: cutoff }),
    ).toEqual([]);
  });

  it("leaves a message handed over after the cutoff pending, and keeps waiting for it", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await receive(conversation.id, 1);
    const cutoff = await databaseNow(db);
    await db.query(`select pg_sleep(0.01)`);
    await receive(conversation.id, 2);

    expect(
      await settleConversation(db, conversation.id, "answered", { forwardedBefore: cutoff }),
    ).toEqual(["100.000001"]);
    const after = await lockConversation(db, conversation.id);
    expect(after.status).toBe("waiting");
    expect(after.waitingSince).not.toBeNull();
  });

  it("never settles a message that was recorded but not handed to the agent", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await recordInbound(db, conversation.id, message(1));
    await markWaiting(db, conversation.id);
    const cutoff = await databaseNow(db);
    expect(
      await settleConversation(db, conversation.id, "answered", { forwardedBefore: cutoff }),
    ).toEqual([]);
    expect((await lockConversation(db, conversation.id)).status).toBe("waiting");
  });

  it("does not turn a stopped conversation into an answered one", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await receive(conversation.id, 1);
    const cutoff = await databaseNow(db);
    await settleConversation(db, conversation.id, "stopped", { forwardedBefore: cutoff });
    await settleConversation(db, conversation.id, "answered", { forwardedBefore: cutoff });
    expect((await lockConversation(db, conversation.id)).status).toBe("stopped");
  });
});

describe("deliveries", () => {
  it("lets only the first caller claim a delivery", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const first = await claimDelivery(db, conversation.id, "sevt_1", "reply");
    const second = await claimDelivery(db, conversation.id, "sevt_1", "reply");
    expect(first).toEqual({ id: expect.any(String) as string, attempt: 1 });
    expect(second).toBeUndefined();
  });

  it("never re-sends a delivery that went out", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const claim = await claimDelivery(db, conversation.id, "sevt_1", "reply");
    if (claim === undefined) throw new Error("no claim");
    await finishDelivery(db, claim);
    expect(await claimDelivery(db, conversation.id, "sevt_1", "reply")).toBeUndefined();
  });

  it("allows a failed delivery to be claimed again, up to the attempt limit", async () => {
    const conversation = await findOrCreateConversation(db, key);
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
      const claim = await claimDelivery(db, conversation.id, "sevt_1", "reply");
      expect(claim?.attempt).toBe(attempt);
      if (claim === undefined) throw new Error("no claim");
      await finishDelivery(db, claim, "slack down");
    }
    expect(await claimDelivery(db, conversation.id, "sevt_1", "reply")).toBeUndefined();
  });

  it("reclaims a delivery stuck in sending, and the slow attempt cannot overwrite the result", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const slow = await claimDelivery(db, conversation.id, "sevt_1", "reply");
    expect(await claimDelivery(db, conversation.id, "sevt_1", "reply")).toBeUndefined();
    await db.query(`update deliveries set updated_at = now() - interval '3 minutes'`);
    const takeover = await claimDelivery(db, conversation.id, "sevt_1", "reply");
    if (slow === undefined || takeover === undefined) throw new Error("no claim");

    await finishDelivery(db, takeover);
    await finishDelivery(db, slow, "timed out long ago");

    expect(await db.query(`select status, attempts from deliveries`)).toEqual([
      { status: "sent", attempts: 2 },
    ]);
  });
});

describe("conversationsToReconcile", () => {
  it("finds conversations waiting too long, and ones with failed or stuck deliveries", async () => {
    const waitingLong = await findOrCreateConversation(db, key);
    const waitingShort = await findOrCreateConversation(db, { ...key, threadId: "2" });
    const failedDelivery = await findOrCreateConversation(db, { ...key, threadId: "3" });
    const stuckDelivery = await findOrCreateConversation(db, { ...key, threadId: "4" });
    await findOrCreateConversation(db, { ...key, threadId: "5" }); // nothing to do

    await markWaiting(db, waitingLong.id);
    await db.query(
      `update conversations set waiting_since = now() - interval '5 minutes' where id = $1`,
      [waitingLong.id],
    );
    await markWaiting(db, waitingShort.id);
    const failed = await claimDelivery(db, failedDelivery.id, "sevt_9", "reply");
    if (failed === undefined) throw new Error("no claim");
    await finishDelivery(db, failed, "boom");
    await claimDelivery(db, stuckDelivery.id, "sevt_8", "reply");
    await db.query(
      `update deliveries set updated_at = now() - interval '3 minutes'
       where conversation_id = $1`,
      [stuckDelivery.id],
    );

    const found = await conversationsToReconcile(db, { waitingForSeconds: 60, limit: 10 });
    expect(found.map((c) => c.id).sort()).toEqual(
      [waitingLong.id, failedDelivery.id, stuckDelivery.id].sort(),
    );
    expect(found[0]?.id).toBe(waitingLong.id);
  });
});

describe("transactions", () => {
  it("rolls back when the work throws", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await expect(
      db.transaction(async (tx) => {
        await tx.query(`update conversations set status = 'failed' where id = $1`, [
          conversation.id,
        ]);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect((await lockConversation(db, conversation.id)).status).toBe("new");
  });
});

describe("schema", () => {
  const tables = ["conversations", "deliveries", "inbound_messages"];

  it("has row level security on every table", async () => {
    const rows = await db.query(
      `select relname, relrowsecurity from pg_class
       where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname`,
    );
    expect(rows).toEqual(tables.map((relname) => ({ relname, relrowsecurity: true })));
  });

  it("gives Supabase's Data API roles no privileges on any table", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const table of tables) {
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
          const rows = await db.query(`select has_table_privilege($1, $2, $3) as allowed`, [
            role,
            `public.${table}`,
            privilege,
          ]);
          expect(rows, `${role} ${privilege} ${table}`).toEqual([{ allowed: false }]);
        }
      }
    }
  });

  it("also keeps those roles off tables created by later migrations", async () => {
    await db.query(`create table public.later (id int)`);
    const rows = await db.query(
      `select has_table_privilege('anon', 'public.later', 'SELECT') as allowed`,
    );
    expect(rows).toEqual([{ allowed: false }]);
  });
});
