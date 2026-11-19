import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../store/db.ts";
import { createTestDb } from "../store/testing.ts";
import { memoryLogger } from "../testing.ts";
import { readStatus } from "./status.ts";

const allConfigured = { agent: true, slack: true, github: true };

let db: Awaited<ReturnType<typeof createTestDb>>;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.close();
});

describe("readStatus", () => {
  it("is ok when the database answers and everything is configured", async () => {
    const { log } = memoryLogger();
    expect(await readStatus({ db, configured: allConfigured }, log)).toEqual({
      status: "ok",
      checks: { database: "ok", agent: "ok", slack: "ok", github: "ok" },
    });
  });

  it("is degraded when a part is not configured", async () => {
    const { log } = memoryLogger();
    const status = await readStatus(
      { db: undefined, configured: { agent: true, slack: false, github: true } },
      log,
    );
    expect(status.status).toBe("degraded");
    expect(status.checks).toEqual({
      database: "not_configured",
      agent: "ok",
      slack: "not_configured",
      github: "ok",
    });
  });

  it("reports the database down when a query fails, and logs why", async () => {
    const { log, lines } = memoryLogger();
    const failing: Db = {
      query: () => Promise.reject(new Error("connection refused")),
      transaction: () => Promise.reject(new Error("unused")),
    };
    const status = await readStatus({ db: failing, configured: allConfigured }, log);
    expect(status).toEqual({
      status: "degraded",
      checks: { database: "down", agent: "ok", slack: "ok", github: "ok" },
    });
    expect(lines).toContainEqual(expect.objectContaining({ msg: "status.database_down" }));
  });

  it("reports the database down when it does not answer in time", async () => {
    const { log } = memoryLogger();
    const stalled: Db = {
      query: () => new Promise(() => undefined),
      transaction: () => Promise.reject(new Error("unused")),
    };
    const status = await readStatus({ db: stalled, configured: allConfigured, timeoutMs: 10 }, log);
    expect(status.checks.database).toBe("down");
  });
});
