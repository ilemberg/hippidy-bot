import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./agent-files.ts";
import { parseLog, replacedBy, seededNumbers, seedMigration } from "./decisions-seed-lib.ts";

const log = [
  "| # | Date | Decision | Reason |",
  "|---|---|---|---|",
  "| 1 | 2026-11-17 | Use TypeScript | Stated up front |",
  `| 2 | 2026-11-17 | It's "one door" | O'Brien said so |`,
  "| 3 | 2026-11-18 | Replaces 1 and 2: use Rust | Faster |",
  "",
  "## Deferred on purpose",
  "",
  "| Topic | Revisit |",
  "|---|---|",
  "| Evals | Later |",
].join("\n");

describe("parseLog", () => {
  it("reads the entries of the log's table and nothing else", () => {
    expect(parseLog(log)).toEqual([
      { number: 1, date: "2026-11-17", decision: "Use TypeScript", reason: "Stated up front" },
      { number: 2, date: "2026-11-17", decision: `It's "one door"`, reason: "O'Brien said so" },
      { number: 3, date: "2026-11-18", decision: "Replaces 1 and 2: use Rust", reason: "Faster" },
    ]);
  });
});

describe("replacedBy", () => {
  it("finds the entries a later one replaces, in lists too", () => {
    expect(replacedBy(parseLog(log))).toEqual(
      new Map([
        [1, 3],
        [2, 3],
      ]),
    );
    expect(
      replacedBy([
        { number: 9, date: "", decision: "Replaces 139 and 153, the rights", reason: "" },
      ]),
    ).toEqual(
      new Map([
        [139, 9],
        [153, 9],
      ]),
    );
  });
});

describe("seedMigration", () => {
  it("quotes text, marks replaced entries superseded, and imports each once", () => {
    const entries = parseLog(log);
    const sql = seedMigration(entries.slice(1), entries);
    expect(sql).toContain(
      `('It''s "one door"', 'O''Brien said so', 'superseded', 'the owner', '2026-11-17T00:00:00Z', 'import', '2')`,
    );
    expect(sql).toContain(`'active', 'the owner', '2026-11-18T00:00:00Z', 'import', '3')`);
    expect(sql).toContain(
      "on conflict (origin, origin_ref) where origin_ref is not null do nothing;",
    );
    expect(seededNumbers(sql)).toEqual(new Set([2, 3]));
  });
});

describe("the seed of the repository's log (decision 191)", () => {
  it("imports every entry of decisions.md in some seed migration: run `pnpm decisions:seed`", () => {
    const entries = parseLog(readFileSync(join(repoRoot, "docs/planning/decisions.md"), "utf8"));
    const migrations = join(repoRoot, "supabase/migrations");
    const seeded = new Set<number>();
    for (const file of readdirSync(migrations).filter((name) => name.includes("_seed_decisions"))) {
      for (const n of seededNumbers(readFileSync(join(migrations, file), "utf8"))) seeded.add(n);
    }
    expect(entries.length).toBeGreaterThan(180);
    expect(entries.filter((entry) => !seeded.has(entry.number)).map((e) => e.number)).toEqual([]);
  });
});
