import { z } from "zod";
import type { Db } from "./db.ts";
import { storable } from "./json.ts";

// The checker's reviews (slice 4.3, decision 219): each head commit of a pull request is
// reviewed once, whatever happens. A review that could not be written or posted is kept as
// failed and tried again on a later wake, three tries in all, then abandoned. What another try
// would meet again (a refusal, a cut-off, a diff too large) is abandoned at once.

/** Tries of one head commit before it is abandoned: the first and two more. */
export const MAX_REVIEW_ATTEMPTS = 3;
/** A try left pending this long was killed with its wake (`closeUnfinishedWakes`). */
const STALE_MINUTES = 10;

export interface ReviewHead {
  repository: string;
  number: number;
  headSha: string;
}

export interface ReviewClaim {
  id: string;
  /** Tries started, this one included. */
  attempts: number;
  /** A review an earlier try wrote but did not post: posted again, not written again. */
  body: string | null;
  /** Its concerns, saved with the body. */
  concerns: number | null;
}

/**
 * The heads, of those given, that have a review that is not to be tried again: posted,
 * abandoned, or being written by another wake now.
 */
export async function settledHeads(db: Db, heads: readonly ReviewHead[]): Promise<Set<string>> {
  if (heads.length === 0) return new Set();
  const rows = await db.query(
    `select number, head_sha from pull_request_reviews
     where repository = $1 and head_sha = any($2::text[])
       and (status in ('posted', 'abandoned')
            or (status = 'pending' and updated_at >= now() - make_interval(mins => $4))
            or attempts >= $3)`,
    [
      heads[0]?.repository ?? "",
      heads.map((head) => head.headSha),
      MAX_REVIEW_ATTEMPTS,
      STALE_MINUTES,
    ],
  );
  return new Set(
    rows.map((row) => {
      const r = z.object({ number: z.number(), head_sha: z.string() }).parse(row);
      return `${String(r.number)}@${r.head_sha}`;
    }),
  );
}

/**
 * Takes a head for this wake, atomically: a new head, a failed one with tries left, or one a
 * killed wake left pending. Overlapping wakes never take the same head twice. Answers the
 * claim, or undefined when it is not to be reviewed now.
 */
export async function claimReview(
  db: Db,
  head: ReviewHead & { changeId: string | null },
): Promise<ReviewClaim | undefined> {
  // A try a killed wake left pending with no tries left is given up, so it reads as settled.
  await db.query(
    `update pull_request_reviews
     set status = 'abandoned', error = 'did not finish', updated_at = now()
     where repository = $1 and number = $2 and head_sha = $3 and status = 'pending'
       and attempts >= $4 and updated_at < now() - make_interval(mins => $5)`,
    [head.repository, head.number, head.headSha, MAX_REVIEW_ATTEMPTS, STALE_MINUTES],
  );
  const rows = await db.query(
    `insert into pull_request_reviews (repository, number, head_sha, change_id)
     values ($1, $2, $3, $4)
     on conflict (repository, number, head_sha) do update
       set status = 'pending', attempts = pull_request_reviews.attempts + 1,
           change_id = coalesce(excluded.change_id, pull_request_reviews.change_id),
           error = null, updated_at = now()
       where pull_request_reviews.attempts < $5
         and (pull_request_reviews.status = 'failed'
              or (pull_request_reviews.status = 'pending'
                  and pull_request_reviews.updated_at < now() - make_interval(mins => $6)))
     returning id, attempts, body, concerns`,
    [head.repository, head.number, head.headSha, head.changeId, MAX_REVIEW_ATTEMPTS, STALE_MINUTES],
  );
  if (rows[0] === undefined) return undefined;
  const r = z
    .object({
      id: z.string(),
      attempts: z.number().int(),
      body: z.string().nullable(),
      concerns: z.number().int().nullable(),
    })
    .parse(rows[0]);
  return { id: r.id, attempts: r.attempts, body: r.body ?? null, concerns: r.concerns ?? null };
}

