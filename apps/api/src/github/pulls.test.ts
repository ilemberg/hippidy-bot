import { describe, expect, it } from "vitest";
import { capDiff, createGitHubPulls, repositoryOf, type PullsFetch } from "./pulls.ts";

// Slice 4.3 (decision 219): the checker reads the repository's open pull requests and their
// diffs with the agent's token, and posts comment reviews with the review token. GitHub is
// faked; the requests the client sends are checked.

const AGENT_TOKEN = "github_pat_agent_secret";
const REVIEW_TOKEN = "github_pat_review_secret";

interface Asked {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function github(answer: (asked: Asked) => { status: number; body: unknown }) {
  const asked: Asked[] = [];
  const fetch: PullsFetch = (url, init) => {
    const request: Asked = {
      url,
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body === undefined ? undefined : (JSON.parse(init.body) as unknown),
    };
    asked.push(request);
    const { status, body } = answer(request);
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return Promise.resolve(new Response(text, { status }));
  };
  const pulls = createGitHubPulls({
    repositoryUrl: "https://github.com/ilemberg/Hippidy-Bot",
    token: AGENT_TOKEN,
    fetch,
  });
  if (pulls === undefined) throw new Error("expected a client");
  return { pulls, asked };
}

function pull(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: `Change ${String(number)}`,
    body: null,
    draft: false,
    html_url: `https://github.com/ilemberg/hippidy-bot/pull/${String(number)}`,
    updated_at: "2026-11-26T10:00:00Z",
    head: { sha: `${String(number)}abcdef0`, repo: { full_name: "ilemberg/hippidy-bot" } },
    base: { repo: { full_name: "ilemberg/hippidy-bot" } },
    ...overrides,
  };
}

describe("repositoryOf", () => {
  it("reads owner/name, lowercase, from a GitHub link", () => {
    expect(repositoryOf("https://github.com/Ilemberg/Hippidy-Bot.git")).toBe(
      "ilemberg/hippidy-bot",
    );
    expect(repositoryOf("https://gitlab.com/a/b")).toBeUndefined();
  });
});

describe("createGitHubPulls", () => {
  it("lists open pull requests, newest change first, with the agent's token", async () => {
    const { pulls, asked } = github(() => ({
      status: 200,
      body: [
        pull(7, { body: "Why it changes." }),
        pull(8, { draft: true }),
        pull(9, { head: { sha: "9abcdef0", repo: { full_name: "someone/hippidy-bot" } } }),
        pull(10, { head: { sha: "10abcdef0", repo: null } }),
      ],
    }));
    const open = await pulls.listOpen();
    expect(open.map((p) => [p.number, p.draft, p.fromFork])).toEqual([
      [7, false, false],
      [8, true, false],
      [9, false, true],
      [10, false, true],
    ]);
    expect(open[0]).toEqual({
      number: 7,
      title: "Change 7",
      body: "Why it changes.",
      draft: false,
      headSha: "7abcdef0",
      fromFork: false,
      url: "https://github.com/ilemberg/hippidy-bot/pull/7",
      updatedAt: "2026-11-26T10:00:00Z",
    });
    expect(asked[0]).toMatchObject({
      url: "https://api.github.com/repos/ilemberg/hippidy-bot/pulls?state=open&sort=updated&direction=desc&per_page=50",
      method: "GET",
      headers: {
        Authorization: `Bearer ${AGENT_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "hippidy-bot",
      },
    });
  });

  it("reads a diff as a diff, cut by whole files", async () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
      "diff --git a/src/b.ts b/src/c.ts\nrename from src/b.ts\nrename to src/c.ts\n",
    ].join("");
    const { pulls, asked } = github(() => ({ status: 200, body: diff }));
    expect(await pulls.diff(7)).toEqual({
      text: diff,
      files: ["src/a.ts", "src/c.ts"],
      omitted: [],
    });
    expect(asked[0]).toMatchObject({
      url: "https://api.github.com/repos/ilemberg/hippidy-bot/pulls/7",
      headers: { Authorization: `Bearer ${AGENT_TOKEN}`, Accept: "application/vnd.github.diff" },
    });
  });

  it("posts a comment review on the head commit with the review token, never an approval", async () => {
    const { pulls, asked } = github(() => ({
      status: 200,
      body: {
        id: 1,
        html_url: "https://github.com/ilemberg/hippidy-bot/pull/7#pullrequestreview-1",
      },
    }));
    expect(
      await pulls.postReview(7, { commitId: "7abcdef0", body: "Looks fine." }, REVIEW_TOKEN),
    ).toEqual({
      url: "https://github.com/ilemberg/hippidy-bot/pull/7#pullrequestreview-1",
    });
    expect(asked[0]).toEqual({
      url: "https://api.github.com/repos/ilemberg/hippidy-bot/pulls/7/reviews",
      method: "POST",
      headers: {
        Authorization: `Bearer ${REVIEW_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "hippidy-bot",
        "Content-Type": "application/json",
      },
      body: { commit_id: "7abcdef0", body: "Looks fine.", event: "COMMENT" },
    });
  });

  it("names the path and status of a failure, never a token", async () => {
    const { pulls } = github(() => ({ status: 403, body: { message: "Resource not accessible" } }));
    const failure = await pulls
      .postReview(7, { commitId: "7abcdef0", body: "x" }, REVIEW_TOKEN)
      .then(
        () => "posted",
        (error: unknown) => String(error),
      );
    expect(failure).toBe(
      "Error: GitHub answered 403 for POST /repos/ilemberg/hippidy-bot/pulls/7/reviews",
    );
    const listing = await pulls.listOpen().then(
      () => "listed",
      (error: unknown) => String(error),
    );
    expect(listing).not.toContain(AGENT_TOKEN);
    expect(listing).toContain("403");
  });

  it("is not made for a link that is not a GitHub repository", () => {
    expect(createGitHubPulls({ repositoryUrl: "not a link", token: AGENT_TOKEN })).toBeUndefined();
  });
});

describe("capDiff", () => {
  const section = (file: string, size: number) =>
    `diff --git a/${file} b/${file}\n${"+".repeat(Math.max(0, size - 30 - 2 * file.length))}\n`;

  it("keeps whole files while they fit and names the ones left out", () => {
    const a = section("a.ts", 400);
    const big = section("big.ts", 900);
    const c = section("c.ts", 400);
    const capped = capDiff(a + big + c, 1000);
    expect(capped).toEqual({ text: a + c, files: ["a.ts", "big.ts", "c.ts"], omitted: ["big.ts"] });
    expect(capped.text.length).toBeLessThanOrEqual(1000);
  });

  it("keeps a diff under the cap as it is", () => {
    expect(capDiff("")).toEqual({ text: "", files: [], omitted: [] });
  });
});
