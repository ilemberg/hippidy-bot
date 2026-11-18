import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Db } from "./db.ts";

const migrationsDir = join(import.meta.dirname, "../../../../supabase/migrations");

/** The repo's migrations, in the order Supabase applies them (by file name). */
export function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => join(migrationsDir, name));
}

function wrap(pg: Pick<PGlite, "query">, transaction: Db["transaction"]): Db {
  return {
    query: async (text, params = []) =>
      (await pg.query<Record<string, unknown>>(text, [...params])).rows,
    transaction,
  };
}

/**
 * What a fresh Supabase project has before any migration: its Data API roles, which are given
 * every new table in `public` by default. Recreated so tests see what the migrations must undo.
 */
const SUPABASE_BASELINE = `
  create role anon nologin;
  create role authenticated nologin;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
`;

/** Applies the Supabase baseline, then every migration in order. */
export async function applyMigrations(pg: Pick<PGlite, "exec">): Promise<void> {
  await pg.exec(SUPABASE_BASELINE);
  for (const file of migrationFiles()) {
    await pg.exec(readFileSync(file, "utf8"));
  }
}

/**
 * A fresh in-process Postgres (PGlite) with every migration applied from scratch, so tests run
 * without Docker (decision 62).
 */
export async function createTestDb(): Promise<Db & { close(): Promise<void> }> {
  const pg = new PGlite();
  await applyMigrations(pg);
  const db: Db = wrap(pg, (work) =>
    pg.transaction((tx) => work(wrap(tx, () => Promise.reject(new Error("nested transaction"))))),
  );
  return { ...db, close: () => pg.close() };
}
