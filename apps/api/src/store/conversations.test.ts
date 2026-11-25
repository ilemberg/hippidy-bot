import type { InboundMessage, OutboundDelivery } from "@hippidy/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachSession,
  claimSessionStart,
  claimSyncLease,
  conversationsToReconcile,
  databaseNow,
  enqueueDelivery,
  findConversationBySession,
  findOrCreateConversation,
  getConversation,
  lockConversation,
  markDeliveryFailed,
  markDeliverySent,
  markForwarded,
  markWaiting,
  MAX_DELIVERY_ATTEMPTS,
  pendingForwards,
  recordForwardFailure,
  recordInbound,
  releaseSessionStart,
  releaseSyncLease,
  renewSyncLease,
  sessionIdOf,
  setAgentEventCursor,
  setSessionState,
  settleMessages,
  unsentDeliveries,
  type ConversationKey,
} from "./conversations.ts";
import { createTestDb } from "./testing.ts";

// PGlite runs on one connection, so these tests check behaviour, not true concurrency. The
// race-safety comes from the unique keys, `on conflict` clauses and leases they exercise.

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

function reply(text: string): OutboundDelivery {
  return { kind: "reply", target: key, text };
}

let db: Awaited<ReturnType<typeof createTestDb>>;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.close();
});

/** Records a message and hands it to the agent under `agentEventId`. */
async function receive(conversationId: string, n: number, agentEventId?: string) {
  const { id } = await recordInbound(db, conversationId, message(n));
  await markForwarded(db, id, agentEventId);
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
      sessionState: "active",
      agentSessionId: null,
      waitingSince: null,
      agentEventCursor: null,
    });
    const other = await findOrCreateConversation(db, { ...key, threadId: "200.000002" });
    expect(other.id).not.toBe(first.id);
  });

  it("stores the agent event cursor and the session state", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await setAgentEventCursor(db, conversation.id, "sevt_9");
    await setSessionState(db, conversation.id, "budget_reached");
    expect(await getConversation(db, conversation.id)).toMatchObject({
      agentEventCursor: "sevt_9",
      sessionState: "budget_reached",
    });
  });

  it("locks a conversation inside a transaction", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const locked = await db.transaction((tx) => lockConversation(tx, conversation.id));
    expect(locked.id).toBe(conversation.id);
  });
});

describe("sync lease", () => {
  it("lets one sync hold a conversation until it releases it", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const lease = await claimSyncLease(db, conversation.id);
    expect(lease).toBeDefined();
    expect(await claimSyncLease(db, conversation.id)).toBeUndefined();
    if (lease !== undefined) await releaseSyncLease(db, lease);
    expect(await claimSyncLease(db, conversation.id)).toBeDefined();
  });

  it("can be taken over once it has expired", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await claimSyncLease(db, conversation.id);
    await db.query(`update conversations set sync_lease_until = now() - interval '1 second'`);
    expect(await claimSyncLease(db, conversation.id)).toBeDefined();
  });

  it("cannot be released or renewed by a sync that lost it", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const slow = await claimSyncLease(db, conversation.id);
    if (slow === undefined) throw new Error("expected a lease");
    await db.query(`update conversations set sync_lease_until = now() - interval '1 second'`);
    expect(await renewSyncLease(db, slow)).toBe(false);
    const next = await claimSyncLease(db, conversation.id);
    if (next === undefined) throw new Error("expected a lease");
    expect(next.owner).not.toBe(slow.owner);

    await releaseSyncLease(db, slow);
    expect(await claimSyncLease(db, conversation.id)).toBeUndefined();
    expect(await renewSyncLease(db, slow)).toBe(false);
    expect(await renewSyncLease(db, next)).toBe(true);
    await releaseSyncLease(db, next);
    expect(await claimSyncLease(db, conversation.id)).toBeDefined();
  });
});

