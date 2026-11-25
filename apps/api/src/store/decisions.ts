import {
  decisionStatusSchema,
  type Decision,
  type DecisionStatus,
  type MessageSource,
} from "@hippidy/contracts";
import { z } from "zod";
import type { Db, Row } from "./db.ts";

// Decisions on record (slice 2.2, decisions 190 to 192). The API decides whether a recorded
// decision is active or proposed; a person confirms a proposal. Every write is keyed on the
// call or the person that made it, so doing it again changes nothing.

// `number` is a bigint, which the production client returns as a string: read as float8,
// exact far beyond any number of decisions.
const columns = `
  d.id, d.number::float8 as number, d.statement, d.reason, d.area, d.status,
  d.decided_by_actor_id, d.decided_by_name, d.decided_at, d.origin, d.origin_ref,
  d.conversation_id, coalesce(d.channel_id, c.channel_id) as channel_id,
  coalesce(d.thread_id, c.thread_id) as thread_id, d.message_id,
  s.number::float8 as supersedes,
  d.confirmed_by_actor_id, d.confirmed_by_name, d.confirmed_at`;
const from = `decisions d left join decisions s on s.id = d.supersedes_id
  left join conversations c on c.id = d.conversation_id`;

const row = z.object({
  id: z.string(),
  number: z.number().int().positive(),
  statement: z.string(),
  reason: z.string().nullable(),
  area: z.string().nullable(),
  status: decisionStatusSchema,
  decided_by_actor_id: z.string().nullable(),
  decided_by_name: z.string().nullable(),
  decided_at: z.date(),
  origin: z.enum(["thread", "import", "capture"]),
  origin_ref: z.string().nullable(),
  conversation_id: z.string().nullable(),
  channel_id: z.string().nullable(),
  thread_id: z.string().nullable(),
  message_id: z.string().nullable(),
  supersedes: z.number().int().positive().nullable(),
  confirmed_by_actor_id: z.string().nullable(),
  confirmed_by_name: z.string().nullable(),
  confirmed_at: z.date().nullable(),
});

function toDecision(r: Row): Decision {
  const d = row.parse(r);
  return {
    id: d.id,
    number: d.number,
    statement: d.statement,
    reason: d.reason,
    area: d.area,
    status: d.status,
    decidedBy: { actorId: d.decided_by_actor_id, name: d.decided_by_name },
    decidedAt: d.decided_at.toISOString(),
    origin: d.origin,
    originRef: d.origin_ref,
    conversationId: d.conversation_id,
    channelId: d.channel_id,
    threadId: d.thread_id,
    messageId: d.message_id,
    supersedes: d.supersedes,
    confirmedBy:
      d.confirmed_by_actor_id === null
        ? null
        : { actorId: d.confirmed_by_actor_id, name: d.confirmed_by_name },
    confirmedAt: d.confirmed_at === null ? null : d.confirmed_at.toISOString(),
  };
}

export interface DecisionActor {
  source: MessageSource;
  workspaceId: string;
  actorId: string;
  name: string | null;
}

export type RecordDecisionResult =
  | { kind: "recorded" | "existing"; decision: Decision }
  /** `supersedes` names no active decision. */
  | { kind: "no_superseded" };

/**
 * Records a decision made in a thread (decision 192), once per tool call. An active decision
 * that supersedes another makes that one superseded, in the same transaction; a proposal does
 * so only when it is confirmed.
 */
