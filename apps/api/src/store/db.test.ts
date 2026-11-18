import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimSyncLease,
  findOrCreateConversation,
  releaseSyncLease,
  renewSyncLease,
} from "./conversations.ts";
import { createPostgresDb, type Db } from "./db.ts";
import { applyMigrations } from "./testing.ts";

// The production client (postgres.js) over a real Postgres connection, served by PGlite.
let pg: PGlite;
let server: PGLiteSocketServer;
let db: Db;

beforeAll(async () => {
  pg = new PGlite();
  await applyMigrations(pg);
  server = new PGLiteSocketServer({ db: pg, port: 0, host: "127.0.0.1" });
  await server.start();
  db = createPostgresDb(`postgres://postgres@${server.getServerConn()}/postgres`);
  // Note: PGlite is single-threaded, so these tests check correctness, not concurrency.
});

afterAll(async () => {
  await server.stop();
  await pg.close();
});

describe("createPostgresDb", () => {
  it("runs parameterized queries", async () => {
    expect(await db.query("select $1::int + $2::int as sum", [2, 3])).toEqual([{ sum: 5 }]);
  });

  it("works with the store", async () => {
    const key = { source: "slack" as const, workspaceId: "T", channelId: "C", threadId: "1.1" };
    const conversation = await findOrCreateConversation(db, key);
    expect(conversation.key).toEqual(key);
    expect(conversation.waitingSince).toBeNull();
  });

  // A sync lease is known by its expiry, to the microsecond, so the expiry must come back from
  // this client and go into it again unchanged. PGlite's clock stops at milliseconds, so the
  // test sets an expiry that has microseconds.
  it("renews and releases a sync lease by its exact expiry", async () => {
    const key = { source: "slack" as const, workspaceId: "T", channelId: "C", threadId: "4.4" };
    const conversation = await findOrCreateConversation(db, key);
    const setExpiry = (until: string) =>
      db.query(`update conversations set sync_lease_until = $2::text::timestamptz where id = $1`, [
        conversation.id,
        until,
      ]);
    const until = "2999-01-01T00:00:00.123456Z";
    const lease = { conversationId: conversation.id, until };

    await setExpiry(until);
    const renewed = await renewSyncLease(db, lease);
    expect(renewed?.until).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);

    await setExpiry(until);
    expect(await releaseSyncLease(db, { ...lease, until: "2999-01-01T00:00:00.123Z" })).toBe(false);
    expect(await releaseSyncLease(db, lease)).toBe(true);

    // And the expiry a claim hands out is the one stored.
    const claimed = await claimSyncLease(db, conversation.id);
    expect(claimed !== undefined && (await releaseSyncLease(db, claimed))).toBe(true);
    expect(
      await db.query(`select sync_lease_until from conversations where id = $1`, [conversation.id]),
    ).toEqual([{ sync_lease_until: null }]);
  });

  it("commits a transaction, and rolls back when the work throws", async () => {
    await db.transaction((tx) => tx.query("create table t (n int)"));
    await db.transaction((tx) => tx.query("insert into t values (1)"));
    await expect(
      db.transaction(async (tx) => {
        await tx.query("insert into t values (2)");
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await db.query("select n from t")).toEqual([{ n: 1 }]);
  });
});