describe("session starts", () => {
  it("lets one caller claim the start; the claim is not a session", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const claim = await claimSessionStart(db, conversation.id);
    expect(claim).toMatch(/^starting:/);
    expect(await claimSessionStart(db, conversation.id)).toBeUndefined();
    expect(sessionIdOf(await getConversation(db, conversation.id))).toBeUndefined();

    const session = { sessionId: "sesn_1", agentId: "agent_1", agentVersion: 1 };
    expect(await attachSession(db, conversation.id, claim ?? "", session)).toBe(true);
    expect(sessionIdOf(await getConversation(db, conversation.id))).toBe("sesn_1");
    expect(await findConversationBySession(db, "sesn_1")).toMatchObject({
      id: conversation.id,
      agentVersion: 1,
    });
  });

  it("refuses to attach a session when the claim was taken over", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const slow = await claimSessionStart(db, conversation.id);
    await db.query(`update conversations set updated_at = now() - interval '4 minutes'`);
    const takeover = await claimSessionStart(db, conversation.id);
    expect(takeover).toBeDefined();

    const session = (id: string) => ({ sessionId: id, agentId: "a", agentVersion: 1 });
    expect(await attachSession(db, conversation.id, takeover ?? "", session("sesn_new"))).toBe(
      true,
    );
    expect(await attachSession(db, conversation.id, slow ?? "", session("sesn_old"))).toBe(false);
    expect((await getConversation(db, conversation.id)).agentSessionId).toBe("sesn_new");
  });

  it("releases only its own claim", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const claim = await claimSessionStart(db, conversation.id);
    await releaseSessionStart(db, conversation.id, "starting:someone-else");
    expect(await claimSessionStart(db, conversation.id)).toBeUndefined();
    await releaseSessionStart(db, conversation.id, claim ?? "");
    expect(await claimSessionStart(db, conversation.id)).toBeDefined();
  });
});

describe("inbound messages", () => {
  it("records a message once; a retry is a duplicate that says whether it was forwarded", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const first = await recordInbound(db, conversation.id, message(1));
    expect(first.duplicate).toBe(false);
    expect(await recordInbound(db, conversation.id, message(1))).toEqual({
      id: first.id,
      duplicate: true,
      forwarded: false,
    });
    await markForwarded(db, first.id, "sevt_1");
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

  it("lists messages never handed over, older than a threshold, and counts failed tries", async () => {
    const conversation = await findOrCreateConversation(db, key);
    const old = await recordInbound(db, conversation.id, message(1));
    const forwarded = await recordInbound(db, conversation.id, message(2));
    await markForwarded(db, forwarded.id, "sevt_2");
    await db.query(`update inbound_messages set created_at = now() - interval '2 minutes'`);
    await recordInbound(db, conversation.id, message(3)); // too recent

    expect(await pendingForwards(db, conversation.id, 30)).toEqual([
      { id: old.id, actorId: "U1", text: "message 1" },
    ]);
    expect(await recordForwardFailure(db, old.id)).toBe(1);
    expect(await recordForwardFailure(db, old.id)).toBe(2);
  });
});

describe("settleMessages", () => {
  it("settles the messages whose agent events are given, and keeps waiting for the rest", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await receive(conversation.id, 1, "sevt_1");
    await receive(conversation.id, 2, "sevt_2");

    expect(
      await settleMessages(db, conversation.id, "answered", {
        kind: "agent_events",
        ids: ["sevt_1"],
      }),
    ).toEqual(["100.000001"]);
    const partly = await getConversation(db, conversation.id);
    expect(partly.status).toBe("waiting");
    expect(partly.waitingSince).not.toBeNull();

    expect(
      await settleMessages(db, conversation.id, "answered", {
        kind: "agent_events",
        ids: ["sevt_2"],
      }),
    ).toEqual(["100.000002"]);
    expect(await getConversation(db, conversation.id)).toMatchObject({
      status: "answered",
      waitingSince: null,
    });
  });

  it("restarts the waiting clock from the oldest message still pending", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await receive(conversation.id, 1, "sevt_1");
    await db.query(`update conversations set waiting_since = now() - interval '29 minutes'`);
    await receive(conversation.id, 2, "sevt_2");
    await settleMessages(db, conversation.id, "answered", {
      kind: "agent_events",
      ids: ["sevt_1"],
    });
    const waitingSince = (await getConversation(db, conversation.id)).waitingSince;
    const now = await databaseNow(db);
    expect(now.getTime() - (waitingSince?.getTime() ?? 0)).toBeLessThan(60_000);
  });

  it("settles messages without an event id only if handed over before the cutoff", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await receive(conversation.id, 1);
    const cutoff = await databaseNow(db);
    await db.query(`select pg_sleep(0.01)`);
    await receive(conversation.id, 2);
    expect(
      await settleMessages(db, conversation.id, "answered", {
        kind: "forwarded_without_event",
        cutoff,
      }),
    ).toEqual(["100.000001"]);
  });

  it("settles every forwarded message, or specific inbound messages", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await receive(conversation.id, 1, "sevt_1");
    const notForwarded = await recordInbound(db, conversation.id, message(2));
    expect(await settleMessages(db, conversation.id, "failed", { kind: "all_forwarded" })).toEqual([
      "100.000001",
    ]);
    expect(
      await settleMessages(db, conversation.id, "failed", {
        kind: "inbound",
        ids: [notForwarded.id],
      }),
    ).toEqual(["100.000002"]);
  });

  it("does not turn a stopped conversation into an answered one", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await receive(conversation.id, 1, "sevt_1");
    await receive(conversation.id, 2, "sevt_2");
    await settleMessages(db, conversation.id, "stopped", {
      kind: "agent_events",
      ids: ["sevt_1", "sevt_2"],
    });
    await settleMessages(db, conversation.id, "answered", {
      kind: "agent_events",
      ids: ["sevt_1"],
    });
    expect((await getConversation(db, conversation.id)).status).toBe("stopped");
  });
});

