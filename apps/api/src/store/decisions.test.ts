import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./testing.ts";

// Slice 2.2, parts A and B: the decisions table and its seed from the log (decisions 190, 191).

let db: Awaited<ReturnType<typeof createTestDb>>;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.close();
});

describe("the seed", () => {
  it("holds every entry of the log, active unless a later one replaced it", async () => {
    const rows = await db.query(
      `select status, count(*)::int as n from decisions where origin = 'import' group by status
       order by status`,
    );
    expect(rows).toContainEqual({ status: "superseded", n: 5 });
    const [one] = await db.query(
      `select statement, status, decided_by_name, decided_at::date::text as day
       from decisions where origin = 'import' and origin_ref = '173'`,
    );
    expect(one).toMatchObject({
      status: "active",
      decided_by_name: "the owner",
      day: "2026-11-25",
    });
    expect(String(one?.statement)).toMatch(/^Replaces 136 and 137/);
  });

  it("finds decisions by words, through the full-text index", async () => {
    const rows = await db.query(
      `select origin_ref from decisions
       where search @@ websearch_to_tsquery('english', 'person merges')
       limit 5`,
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("decisions", () => {
  function insert(values: Record<string, unknown>) {
    const columns = Object.keys(values);
    return db.query(
      `insert into decisions (${columns.join(", ")})
       values (${columns.map((_, i) => `$${String(i + 1)}`).join(", ")}) returning id, number`,
      Object.values(values),
    );
  }
  const base = {
    statement: "Use Postgres full-text search, not a vector store.",
    status: "active",
    decided_by_source: "slack",
    decided_by_workspace_id: "T1",
    decided_by_actor_id: "U1",
    decided_at: "2026-11-25T12:00:00Z",
    origin: "thread",
  };

  it("numbers an import as in the log, and thread decisions from 1000 in order", async () => {
    expect(
      await db.query(`select number::int as n from decisions where origin_ref = '173'`),
    ).toEqual([{ n: 173 }]);
    const [a] = await insert(base);
    const [b] = await insert(base);
    expect(Number(a?.number)).toBe(1000);
    expect(Number(b?.number)).toBe(1001);
  });

  it("needs a known status and origin, someone who decided, and a reference for an import", async () => {
    await expect(insert({ ...base, status: "maybe" })).rejects.toThrow();
    await expect(insert({ ...base, origin: "email" })).rejects.toThrow();
    await expect(insert({ ...base, decided_by_actor_id: null })).rejects.toThrow();
    await expect(insert({ ...base, origin: "import" })).rejects.toThrow();
    await expect(insert({ ...base, statement: "" })).rejects.toThrow();
  });

  it("records a confirmation only with its time, and each tool call once", async () => {
    await expect(insert({ ...base, confirmed_by_actor_id: "U2" })).rejects.toThrow();
    await insert({ ...base, custom_tool_use_id: "sevt_1" });
    await expect(insert({ ...base, custom_tool_use_id: "sevt_1" })).rejects.toThrow();
  });
});
