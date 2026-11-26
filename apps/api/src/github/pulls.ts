import { z } from "zod";

// The checker's view of GitHub (slice 4.3, decision 219): the repository's open pull requests
// with their diffs and reviews, read with the token that already reads CI checks (decision
// 132), and a comment review posted with `GITHUB_REVIEW_TOKEN`, a token that can only comment
// (G20). It never approves: the review's event is always COMMENT. Nothing here logs; errors
// name the path and status, never a token.

/** Most characters of a diff put before the model; the files past it are named, not read. */
export const MAX_DIFF_CHARACTERS = 60_000;

/**
 * The part of `fetch` the client uses, typed by shape: Vercel's build type-checks the global
 * `Response` as empty, so reading `ok`, `json()` or `text()` from it fails there (CLAUDE.md).
 */
export type PullsFetch = (
  url: string,
  init: {
    method?: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** An open pull request, as the checker reads it. */
export interface OpenPullRequest {
  number: number;
  title: string;
  body: string;
  draft: boolean;
  headSha: string;
  /** Whether its head branch is in another repository than its base: a fork's. */
  fromFork: boolean;
  url: string;
  updatedAt: string;
}

/** A pull request's diff, cut to `MAX_DIFF_CHARACTERS` by whole files. */
export interface PullRequestDiff {
  text: string;
  /** Every file it changes, in its order. */
  files: string[];
  /** The files whose part of the diff was left out to stay under the cap. */
  omitted: string[];
}

/** A review already on a pull request. */
export interface PostedReview {
  /** The commit it was posted on; null when GitHub no longer knows it. */
  commitId: string | null;
  body: string;
  url: string;
}

/** GitHub refused a diff as too large to send (HTTP 406): no later try will read it either. */
export class DiffTooLargeError extends Error {
  constructor(number: number) {
    super(`GitHub refused the diff of #${String(number)} as too large`);
    this.name = "DiffTooLargeError";
  }
}

export interface PullRequests {
  /** `owner/name`, lowercase. */
  readonly repository: string;
  /** Open pull requests, the most recently updated first (at most 50). */
  listOpen(): Promise<OpenPullRequest[]>;
  /** Its diff; throws `DiffTooLargeError` when GitHub will not send it. */
  diff(number: number): Promise<PullRequestDiff>;
  /** The reviews on a pull request, oldest first (at most 100). */
  listReviews(number: number): Promise<PostedReview[]>;
  /** Posts a comment review on a head commit, with the review token. Answers its link. */
  postReview(
    number: number,
    review: { commitId: string; body: string },
    reviewToken: string,
  ): Promise<{ url: string }>;
}

const pullsSchema = z.array(
  z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable().optional(),
    draft: z.boolean().optional(),
    html_url: z.string(),
    updated_at: z.string(),
    head: z.object({
      sha: z.string(),
      repo: z.object({ full_name: z.string() }).nullable(),
    }),
    base: z.object({ repo: z.object({ full_name: z.string() }) }),
  }),
);

const reviewSchema = z.object({ id: z.number(), html_url: z.string() });

const reviewsSchema = z.array(
  z.object({
    html_url: z.string(),
    body: z.string().nullable().optional(),
    commit_id: z.string().nullable().optional(),
  }),
);

/** A request GitHub answered with an error status. */
class GitHubError extends Error {
  readonly status: number;

  constructor(status: number, method: string, path: string) {
    super(`GitHub answered ${String(status)} for ${method} ${path}`);
    this.status = status;
  }
}

/** `owner/name` of a `https://github.com/owner/name` link, lowercase, or undefined. */
export function repositoryOf(url: string): string | undefined {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return match === null ? undefined : `${match[1] ?? ""}/${match[2] ?? ""}`.toLowerCase();
}

