import { describe, expect, it } from "vitest";
import { globMatches } from "./glob.ts";

// The areas' path matcher (slice 3.1, from its review).

describe("globMatches", () => {
  it("matches a path, or anything under it, like a CODEOWNERS line", () => {
    expect(globMatches("apps/web/src/x.ts", "apps/web")).toBe(true);
    expect(globMatches("apps/web/src/x.ts", "apps/web/")).toBe(true);
    expect(globMatches("apps/web/src/x.ts", "./apps/web")).toBe(true);
    expect(globMatches("apps/webby/x.ts", "apps/web")).toBe(false);
    expect(globMatches("apps/api/src/store/decisions.ts", "apps/api/src/store/decisions.ts")).toBe(
      true,
    );
  });

  it("reads * within a segment, ** across segments, and ? as one character", () => {
    expect(globMatches("apps/api/src/slack/deliver.ts", "apps/api/src/slack/**")).toBe(true);
    expect(globMatches("apps/api/src/slack/deliver.ts", "apps/*/src/slack/*.ts")).toBe(true);
    expect(globMatches("apps/api/src/slack/x/deliver.ts", "apps/*/src/slack/*.ts")).toBe(false);
    expect(globMatches("apps/api/src/x/y.ts", "apps/*/y.ts")).toBe(false);
    expect(globMatches("a/b", "a/**/b")).toBe(true);
    expect(globMatches("a/x/y/b", "a/**/b")).toBe(true);
    expect(globMatches("a/b1.ts", "a/b?.ts")).toBe(true);
    expect(globMatches("a/b/.ts", "a/b?.ts")).toBe(false);
  });

  it("matches a pattern without / at any depth", () => {
    expect(globMatches("supabase/migrations/1_a.sql", "*.sql")).toBe(true);
    expect(globMatches("README.md", "README.md")).toBe(true);
    expect(globMatches("docs/README.md", "README.md")).toBe(true);
    expect(globMatches("README.mdx", "README.md")).toBe(false);
  });

  it("treats other characters as literal and never matches an empty pattern", () => {
    expect(globMatches("a/{b,c}", "a/{b,c}")).toBe(true);
    expect(globMatches("a/b", "a/{b,c}")).toBe(false);
    expect(globMatches("a", "")).toBe(false);
    expect(globMatches("a", "/")).toBe(false);
  });

  it("stays fast on a pattern made to backtrack", () => {
    const started = performance.now();
    expect(globMatches(`${"a".repeat(200)}b`, `${"*a".repeat(40)}c`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
