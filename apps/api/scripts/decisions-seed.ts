// Writes a migration that imports the entries of docs/planning/decisions.md not yet imported by
// an earlier seed migration (slice 2.2, decision 191). Run it after adding entries to the log:
//
//   pnpm decisions:seed
//
// A test fails while any entry of the log is in no seed migration.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./agent-files.ts";
import { parseLog, seededNumbers, seedMigration } from "./decisions-seed-lib.ts";

const migrations = join(repoRoot, "supabase/migrations");
const all = parseLog(readFileSync(join(repoRoot, "docs/planning/decisions.md"), "utf8"));
const seeded = new Set<number>();
for (const file of readdirSync(migrations).filter((name) => name.includes("_seed_decisions"))) {
  for (const number of seededNumbers(readFileSync(join(migrations, file), "utf8"))) {
    seeded.add(number);
  }
}
const missing = all.filter((entry) => !seeded.has(entry.number));
if (missing.length === 0) {
  console.log("Every entry of the log is already seeded.");
} else {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const file = join(migrations, `${stamp}_seed_decisions.sql`);
  writeFileSync(file, seedMigration(missing, all));
  console.log(`Wrote ${file}: ${String(missing.length)} entries.`);
}
