import { describe, expect, it } from "vitest";
import { createGitHubChecks, verdictOf } from "./checks.ts";

describe("verdictOf", () => {
  const run = (name: string, status: string, conclusion: string | null) => ({
    name,
    status,
    conclusion,
  });

  it("passes when every check has finished well", () => {
    expect(
      verdictOf([run("ci", "completed", "success"), run("preview", "completed", "skipped")]),
    ).toEqual({ kind: "passed" });
  });

  it("fails on any failed check, even while others run", () => {
    expect(
      verdictOf([run("ci", "completed", "failure"), run("other", "in_progress", null)]),
    ).toEqual({ kind: "failed", names: ["ci"] });
  });

  it("is pending while a check runs, or before any has started", () => {
    expect(verdictOf([run("ci", "queued", null)])).toEqual({ kind: "pending" });
    expect(verdictOf([])).toEqual({ kind: "pending" });
  });
});

describe("createGitHubChecks", () => {
  function github(responses: Record<string, unknown>) {
    const asked: { url: string; auth: string | null }[] = [];
    const fetch = (input: string, init?: RequestInit) => {
      const url = input;
      asked.push({ url, auth: new Headers(init?.headers).get("authorization") });
      const body = responses[url.replace("https://api.github.com", "")];
      return Promise.resolve(
        body === undefined
          ? new Response("not found", { status: 404 })
          : new Response(JSON.stringify(body), { status: 200 }),
      );
    };
    return { fetch: fetch as unknown as typeof globalThis.fetch, asked };
  }

  const checks = (fetch: typeof globalThis.fetch) =>
    createGitHubChecks({
      repositoryUrl: "https://github.com/ilemberg/hippidy-bot",
      token: "github_pat_test",
      fetch,
    });

  it("reads the checks of the pull request's head commit", async () => {
    const { fetch, asked } = github({
      "/repos/ilemberg/hippidy-bot/pulls/22": { state: "open", head: { sha: "abc" } },
      "/repos/ilemberg/hippidy-bot/commits/abc/check-runs?per_page=100": {
        total_count: 1,
        check_runs: [{ name: "ci", status: "completed", conclusion: "success" }],
      },
    });
    expect(await checks(fetch).verdict("https://github.com/ilemberg/hippidy-bot/pull/22")).toEqual({
      kind: "passed",
    });
    expect(asked.map((call) => call.auth)).toEqual([
      "Bearer github_pat_test",
      "Bearer github_pat_test",
    ]);
  });

  it("does not check a pull request in another repo, or something that is not one", async () => {
    const { fetch, asked } = github({});
    const host = checks(fetch);
    expect(await host.verdict("https://github.com/someone/else/pull/1")).toMatchObject({
      kind: "not_checked",
    });
    expect(await host.verdict("https://example.com/pull/1")).toMatchObject({
      kind: "not_checked",
    });
    expect(asked).toEqual([]);
  });

  it("throws when GitHub does not answer, so the sync is tried again", async () => {
    const { fetch } = github({});
    await expect(
      checks(fetch).verdict("https://github.com/ilemberg/hippidy-bot/pull/22"),
    ).rejects.toThrow(/404/);
  });
});
