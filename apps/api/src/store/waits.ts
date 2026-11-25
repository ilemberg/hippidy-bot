import type { ListWaitsQuery, Wait } from "@hippidy/contracts";
import { z } from "zod";
import type { AreaActor, Place } from "./areas.ts";
import type { Db, Row } from "./db.ts";
import { storable } from "./json.ts";

// The waiting-on list (slice 3.3, decision 210): who waits on whom, for what, since when and
// where. Ended by either of its people, or whoever recorded it; kept after it ends.

/** The most open waits one thread may have (rule 13: attention has a budget). */
export const MAX_OPEN_WAITS_PER_THREAD = 10;

const columns = `w.id, w.number::int as number, w.waiter_actor_id, w.waiter_name,
  w.waiting_on_actor_id, w.waiting_on_name, w.what, w.task_key, w.created_at,
  w.conversation_id, v.channel_id, v.thread_id, w.recorded_by_actor_id, w.recorded_by_name,
  w.ended_by_actor_id, w.ended_by_name, w.ended_at`;
const from = `waits w left join conversations v on v.id = w.conversation_id`;

const waitRow = z.object({
  id: z.string(),
  number: z.number().int(),
  waiter_actor_id: z.string(),
  waiter_name: z.string().nullable(),
  waiting_on_actor_id: z.string(),
  waiting_on_name: z.string().nullable(),
  what: z.string(),
  task_key: z.string().nullable(),
  created_at: z.date(),
  conversation_id: z.string().nullable(),
  channel_id: z.string().nullable(),
  thread_id: z.string().nullable(),
  recorded_by_actor_id: z.string(),
  recorded_by_name: z.string().nullable(),
  ended_by_actor_id: z.string().nullable(),
  ended_by_name: z.string().nullable(),
  ended_at: z.date().nullable(),
});

function toWait(r: Row | undefined): Wait {
  const d = waitRow.parse(r);
  return {
    id: d.id,
    number: d.number,
    waiter: { actorId: d.waiter_actor_id, name: d.waiter_name },
    waitingOn: { actorId: d.waiting_on_actor_id, name: d.waiting_on_name },
    what: d.what,
    taskKey: d.task_key,
    since: d.created_at.toISOString(),
    conversationId: d.conversation_id,
    channelId: d.channel_id,
    threadId: d.thread_id,
    recordedBy: { actorId: d.recorded_by_actor_id, name: d.recorded_by_name },
    status: d.ended_at === null ? "open" : "ended",
    endedBy:
      d.ended_by_actor_id === null ? null : { actorId: d.ended_by_actor_id, name: d.ended_by_name },
    endedAt: d.ended_at?.toISOString() ?? null,
  };
}

/** The workspace's waits: open ones by default, oldest first, so the longest waits lead. */
export async function listWaits(db: Db, place: Place, query: ListWaitsQuery): Promise<Wait[]> {
  const status = query.status ?? "open";
  const rows = await db.query(
    `select ${columns} from ${from}
     where w.source = $1 and w.workspace_id = $2
       and ($3 = 'all' or ($3 = 'open') = (w.ended_at is null))
       and ($4::text is null or w.waiter_actor_id = $4 or w.waiting_on_actor_id = $4)
       and ($5::text is null or w.task_key = $5)
     order by w.ended_at is not null, coalesce(w.ended_at, w.created_at) ${status === "ended" ? "desc" : "asc"}
     limit $6`,
    [
      place.source,
      place.workspaceId,
      status,
      query.person ?? null,
      query.task ?? null,
      query.limit,
    ],
  );
  return rows.map(toWait);
}

/** A wait by its number, in the workspace. */
export async function findWaitByNumber(
  db: Db,
  place: Place,
  number: number,
): Promise<Wait | undefined> {
  const rows = await db.query(
    `select ${columns} from ${from}
     where w.source = $1 and w.workspace_id = $2 and w.number = $3`,
    [place.source, place.workspaceId, number],
  );
  return rows[0] === undefined ? undefined : toWait(rows[0]);
}

/** How many waits are open in a thread. */
export async function openWaitsIn(db: Db, conversationId: string): Promise<number> {
  const rows = await db.query(
    `select count(*)::int as n from waits where conversation_id = $1 and ended_at is null`,
    [conversationId],
  );
  return z.object({ n: z.number() }).parse(rows[0]).n;
}

/** Records a wait; with a tool call's id, once per call. */
export async function recordWait(
  db: Db,
  input: {
    place: Place;
    waiter: { actorId: string; name: string | null };
    waitingOn: { actorId: string; name: string | null };
    what: string;
    taskKey: string | null;
    conversationId: string | null;
    recordedBy: { actorId: string; name: string | null };
    customToolUseId?: string | undefined;
  },
): Promise<{ wait: Wait; created: boolean }> {
  const inserted = await db.query(
    `insert into waits (source, workspace_id, waiter_actor_id, waiter_name, waiting_on_actor_id,
       waiting_on_name, what, task_key, conversation_id, recorded_by_actor_id, recorded_by_name,
       custom_tool_use_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (custom_tool_use_id) do nothing
     returning id`,
    [
      input.place.source,
      input.place.workspaceId,
      input.waiter.actorId,
      input.waiter.name,
      input.waitingOn.actorId,
      input.waitingOn.name,
      storable(input.what).trim(),
      input.taskKey,
      input.conversationId,
      input.recordedBy.actorId,
      input.recordedBy.name,
      input.customToolUseId ?? null,
    ],
  );
  const created = inserted[0] !== undefined;
  const rows = await db.query(
    `select ${columns} from ${from} where ${created ? "w.id = $1" : "w.custom_tool_use_id = $1"}`,
    [created ? String(inserted[0]?.id) : (input.customToolUseId ?? "")],
  );
  return { wait: toWait(rows[0]), created };
}

export type EndOutcome =
  | { status: "ended" | "already_ended"; wait: Wait }
  | { status: "not_allowed"; wait: Wait }
  | { status: "not_found"; wait?: undefined };

/**
 * Ends a wait, as a person who is part of it (the waiter, the person waited on, or whoever
 * recorded it); `anyone` lets the thread it was recorded in end it through the teammate.
 */
export async function endWait(
  db: Db,
  actor: AreaActor,
  where: { id: string } | { number: number; conversationId: string },
): Promise<EndOutcome> {
  return db.transaction(async (tx) => {
    const rows =
      "id" in where
        ? await tx.query(
            `select ${columns} from ${from}
             where w.id = $1 and w.source = $2 and w.workspace_id = $3 for update of w`,
            [where.id, actor.source, actor.workspaceId],
          )
        : await tx.query(
            `select ${columns} from ${from}
             where w.number = $1 and w.conversation_id = $2 for update of w`,
            [where.number, where.conversationId],
          );
    if (rows[0] === undefined) return { status: "not_found" };
    const wait = toWait(rows[0]);
    if (wait.status === "ended") return { status: "already_ended", wait };
    // From the web app, only its people; in its own thread, anyone there may say it is done.
    const part = [wait.waiter.actorId, wait.waitingOn.actorId, wait.recordedBy.actorId];
    if ("id" in where && !part.includes(actor.actorId)) return { status: "not_allowed", wait };
    await tx.query(
      `update waits set ended_by_actor_id = $2, ended_by_name = $3, ended_at = now() where id = $1`,
      [wait.id, actor.actorId, actor.name],
    );
    const after = await tx.query(`select ${columns} from ${from} where w.id = $1`, [wait.id]);
    return { status: "ended", wait: toWait(after[0]) };
  });
}