describe("deliveries", () => {
  it("queues a delivery once per key, and lists unsent ones in order", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await enqueueDelivery(db, conversation.id, "sevt_1", "reply", reply("one"));
    await enqueueDelivery(db, conversation.id, "sevt_2", "reply", reply("two"));
    await enqueueDelivery(db, conversation.id, "sevt_1", "reply", reply("one again"));

    const unsent = await unsentDeliveries(db, conversation.id);
    expect(unsent.map((d) => [d.key, d.payload])).toEqual([
      ["sevt_1", reply("one")],
      ["sevt_2", reply("two")],
    ]);

    await markDeliverySent(db, unsent[0]?.id ?? "");
    expect((await unsentDeliveries(db, conversation.id)).map((d) => d.key)).toEqual(["sevt_2"]);
  });

  it("keeps a failed delivery for retry, and abandons it after the attempt limit", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await enqueueDelivery(db, conversation.id, "sevt_1", "reply", reply("one"));
    const [delivery] = await unsentDeliveries(db, conversation.id);
    const id = delivery?.id ?? "";
    for (let attempt = 1; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
      expect(await markDeliveryFailed(db, id, "slack down")).toBe(false);
      expect(await unsentDeliveries(db, conversation.id)).toHaveLength(1);
    }
    expect(await markDeliveryFailed(db, id, "slack down")).toBe(true);
    expect(await unsentDeliveries(db, conversation.id)).toEqual([]);
  });
});

describe("conversationsToReconcile", () => {
  it("finds conversations waiting too long, with stuck messages, or with deliveries to send", async () => {
    const waitingLong = await findOrCreateConversation(db, key);
    const waitingShort = await findOrCreateConversation(db, { ...key, threadId: "2" });
    const stuckMessage = await findOrCreateConversation(db, { ...key, threadId: "3" });
    const queued = await findOrCreateConversation(db, { ...key, threadId: "4" });
    const syncing = await findOrCreateConversation(db, { ...key, threadId: "5" });
    await findOrCreateConversation(db, { ...key, threadId: "6" }); // nothing to do

    await markWaiting(db, waitingLong.id);
    await markWaiting(db, syncing.id);
    await db.query(
      `update conversations set waiting_since = now() - interval '5 minutes'
       where id = any($1::uuid[])`,
      [[waitingLong.id, syncing.id]],
    );
    await claimSyncLease(db, syncing.id);
    await markWaiting(db, waitingShort.id);
    await recordInbound(
      db,
      stuckMessage.id,
      message(1, { conversation: { ...key, threadId: "3", messageId: "9.9" } }),
    );
    await db.query(`update inbound_messages set created_at = now() - interval '2 minutes'`);
    await enqueueDelivery(db, queued.id, "sevt_1", "reply", reply("one"));

    const found = await conversationsToReconcile(db, { waitingForSeconds: 60, limit: 10 });
    expect(found.map((c) => c.id).sort()).toEqual(
      [waitingLong.id, stuckMessage.id, queued.id].sort(),
    );
  });

  it("does not come back for a delivery that was abandoned", async () => {
    const conversation = await findOrCreateConversation(db, key);
    await enqueueDelivery(db, conversation.id, "sevt_1", "reply", reply("one"));
    const [delivery] = await unsentDeliveries(db, conversation.id);
    for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
      await markDeliveryFailed(db, delivery?.id ?? "", "down");
    }
    expect(await conversationsToReconcile(db, { waitingForSeconds: 60, limit: 10 })).toEqual([]);
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
    expect((await getConversation(db, conversation.id)).status).toBe("new");
  });
});

describe("schema", () => {
  const tables = [
    "actor_roles",
    "agent_events",
    "approvals",
    "change_briefs",
    "changes",
    "conversations",
    "deliveries",
    "inbound_messages",
    "projects",
  ];

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