export async function recordDecision(
  db: Db,
  input: {
    customToolUseId: string;
    conversationId: string;
    messageId: string | null;
    statement: string;
    reason: string | undefined;
    area: string | undefined;
    decidedBy: DecisionActor;
    status: "active" | "proposed";
    supersedes: number | undefined;
  },
): Promise<RecordDecisionResult> {
  return db.transaction(async (tx) => {
    const existing = await tx.query(
      `select ${columns} from ${from} where d.custom_tool_use_id = $1`,
      [input.customToolUseId],
    );
    if (existing[0] !== undefined) return { kind: "existing", decision: toDecision(existing[0]) };

    let supersedesId: string | null = null;
    if (input.supersedes !== undefined) {
      const old = await tx.query(
        `select id from decisions where number = $1 and status = 'active' for update`,
        [input.supersedes],
      );
      if (old[0] === undefined) return { kind: "no_superseded" };
      supersedesId = z.object({ id: z.string() }).parse(old[0]).id;
    }
    const inserted = await tx.query(
      `insert into decisions (statement, reason, area, status, decided_by_source,
         decided_by_workspace_id, decided_by_actor_id, decided_by_name, decided_at, origin,
         conversation_id, message_id, supersedes_id, custom_tool_use_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now(), 'thread', $9, $10, $11, $12)
       returning id`,
      [
        input.statement,
        input.reason ?? null,
        input.area ?? null,
        input.status,
        input.decidedBy.source,
        input.decidedBy.workspaceId,
        input.decidedBy.actorId,
        input.decidedBy.name,
        input.conversationId,
        input.messageId,
        supersedesId,
        input.customToolUseId,
      ],
    );
    const id = z.object({ id: z.string() }).parse(inserted[0]).id;
    if (input.status === "active" && supersedesId !== null) {
      await tx.query(
        `update decisions set status = 'superseded', updated_at = now() where id = $1`,
        [supersedesId],
      );
    }
    const decision = await tx.query(`select ${columns} from ${from} where d.id = $1`, [id]);
    return { kind: "recorded", decision: toDecision(one(decision)) };
  });
}

/**
 * A person confirms a proposal (decision 192): only one recorded in a thread of their source
 * and workspace, and only while it is proposed. It becomes active, names who confirmed it, and
 * supersedes the decision it replaces if that one is still active.
 */
export async function confirmDecision(
  db: Db,
  decisionId: string,
  person: DecisionActor,
): Promise<
  | {
      status: "confirmed";
      decision: Decision;
      /** The decision it replaces, and whether that one was still active to replace. */
      replaced?: { number: number; stillActive: boolean } | undefined;
    }
  | { status: "not_proposed" | "not_found"; decision?: Decision; replaced?: undefined }
> {
  return db.transaction(async (tx) => {
    const rows = await tx.query(
      `select d.status, d.supersedes_id from decisions d
       join conversations v on v.id = d.conversation_id
       where d.id = $1 and v.source = $2 and v.workspace_id = $3
       for update of d`,
      [decisionId, person.source, person.workspaceId],
    );
    if (rows[0] === undefined) return { status: "not_found" };
    const found = z
      .object({ status: decisionStatusSchema, supersedes_id: z.string().nullable() })
      .parse(rows[0]);
    if (found.status !== "proposed") {
      const decision = await tx.query(`select ${columns} from ${from} where d.id = $1`, [
        decisionId,
      ]);
      return { status: "not_proposed", decision: toDecision(one(decision)) };
    }
    await tx.query(
      `update decisions
       set status = 'active', confirmed_by_source = $2, confirmed_by_workspace_id = $3,
           confirmed_by_actor_id = $4, confirmed_by_name = $5, confirmed_at = now(),
           updated_at = now()
       where id = $1`,
      [decisionId, person.source, person.workspaceId, person.actorId, person.name],
    );
    let replaced: { number: number; stillActive: boolean } | undefined;
    if (found.supersedes_id !== null) {
      const old = await tx.query(
        `select number::float8 as number, status from decisions where id = $1 for update`,
        [found.supersedes_id],
      );
      const o = z.object({ number: z.number(), status: z.string() }).parse(one(old));
      // Only a decision still active is replaced; one superseded meanwhile is left as it is.
      if (o.status === "active") {
        await tx.query(
          `update decisions set status = 'superseded', updated_at = now() where id = $1`,
          [found.supersedes_id],
        );
      }
      replaced = { number: o.number, stillActive: o.status === "active" };
    }
    const decision = await tx.query(`select ${columns} from ${from} where d.id = $1`, [decisionId]);
    return { status: "confirmed", decision: toDecision(one(decision)), replaced };
  });
}

/**
 * Decisions matching `query` by full-text search (no model), best first, then newest. With no
 * query, the newest. Only the given statuses; active by default.
 */