/** Most characters of a review body kept. */
const MAX_BODY_CHARACTERS = 65_000;

/**
 * Saves a review the model just wrote, with its concerns and the call's cost, on its own
 * before it is posted: a try that dies after this posts it, and never pays for it again.
 */
export async function saveWrittenReview(
  db: Db,
  id: string,
  written: { body: string; concerns: number; costMicros: number },
): Promise<void> {
  await db.query(
    `update pull_request_reviews
     set body = $2, concerns = $3, cost_micros = cost_micros + $4, updated_at = now()
     where id = $1`,
    [
      id,
      storable(written.body).slice(0, MAX_BODY_CHARACTERS),
      Math.max(0, Math.round(written.concerns)),
      Math.max(0, Math.round(written.costMicros)),
    ],
  );
}

/** Marks a review posted, with its link. */
export async function markReviewPosted(db: Db, id: string, url: string): Promise<void> {
  await db.query(
    `update pull_request_reviews
     set status = 'posted', review_url = $2, error = null, updated_at = now()
     where id = $1`,
    [id, url],
  );
}

/**
 * Marks a try failed, with why and any cost not yet saved: failed while tries are left,
 * abandoned after the last. Answers the status it now has.
 */
export async function markReviewFailed(
  db: Db,
  id: string,
  failed: { error: string; costMicros: number },
): Promise<"failed" | "abandoned"> {
  const rows = await db.query(
    `update pull_request_reviews
     set status = case when attempts >= $4 then 'abandoned' else 'failed' end,
         error = $2, cost_micros = cost_micros + $3, updated_at = now()
     where id = $1
     returning status`,
    [
      id,
      storable(failed.error).slice(0, 500),
      Math.max(0, Math.round(failed.costMicros)),
      MAX_REVIEW_ATTEMPTS,
    ],
  );
  return z.object({ status: z.enum(["failed", "abandoned"]) }).parse(rows[0]).status;
}

/**
 * Gives a head up at once, with why and its cost: what another try would meet again (a
 * refusal, a cut-off, a diff too large to read).
 */
export async function abandonReview(
  db: Db,
  id: string,
  abandoned: { error: string; costMicros: number },
): Promise<void> {
  await db.query(
    `update pull_request_reviews
     set status = 'abandoned', error = $2, cost_micros = cost_micros + $3, updated_at = now()
     where id = $1`,
    [id, storable(abandoned.error).slice(0, 500), Math.max(0, Math.round(abandoned.costMicros))],
  );
}

export interface ChangeOfPullRequest {
  changeId: string;
  conversationId: string;
  brief: { title: string; what: string; why: string; doneWhen: string } | undefined;
}

/** The change whose latest pull request is this one, if any, with its latest brief. */
export async function changeOfPullRequest(
  db: Db,
  url: string,
): Promise<ChangeOfPullRequest | undefined> {
  const rows = await db.query(
    `select c.id, c.conversation_id, b.title, b.what, b.why, b.done_when
     from changes c
     left join lateral (
       select title, what, why, done_when from change_briefs
       where change_id = c.id order by seq desc limit 1
     ) b on true
     where lower(rtrim(c.pull_request_url, '/')) = lower(rtrim($1, '/'))
     order by c.created_at desc
     limit 1`,
    [url],
  );
  if (rows[0] === undefined) return undefined;
  const r = z
    .object({
      id: z.string(),
      conversation_id: z.string(),
      title: z.string().nullable(),
      what: z.string().nullable(),
      why: z.string().nullable(),
      done_when: z.string().nullable(),
    })
    .parse(rows[0]);
  return {
    changeId: r.id,
    conversationId: r.conversation_id,
    brief:
      r.title === null
        ? undefined
        : { title: r.title, what: r.what ?? "", why: r.why ?? "", doneWhen: r.done_when ?? "" },
  };
}
