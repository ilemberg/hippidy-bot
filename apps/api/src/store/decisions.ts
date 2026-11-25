import {
  decisionStatusSchema,
  type Decision,
  type DecisionEvent,
  type DecisionStatus,
  type EditDecisionRequest,
  type MessageSource,
  type NotAllowedReason,
} from "@hippidy/contracts";
import { z } from "zod";
import type { Db, Row } from "./db.ts";
import { storable, toJsonText } from "./json.ts";

const wordingRow = z.object({
  statement: z.string(),
  reason: z.string().nullable(),
  area: z.string().nullable(),
  /** Who it named as deciding, when an edit by someone else made it theirs. */
  decidedBy: z.object({ actorId: z.string().nullable(), name: z.string().nullable() }).optional(),
});

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
  d.confirmed_by_actor_id, d.confirmed_by_name, d.confirmed_at,
  d.rejected_by_actor_id, d.rejected_by_name, d.rejected_at, d.wording_version`;
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
  rejected_by_actor_id: z.string().nullable(),
  rejected_by_name: z.string().nullable(),
  rejected_at: z.date().nullable(),
  wording_version: z.number().int().positive(),
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
    rejectedBy:
      d.rejected_by_actor_id === null
        ? null
        : { actorId: d.rejected_by_actor_id, name: d.rejected_by_name },
    rejectedAt: d.rejected_at === null ? null : d.rejected_at.toISOString(),
    wordingVersion: d.wording_version,
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

function emptyToNull(text: string | null): string | null {
  return text === null || text === "" ? null : text;
}

/** Confirm, reject or reword a proposal (slices 2.2 and 2.6). */
export type ProposalAction =
  | { kind: "confirm"; wordingVersion?: number | undefined }
  | { kind: "reject"; wordingVersion: number }
  | { kind: "edit"; edit: EditDecisionRequest };

export type ProposalOutcome =
  | {
      status: "confirmed";
      decision: Decision;
      /** The decision it replaces, and whether that one was still active to replace. */
      replaced?: { number: number; stillActive: boolean } | undefined;
    }
  | {
      status: "rejected" | "edited" | "not_proposed" | "changed";
      decision: Decision;
      replaced?: undefined;
    }
  | { status: "not_allowed"; reason: NotAllowedReason; decision: Decision; replaced?: undefined }
  | { status: "not_found"; decision?: undefined; replaced?: undefined };

const placeRow = z.object({
  status: decisionStatusSchema,
  origin: z.enum(["thread", "import", "capture"]),
  supersedes_id: z.string().nullable(),
  conversation_id: z.string().nullable(),
  confirmable_by: z.array(z.string()).nullable(),
  source: z.string().nullable(),
  workspace_id: z.string().nullable(),
  statement: z.string(),
  reason: z.string().nullable(),
  area: z.string().nullable(),
  wording_version: z.number().int().positive(),
  decided_by_actor_id: z.string().nullable(),
  decided_by_name: z.string().nullable(),
  created_at: z.date(),
});
type Place = z.infer<typeof placeRow>;

/** A decision's place and wording, locked when `lock` is set. */
async function readPlace(db: Db, decisionId: string, lock: boolean): Promise<Place | undefined> {
  const rows = await db.query(
    `select d.status, d.origin, d.supersedes_id, d.conversation_id, d.confirmable_by,
            coalesce(v.source, d.decided_by_source) as source,
            coalesce(v.workspace_id, d.decided_by_workspace_id) as workspace_id,
            d.statement, d.reason, d.area, d.wording_version, d.decided_by_actor_id,
            d.decided_by_name, d.created_at
     from decisions d left join conversations v on v.id = d.conversation_id
     where d.id = $1 ${lock ? "for update of d" : ""}`,
    [decisionId],
  );
  return rows[0] === undefined ? undefined : placeRow.parse(rows[0]);
}

/**
 * Whether a person may act on a decision (G11, decisions 201 and 202): an import never; one
 * the teammate recorded, a person whose message the bot received in its thread; one from
 * listening, a person who wrote in the thread it came from. Undefined: it is not in the
 * person's source and workspace, so for them it does not exist.
 */
async function permission(
  db: Db,
  place: Place,
  person: DecisionActor,
): Promise<{ kind: "may" } | { kind: "may_not"; reason: NotAllowedReason } | undefined> {
  if (place.origin === "import") return { kind: "may_not", reason: "read_only" };
  if (place.source !== person.source || place.workspace_id !== person.workspaceId) {
    return undefined;
  }
  // The owner of its area may act on it too (G11 from slice 3.1, decision 206), on what was
  // proposed after they became owner: anyone may change an owner, so making oneself owner of an
  // area does not open the proposals already waiting in it (decision 207).
  if (place.area !== null) {
    const owns = await db.query(
      `select 1 from areas
       where source = $1 and workspace_id = $2 and name = lower($3) and owner_actor_id = $4
         and owner_since <= $5`,
      [person.source, person.workspaceId, place.area, person.actorId, place.created_at],
    );
    if (owns.length > 0) return { kind: "may" };
  }
  if (place.origin === "capture") {
    return (place.confirmable_by ?? []).includes(person.actorId)
      ? { kind: "may" }
      : { kind: "may_not", reason: "not_in_thread" };
  }
  if (place.conversation_id === null) return { kind: "may_not", reason: "not_in_thread" };
  const wrote = await db.query(
    `select 1 from inbound_messages
     where conversation_id = $1 and source = $2 and workspace_id = $3 and actor_id = $4 limit 1`,
    [place.conversation_id, person.source, person.workspaceId, person.actorId],
  );
  return wrote.length > 0 ? { kind: "may" } : { kind: "may_not", reason: "not_in_thread" };
}

/** Whether a person may act on a decision now, for the wiki's page (no lock taken). */
export async function mayAct(
  db: Db,
  decisionId: string,
  person: DecisionActor,
): Promise<{ act: boolean; reason: NotAllowedReason | null }> {
  const place = await readPlace(db, decisionId, false);
  if (place === undefined) return { act: false, reason: null };
  const allowed = await permission(db, place, person);
  if (allowed === undefined) return { act: false, reason: null };
  if (allowed.kind === "may_not") return { act: false, reason: allowed.reason };
  return { act: place.status === "proposed", reason: null };
}

async function recordEvent(
  db: Db,
  decisionId: string,
  kind: "edited" | "confirmed" | "rejected" | "superseded",
  person: DecisionActor,
  change?: { before: unknown; after: unknown },
): Promise<void> {
  await db.query(
    `insert into decision_events (decision_id, kind, actor_source, actor_workspace_id, actor_id,
       actor_name, before, after)
     values ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8::text::jsonb)`,
    [
      decisionId,
      kind,
      person.source,
      person.workspaceId,
      person.actorId,
      person.name,
      change === undefined ? null : toJsonText(change.before),
      change === undefined ? null : toJsonText(change.after),
    ],
  );
}

/**
 * A person confirms, rejects or rewords a proposal, under one rule wherever they press (201).
 * Confirming makes it active and supersedes the decision it replaces, if that one is still
 * active. Every change is kept in `decision_events` with who and when.
 */
export async function actOnProposal(
  db: Db,
  decisionId: string,
  person: DecisionActor,
  action: ProposalAction,
): Promise<ProposalOutcome> {
  return db.transaction(async (tx) => {
    const place = await readPlace(tx, decisionId, true);
    if (place === undefined) return { status: "not_found" };
    const allowed = await permission(tx, place, person);
    if (allowed === undefined) return { status: "not_found" };
    const current = async () =>
      toDecision(
        one(await tx.query(`select ${columns} from ${from} where d.id = $1`, [decisionId])),
      );
    if (place.status !== "proposed") return { status: "not_proposed", decision: await current() };
    if (allowed.kind === "may_not") {
      return { status: "not_allowed", reason: allowed.reason, decision: await current() };
    }

    // Pressed on a wording that has changed since (1 for a Slack button): nothing is done, so
    // no one confirms or rejects words they never saw (decision 203).
    const pressedOn = action.kind === "edit" ? action.edit.wordingVersion : action.wordingVersion;
    if (pressedOn !== undefined && pressedOn !== place.wording_version) {
      return { status: "changed", decision: await current() };
    }

    if (action.kind === "edit") {
      const before = { statement: place.statement, reason: place.reason, area: place.area };
      const after = {
        statement: storable(action.edit.statement ?? place.statement),
        // An empty reason or area clears it.
        reason:
          action.edit.reason === undefined
            ? place.reason
            : emptyToNull(storable(action.edit.reason ?? "")),
        area:
          action.edit.area === undefined
            ? place.area
            : emptyToNull(storable(action.edit.area ?? "").toLowerCase()),
      };
      if (
        after.statement === before.statement &&
        after.reason === before.reason &&
        after.area === before.area
      ) {
        return { status: "edited", decision: await current() };
      }
      // Reworded by someone other than who it names as deciding: the words are theirs now, so
      // it is in their name, and the history keeps whose it was (decision 203).
      const takesOver = place.decided_by_actor_id !== person.actorId;
      await tx.query(
        `update decisions
         set statement = $2, reason = $3, area = $4, wording_version = wording_version + 1,
             updated_at = now()
         where id = $1`,
        [decisionId, after.statement, after.reason, after.area],
      );
      if (takesOver) {
        await tx.query(
          `update decisions
           set decided_by_source = $2, decided_by_workspace_id = $3, decided_by_actor_id = $4,
               decided_by_name = $5, decided_at = now()
           where id = $1`,
          [decisionId, person.source, person.workspaceId, person.actorId, person.name],
        );
      }
      await recordEvent(tx, decisionId, "edited", person, {
        before: takesOver
          ? {
              ...before,
              decidedBy: { actorId: place.decided_by_actor_id, name: place.decided_by_name },
            }
          : before,
        after,
      });
      return { status: "edited", decision: await current() };
    }

    if (action.kind === "reject") {
      await tx.query(
        `update decisions
         set status = 'rejected', rejected_by_actor_id = $2, rejected_by_name = $3,
             rejected_at = now(), updated_at = now()
         where id = $1`,
        [decisionId, person.actorId, person.name],
      );
      await recordEvent(tx, decisionId, "rejected", person);
      return { status: "rejected", decision: await current() };
    }

    await tx.query(
      `update decisions
       set status = 'active', confirmed_by_source = $2, confirmed_by_workspace_id = $3,
           confirmed_by_actor_id = $4, confirmed_by_name = $5, confirmed_at = now(),
           updated_at = now()
       where id = $1`,
      [decisionId, person.source, person.workspaceId, person.actorId, person.name],
    );
    await recordEvent(tx, decisionId, "confirmed", person);
    let replaced: { number: number; stillActive: boolean } | undefined;
    if (place.supersedes_id !== null) {
      const old = await tx.query(
        `select number::float8 as number, status from decisions where id = $1 for update`,
        [place.supersedes_id],
      );
      const o = z.object({ number: z.number(), status: z.string() }).parse(one(old));
      // Only a decision still active is replaced; one superseded meanwhile is left as it is.
      if (o.status === "active") {
        await tx.query(
          `update decisions set status = 'superseded', updated_at = now() where id = $1`,
          [place.supersedes_id],
        );
        await recordEvent(tx, place.supersedes_id, "superseded", person);
      }
      replaced = { number: o.number, stillActive: o.status === "active" };
    }
    return { status: "confirmed", decision: await current(), replaced };
  });
}

/** Confirms a proposal: `actOnProposal` with `confirm`, kept for the Slack route's callers. */
export function confirmDecision(
  db: Db,
  decisionId: string,
  person: DecisionActor,
): Promise<ProposalOutcome> {
  return actOnProposal(db, decisionId, person, { kind: "confirm" });
}

const eventRow = z.object({
  kind: z.enum(["edited", "confirmed", "rejected", "superseded"]),
  actor_id: z.string(),
  actor_name: z.string().nullable(),
  at: z.date(),
  before: wordingRow.nullable(),
  after: wordingRow.nullable(),
});

/** A decision's changes after it was recorded, oldest first. */
export async function decisionHistory(db: Db, decisionId: string): Promise<DecisionEvent[]> {
  const rows = await db.query(
    `select kind, actor_id, actor_name, at, before, after from decision_events
     where decision_id = $1 order by seq`,
    [decisionId],
  );
  return rows.map((r) => {
    const e = eventRow.parse(r);
    return {
      kind: e.kind,
      actor: { actorId: e.actor_id, name: e.actor_name },
      at: e.at.toISOString(),
      before: e.before,
      after: e.after,
    };
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