export async function searchDecisions(
  db: Db,
  options: {
    query?: string | undefined;
    area?: string | undefined;
    statuses?: readonly DecisionStatus[] | undefined;
    origin?: Decision["origin"] | undefined;
    limit: number;
    /**
     * How many of the query's words a decision must share to be returned: 1 for a search, 2 for
     * the decisions put before a message, so one common word does not bring in a decision.
     */
    minShared?: number;
  },
): Promise<Decision[]> {
  const statuses = options.statuses ?? ["active"];
  const query = options.query ?? null;
  // The words of `query`, as the index stemmed them, joined with `or`: a decision that shares
  // some of them matches, ranked by how many. Each is quoted (a word like `https:` would break
  // the query's syntax) and read with the `simple` configuration, so it is not stemmed twice.
  const rows = await db.query(
    `with w as (
       select array(
         select quote_literal(lexeme) from unnest(to_tsvector('english', coalesce($1::text, '')))
       ) as words
     ),
     q as (
       -- No query: everything. A query with no searchable words (only stop words): nothing,
       -- without asking Postgres for an empty text search.
       select case when $1::text is null or cardinality(w.words) = 0 then null
                   else to_tsquery('simple', array_to_string(w.words, ' | ')) end as query,
              $1::text is not null and cardinality(w.words) = 0 as nothing,
              w.words
       from w
     )
     select ${columns}
     from ${from}, q
     where d.status = any($2::text[])
       and not q.nothing
       and ($3::text is null or lower(d.area) = lower($3::text))
       and ($6::text is null or d.origin = $6::text)
       and (q.query is null or (
         d.search @@ q.query
         and (select count(*) from unnest(q.words) x where d.search @@ to_tsquery('simple', x))
             >= $5
       ))
     -- Rank by matches, divided by the decision's length (normalization 1), so a long log entry
     -- does not win on length alone.
     order by case when q.query is null then 0 else ts_rank(d.search, q.query, 1) end desc,
              d.decided_at desc, d.number desc
     limit $4`,
    [
      query,
      statuses,
      options.area ?? null,
      options.limit,
      options.minShared ?? 1,
      options.origin ?? null,
    ],
  );
  return rows.map(toDecision);
}

export async function getDecision(db: Db, id: string): Promise<Decision | undefined> {
  const rows = await db.query(`select ${columns} from ${from} where d.id = $1`, [id]);
  return rows[0] === undefined ? undefined : toDecision(rows[0]);
}

/**
 * Who sent the given messages of the thread (by their agent event ids), and whether any came
 * with other people's words from the thread (decision 164).
 */
export async function readTurnSenders(
  db: Db,
  conversationId: string,
  eventIds: readonly string[],
): Promise<{ actorIds: string[]; carriedContext: boolean }> {
  if (eventIds.length === 0) return { actorIds: [], carriedContext: false };
  const rows = await db.query(
    `select actor_id, carried_context from inbound_messages
     where conversation_id = $1 and agent_event_id = any($2::text[])`,
    [conversationId, eventIds],
  );
  const parsed = rows.map((r) =>
    z.object({ actor_id: z.string(), carried_context: z.boolean() }).parse(r),
  );
  return {
    actorIds: [...new Set(parsed.map((r) => r.actor_id))],
    carriedContext: parsed.some((r) => r.carried_context),
  };
}

/** An active decision by its number, for one that a new decision says it replaces. */
export async function findDecisionByNumber(db: Db, number: number): Promise<Decision | undefined> {
  const rows = await db.query(`select ${columns} from ${from} where d.number = $1`, [number]);
  return rows[0] === undefined ? undefined : toDecision(rows[0]);
}

/**
 * The message a custom tool call's turn is answering: of the conversation's messages the
 * session processed, the latest at or before the call (as `readTurnSender` finds its sender).
 */
export async function readTurnMessage(
  db: Db,
  conversationId: string,
  callProcessedAt: string,
  messages: readonly { eventId: string; processedAt: string }[],
): Promise<{ actorId: string; actorName: string | null; messageId: string } | undefined> {
  if (messages.length === 0) return undefined;
  const rows = await db.query(
    `select m.actor_id, m.actor_name, m.message_id
     from unnest($2::text[], $3::text[]) as u(event_id, processed_at)
     join inbound_messages m on m.conversation_id = $1 and m.agent_event_id = u.event_id
     where u.processed_at::timestamptz <= $4::timestamptz
     order by u.processed_at::timestamptz desc, m.created_at desc
     limit 1`,
    [
      conversationId,
      messages.map((m) => m.eventId),
      messages.map((m) => m.processedAt),
      callProcessedAt,
    ],
  );
  const r = z
    .object({ actor_id: z.string(), actor_name: z.string().nullable(), message_id: z.string() })
    .optional()
    .parse(rows[0]);
  return r === undefined
    ? undefined
    : { actorId: r.actor_id, actorName: r.actor_name, messageId: r.message_id };
}

function one(rows: Row[]): Row {
  const r = rows[0];
  if (r === undefined) throw new Error("expected one row, got none");
  return r;
}
