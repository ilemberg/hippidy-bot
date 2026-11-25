import type {
  Conflict,
  ConflictDetail,
  ConflictOutcome,
  ConflictRefusal,
  ListConflictsQuery,
  SettleConflictRequest,
} from "@hippidy/contracts";
import { z } from "zod";
import { findAreaByName, listPeople, type Place } from "./areas.ts";
import type { Db, Row } from "./db.ts";
import { storable, toJsonText } from "./json.ts";

// Conflicts and who decides them (slice 3.2, decision 208). The deciders are fixed when a
// conflict, or a guarded proposal, is recorded: a later change of an area's owner does not take
// over what already waits.

/** Who decides, and why them. */
export interface Decider {
  actorId: string;
  /** `owner`: of the area; `fallback`: `FALLBACK_OWNER`; `decider`: made the decision replaced. */
  role: "owner" | "fallback" | "decider";
}

/** Who decides a conflict in an area, or a replacement of a decision. */
export async function decidersFor(
  db: Db,
  place: Place,
  input: { area: string | null; replacedDecider?: string | null | undefined },
  fallback: { actorId: string } | undefined,
): Promise<Decider[]> {
  const out: Decider[] = [];
  const area = input.area === null ? undefined : await findAreaByName(db, place, input.area);
  if (area?.owner != null) out.push({ actorId: area.owner.actorId, role: "owner" });
  else if (fallback !== undefined) out.push({ actorId: fallback.actorId, role: "fallback" });
  const replaced = input.replacedDecider;
  if (replaced != null && !out.some((d) => d.actorId === replaced)) {
    out.push({ actorId: replaced, role: "decider" });
  }
  return out;
}

/** A position as kept: who, their latest name, and what they want. */
export interface Position {
  actorId: string;
  name: string | null;
  says: string;
}

/** Records a conflict; with a tool call's id, once per call. Answers its id and number. */
export async function recordConflict(
  db: Db,
  input: {
    place: Place;
    kind: "replacement" | "raised" | "capture";
    summary: string;
    conversationId: string | null;
    channelId: string | null;
    threadId: string | null;
    area: string | null;
    decisionIds: readonly string[];
    proposalId: string | null;
    positions: readonly Position[];
    deciders: readonly string[];
    customToolUseId?: string | undefined;
  },
): Promise<{ id: string; number: number; created: boolean }> {
  const inserted = await db.query(
    `insert into conflicts (source, workspace_id, kind, summary, conversation_id, channel_id,
       thread_id, area, decision_ids, proposal_id, positions, deciders, custom_tool_use_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid[], $10, $11::text::jsonb, $12::text[], $13)
     on conflict do nothing
     returning id, number::int as number`,
    [
      input.place.source,
      input.place.workspaceId,
      input.kind,
      storable(input.summary).slice(0, 600),
      input.conversationId,
      input.channelId,
      input.threadId,
      input.area,
      input.decisionIds,
      input.proposalId,
      toJsonText(input.positions.map((p) => ({ ...p, says: storable(p.says) }))),
      [...new Set(input.deciders)],
      input.customToolUseId ?? null,
    ],
  );
  const idRow = z.object({ id: z.string(), number: z.number() });
  if (inserted[0] !== undefined) return { ...idRow.parse(inserted[0]), created: true };
  // Already recorded: by this call, or for this proposal.
  const existing = await db.query(
    `select id, number::int as number from conflicts
     where custom_tool_use_id = $1 or proposal_id = $2`,
    [input.customToolUseId ?? null, input.proposalId],
  );
  return { ...idRow.parse(existing[0]), created: false };
}

/** How many conflicts are open in a thread. */
export async function openConflictsIn(db: Db, conversationId: string): Promise<number> {
  const rows = await db.query(
    `select count(*)::int as n from conflicts where conversation_id = $1 and status = 'open'`,
    [conversationId],
  );
  return z.object({ n: z.number() }).parse(rows[0]).n;
}

