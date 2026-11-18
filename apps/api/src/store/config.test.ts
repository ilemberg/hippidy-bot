import { describe, expect, it } from "vitest";
import { memoryLogger } from "../testing.ts";
import { readDbConfig } from "./config.ts";

describe("readDbConfig", () => {
  it("reads a postgres connection string", () => {
    const { log } = memoryLogger();
    const url = "postgresql://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
    expect(readDbConfig({ DATABASE_URL: url }, log)).toEqual({ url });
  });

  it("returns undefined when missing, and warns", () => {
    const { log, lines } = memoryLogger();
    expect(readDbConfig({}, log)).toBeUndefined();
    expect(lines[0]).toMatchObject({ msg: "config.database_url_missing" });
  });

  it("rejects something that is not a postgres URL, without logging it", () => {
    const { log, lines } = memoryLogger();
    expect(readDbConfig({ DATABASE_URL: "mysql://secret-pw@host" }, log)).toBeUndefined();
    expect(JSON.stringify(lines)).not.toContain("secret-pw");
  });
});
