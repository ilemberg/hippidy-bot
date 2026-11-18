import postgres from "postgres";

/** One row as a plain object, before it is checked against a schema. */
export type Row = Record<string, unknown>;

/**
 * The little the store needs from Postgres: parameterized queries ($1, $2, ...) and one level
 * of transactions. Production uses postgres.js against Supabase; tests use PGlite.
 */
export interface Db {
  query(text: string, params?: readonly unknown[]): Promise<Row[]>;
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T>;
}

type Runner = postgres.Sql | postgres.TransactionSql;

async function run(runner: Runner, text: string, params: readonly unknown[]): Promise<Row[]> {
  const rows = await runner.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
  return rows;
}

/**
 * Connects to Supabase through its transaction pooler, which does not support prepared
 * statements, so they are off. Connections open lazily on the first query.
 */
export function createPostgresDb(url: string): Db {
  const sql = postgres(url, { prepare: false, max: 5, idle_timeout: 20, connect_timeout: 10 });

  const inTransaction = (tx: postgres.TransactionSql): Db => ({
    query: (text, params = []) => run(tx, text, params),
    transaction: () => Promise.reject(new Error("nested transactions are not supported")),
  });

  return {
    query: (text, params = []) => run(sql, text, params),
    transaction: async <T>(work: (tx: Db) => Promise<T>): Promise<T> =>
      await sql.begin((tx) => work(inTransaction(tx))),
  };
}