const columns = `c.id, c.number::int as number, c.kind, c.summary, c.area, c.decision_ids,
  c.proposal_id, c.positions, c.deciders, c.status, c.outcome, c.note, c.settled_by_actor_id,
  c.settled_by_name, c.settled_at, c.conversation_id,
  coalesce(c.channel_id, v.channel_id) as channel_id,
  coalesce(c.thread_id, v.thread_id) as thread_id, c.created_at`;
const from = `conflicts c left join conversations v on v.id = c.conversation_id`;

const conflictRow = z.object({
  id: z.string(),
  number: z.number().int(),
  kind: z.enum(["replacement", "raised", "capture"]),
  summary: z.string(),
  area: z.string().nullable(),
  decision_ids: z.array(z.string()),
  proposal_id: z.string().nullable(),
  positions: z.array(
    z.object({ actorId: z.string(), name: z.string().nullable(), says: z.string() }),
  ),
  deciders: z.array(z.string()),
  status: z.enum(["open", "settled"]),
  outcome: z.enum(["kept", "changed", "dismissed"]).nullable(),
  note: z.string().nullable(),
  settled_by_actor_id: z.string().nullable(),
  settled_by_name: z.string().nullable(),
  settled_at: z.date().nullable(),
  conversation_id: z.string().nullable(),
  channel_id: z.string().nullable(),
  thread_id: z.string().nullable(),
  created_at: z.date(),
});
type ConflictRow = z.infer<typeof conflictRow>;

function parseRow(row: Row): ConflictRow {
  const positions: unknown =
    typeof row.positions === "string" ? JSON.parse(row.positions) : row.positions;
  return conflictRow.parse({ ...row, positions });
}

const refRow = z.object({
  id: z.string(),
  number: z.number(),
  statement: z.string(),
  status: z.enum(["proposed", "active", "superseded", "rejected"]),
  decided_by_actor_id: z.string().nullable(),
  decided_by_name: z.string().nullable(),
});

/** Turns rows into conflicts, reading their decisions and the people's names in two queries. */
async function toConflicts(db: Db, place: Place, rows: readonly Row[]): Promise<Conflict[]> {
  const parsed = rows.map(parseRow);
  const ids = [
    ...new Set(
      parsed.flatMap((r) => [
        ...r.decision_ids,
        ...(r.proposal_id === null ? [] : [r.proposal_id]),
      ]),
    ),
  ];
  const refs = new Map(
    (ids.length === 0
      ? []
      : await db.query(
          `select id, number::float8 as number, statement, status, decided_by_actor_id,
                  decided_by_name
           from decisions where id = any($1::uuid[])`,
          [ids],
        )
    ).map((r) => {
      const d = refRow.parse(r);
      return [
        d.id,
        {
          number: d.number,
          statement: d.statement,
          status: d.status,
          decidedBy: { actorId: d.decided_by_actor_id, name: d.decided_by_name },
        },
      ] as const;
    }),
  );
  const people = parsed.some((r) => r.deciders.length > 0) ? await listPeople(db, place) : [];
  const nameOf = (actorId: string) => people.find((p) => p.actorId === actorId)?.name ?? null;
  return parsed.map((r) => {
    const proposal = r.proposal_id === null ? undefined : refs.get(r.proposal_id);
    return {
      id: r.id,
      number: r.number,
      kind: r.kind,
      summary: r.summary,
      area: r.area,
      decisions: r.decision_ids.flatMap((id) => {
        const ref = refs.get(id);
        return ref === undefined ? [] : [ref];
      }),
      proposal: proposal ?? null,
      positions: r.positions,
      deciders: r.deciders.map((actorId) => ({ actorId, name: nameOf(actorId) })),
      status: r.status,
      outcome: r.outcome,
      note: r.note,
      settledBy:
        r.settled_by_actor_id === null
          ? null
          : { actorId: r.settled_by_actor_id, name: r.settled_by_name },
      settledAt: r.settled_at?.toISOString() ?? null,
      conversationId: r.conversation_id,
      channelId: r.channel_id,
      threadId: r.thread_id,
      createdAt: r.created_at.toISOString(),
    };
  });
}

