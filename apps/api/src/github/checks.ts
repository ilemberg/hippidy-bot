import { z } from "zod";

/**
 * What the CI checks of a pull request say (decision 132). `not_checked` means the API could
 * not find out: the pull request is not in the agent's repo, or GitHub would not say.
 */
export type ChecksVerdict =
  | { kind: "passed" }
  | { kind: "failed"; names: string[] }
  | { kind: "pending" }
  | { kind: "not_checked"; reason: string };

/** Reads a pull request's CI checks. GitHub for now; a fake in tests. */
export interface PullRequestChecks {
  verdict(pullRequestUrl: string): Promise<ChecksVerdict>;
}

/** Check run conclusions that mean the work is not done. */
const FAILING = new Set(["failure", "cancelled", "timed_out", "action_required", "stale"]);

const pullSchema = z.object({ state: z.string(), head: z.object({ sha: z.string() }) });
const checkRunsSchema = z.object({
  total_count: z.number(),
  check_runs: z.array(
    z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() }),
  ),
});

/**
 * GitHub's REST API, with the agent's token, limited to the agent's repo: a link the agent
 * gives for any other repo is not checked.
 */
export function createGitHubChecks(options: {
  repositoryUrl: string;
  token: string;
  fetch?: typeof fetch;
}): PullRequestChecks {
  const doFetch = options.fetch ?? fetch;
  const repo = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
    options.repositoryUrl,
  );
  const ownerAndName = repo === null ? "" : `${repo[1] ?? ""}/${repo[2] ?? ""}`.toLowerCase();

  async function get(path: string): Promise<unknown> {
    const response = await doFetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "hippidy-bot",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`GitHub answered ${String(response.status)} for ${path}`);
    return response.json();
  }

  return {
    async verdict(pullRequestUrl) {
      const [, path, number] =
        /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(pullRequestUrl) ?? [];
      if (path === undefined || number === undefined) {
        return { kind: "not_checked", reason: "not a pull request link" };
      }
      if (ownerAndName === "" || path.toLowerCase() !== ownerAndName) {
        return { kind: "not_checked", reason: "not a pull request in the agent's repo" };
      }
      const pull = pullSchema.parse(await get(`/repos/${path}/pulls/${number}`));
      const runs = checkRunsSchema.parse(
        await get(`/repos/${path}/commits/${pull.head.sha}/check-runs?per_page=100`),
      );
      return verdictOf(runs.check_runs);
    },
  };
}

/** One verdict from a commit's check runs. None yet means CI has not started: pending. */
export function verdictOf(
  runs: readonly { name: string; status: string; conclusion?: string | null }[],
): ChecksVerdict {
  const failed = runs.filter(
    (run) => typeof run.conclusion === "string" && FAILING.has(run.conclusion),
  );
  if (failed.length > 0) return { kind: "failed", names: failed.map((run) => run.name) };
  if (runs.length === 0 || runs.some((run) => run.status !== "completed")) {
    return { kind: "pending" };
  }
  return { kind: "passed" };
}
