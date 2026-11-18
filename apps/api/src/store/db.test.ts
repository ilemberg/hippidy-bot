import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findOrCreateConversation } from "./conversations.ts";
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