/** The repository's pull requests on GitHub's REST API. Undefined for a link it cannot read. */
export function createGitHubPulls(options: {
  repositoryUrl: string;
  token: string;
  fetch?: PullsFetch;
}): PullRequests | undefined {
  const repository = repositoryOf(options.repositoryUrl);
  if (repository === undefined) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- needed on Vercel
  const doFetch = options.fetch ?? (fetch as unknown as PullsFetch);

  function headers(token: string, accept: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "hippidy-bot",
    };
  }

  async function call(
    path: string,
    init: { method?: string; token: string; accept: string; body?: unknown; timeoutMs: number },
  ) {
    const response = await doFetch(`https://api.github.com${path}`, {
      ...(init.method === undefined ? {} : { method: init.method }),
      headers: {
        ...headers(init.token, init.accept),
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(init.timeoutMs),
    });
    if (!response.ok) throw new GitHubError(response.status, init.method ?? "GET", path);
    return response;
  }

  return {
    repository,

    async listOpen() {
      const response = await call(
        `/repos/${repository}/pulls?state=open&sort=updated&direction=desc&per_page=50`,
        { token: options.token, accept: "application/vnd.github+json", timeoutMs: 10_000 },
      );
      return pullsSchema.parse(await response.json()).map((pull) => ({
        number: pull.number,
        title: pull.title,
        body: pull.body ?? "",
        draft: pull.draft ?? false,
        headSha: pull.head.sha,
        // A deleted fork has no head repository: still not this one.
        fromFork:
          pull.head.repo?.full_name.toLowerCase() !== pull.base.repo.full_name.toLowerCase(),
        url: pull.html_url,
        updatedAt: pull.updated_at,
      }));
    },

    async diff(number) {
      const response = await call(`/repos/${repository}/pulls/${String(number)}`, {
        token: options.token,
        accept: "application/vnd.github.diff",
        timeoutMs: 15_000,
      }).catch((error: unknown): never => {
        // GitHub sends no diff past its own limits (too many files or lines).
        if (error instanceof GitHubError && error.status === 406) {
          throw new DiffTooLargeError(number);
        }
        throw error;
      });
      return capDiff(await response.text());
    },

    async listReviews(number) {
      const response = await call(
        `/repos/${repository}/pulls/${String(number)}/reviews?per_page=100`,
        { token: options.token, accept: "application/vnd.github+json", timeoutMs: 10_000 },
      );
      return reviewsSchema.parse(await response.json()).map((review) => ({
        commitId: review.commit_id ?? null,
        body: review.body ?? "",
        url: review.html_url,
      }));
    },

    async postReview(number, review, reviewToken) {
      const response = await call(`/repos/${repository}/pulls/${String(number)}/reviews`, {
        method: "POST",
        token: reviewToken,
        accept: "application/vnd.github+json",
        // Only ever a comment: the checker never approves or requests changes (rule 18).
        body: { commit_id: review.commitId, body: review.body, event: "COMMENT" },
        timeoutMs: 15_000,
      });
      return { url: reviewSchema.parse(await response.json()).html_url };
    },
  };
}

/** The file a `diff --git a/x b/y` section is about: where it ends up. */
function fileOf(section: string): string {
  const header = section.split("\n", 1)[0] ?? "";
  const match = / b\/(.+)$/.exec(header);
  return match?.[1] ?? header.replace(/^diff --git /, "");
}

/**
 * Cuts a unified diff to `limit` characters by whole files, in order, keeping each file that
 * still fits, and names the files left out.
 */
export function capDiff(diff: string, limit = MAX_DIFF_CHARACTERS): PullRequestDiff {
  const sections = diff.split(/^(?=diff --git )/m).filter((section) => section.trim() !== "");
  const files = sections.map(fileOf);
  const kept: string[] = [];
  const omitted: string[] = [];
  let size = 0;
  sections.forEach((section, index) => {
    if (size + section.length <= limit) {
      kept.push(section);
      size += section.length;
    } else {
      omitted.push(files[index] ?? "");
    }
  });
  return { text: kept.join(""), files, omitted };
}