/** The workspace's conflicts: open ones first, newest first. */
export async function listConflicts(
  db: Db,
  place: Place,
  query: ListConflictsQuery,
): Promise<Conflict[]> {
  const status = query.status ?? "open";
  const rows = await db.query(
    `select ${columns} from ${from}
     where c.source = $1 and c.workspace_id = $2
       and ($3 = 'all' or c.status = $3)
       and ($4::bigint is null or exists (
         select 1 from decisions d
         where d.number = $4::bigint and (d.id = any(c.decision_ids) or d.id = c.proposal_id)))
     order by c.status = 'open' desc, c.created_at desc
     limit $5`,
    [place.source, place.workspaceId, status, query.decision ?? null, query.limit],
  );
  return toConflicts(db, place, rows);
}

/** One conflict by its number, in the workspace. */
export async function findConflictByNumber(
  db: Db,
  place: Place,
  number: number,
): Promise<Conflict | undefined> {
  const rows = await db.query(
    `select ${columns} from ${from}
     where c.source = $1 and c.workspace_id = $2 and c.number = $3`,
    [place.source, place.workspaceId, number],
  );
  return (await toConflicts(db, place, rows))[0];
}

/** Why a person may not settle a conflict here; null when they may. */
function refusal(conflict: Conflict, actorId: string): ConflictRefusal | null {
  if (conflict.status === "settled") return "settled";
  if (conflict.proposal !== null) return "has_proposal";
  if (!conflict.deciders.some((d) => d.actorId === actorId)) return "not_decider";
  return null;
}

/** A conflict, and whether this person may settle it. */
export async function conflictDetail(
  db: Db,
  place: Place,
  number: number,
  actorId: string | undefined,
): Promise<ConflictDetail | undefined> {
  const conflict = await findConflictByNumber(db, place, number);
  if (conflict === undefined) return undefined;
  const reason = actorId === undefined ? "not_decider" : refusal(conflict, actorId);
  return { conflict, youMay: { settle: reason === null, reason } };
}

export type SettleOutcome =
  | { status: "settled"; conflict: Conflict }
  | { status: "not_allowed"; reason: ConflictRefusal; conflict: Conflict }
  | { status: "not_found"; conflict?: undefined };

/** A decider settles a conflict that has no proposal: kept, changed or dismissed, with a note. */
export async function settleConflict(
  db: Db,
  person: Place & { actorId: string; name: string | null },
  conflictId: string,
  request: SettleConflictRequest,
): Promise<SettleOutcome> {
  return db.transaction(async (tx) => {
    const rows = await tx.query(
      `select ${columns} from ${from}
       where c.id = $1 and c.source = $2 and c.workspace_id = $3
       for update of c`,
      [conflictId, person.source, person.workspaceId],
    );
    const [conflict] = await toConflicts(tx, person, rows);
    if (conflict === undefined) return { status: "not_found" };
    const reason = refusal(conflict, person.actorId);
    if (reason !== null) return { status: "not_allowed", reason, conflict };
    await tx.query(
      `update conflicts
       set status = 'settled', outcome = $2, note = $3, settled_by_actor_id = $4,
           settled_by_name = $5, settled_at = now(), updated_at = now()
       where id = $1`,
      [
        conflictId,
        request.outcome,
        request.note === undefined || request.note === "" ? null : storable(request.note),
        person.actorId,
        person.name,
      ],
    );
    const after = await findConflictByNumber(tx, person, conflict.number);
    return { status: "settled", conflict: after ?? conflict };
  });
}

/**
 * Settles the conflict over a proposal when the proposal is confirmed (`changed`) or rejected
 * (`kept`). Inside the caller's transaction.
 */
export async function settleProposalConflict(
  db: Db,
  proposalId: string,
  outcome: ConflictOutcome,
  person: { actorId: string; name: string | null },
): Promise<void> {
  await db.query(
    `update conflicts
     set status = 'settled', outcome = $2, settled_by_actor_id = $3, settled_by_name = $4,
         settled_at = now(), updated_at = now()
     where proposal_id = $1 and status = 'open'`,
    [proposalId, outcome, person.actorId, person.name],
  );
}
