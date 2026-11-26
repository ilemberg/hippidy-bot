import type {
  CreateTaskRequest,
  EditTaskRequest,
  Task,
  TaskEvent,
  TaskStatus,
} from "@hippidy/contracts";
import { z } from "zod";
import { knownName, type AreaActor, type Place } from "./areas.ts";
import type { Db, Row } from "./db.ts";
import { storable, toJsonText } from "./json.ts";

// The built-in tracker (slice 3.3, decision 210), and the task a thread works on. A signed-in
// person creates and edits a task as themselves, on the version they saw; every change is kept.

const STATUS_NAMES: Record<TaskStatus, string> = {
  todo: "To do",
  doing: "Doing",
  done: "Done",
};

/** A built-in task's key: `T-12`. */
export function builtinKey(number: number): string {
  return `T-${String(number)}`;
}

/** The number in a built-in key, or undefined. */
export function builtinNumber(key: string): number | undefined {
  const match = /^T-([1-9][0-9]{0,8})$/i.exec(key.trim());
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

const columns = `id, number::int as number, title, description, status, assignee_actor_id,
  assignee_name, version, created_by_actor_id, created_by_name, created_at, updated_at`;

const taskRow = z.object({
  id: z.string(),
  number: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.enum(["todo", "doing", "done"]),
  assignee_actor_id: z.string().nullable(),
  assignee_name: z.string().nullable(),
  version: z.number().int(),
  created_by_actor_id: z.string(),
  created_by_name: z.string().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});
export type BuiltinTask = z.infer<typeof taskRow>;

export function toTask(row: BuiltinTask): Task {
  return {
    key: builtinKey(row.number),
    title: row.title,
    status: row.status,
    statusName: STATUS_NAMES[row.status],
    assignee:
      row.assignee_actor_id === null
        ? null
        : { actorId: row.assignee_actor_id, name: row.assignee_name },
    url: null,
    updatedAt: row.updated_at.toISOString(),
  };
}

const parse = (r: Row | undefined) => taskRow.parse(r);

/** The workspace's built-in tasks: not done first, by latest change. */
export async function listBuiltinTasks(
  db: Db,
  place: Place,
  query: { q?: string | undefined; status: string; limit: number },
): Promise<BuiltinTask[]> {
  const rows = await db.query(
    `select ${columns} from tasks
     where source = $1 and workspace_id = $2
       and ($3 = 'all' or ($3 = 'open' and status <> 'done') or status = $3)
       and ($4::text is null or search @@ websearch_to_tsquery('english', $4::text)
            or title ilike '%' || $4::text || '%')
     order by status = 'done', updated_at desc
     limit $5`,
    [place.source, place.workspaceId, query.status, query.q ?? null, query.limit],
  );
  return rows.map(parse);
}

/** One built-in task by key, in the workspace. */
export async function findBuiltinTask(
  db: Db,
  place: Place,
  key: string,
): Promise<BuiltinTask | undefined> {
  const number = builtinNumber(key);
  if (number === undefined) return undefined;
  const rows = await db.query(
    `select ${columns} from tasks where source = $1 and workspace_id = $2 and number = $3`,
    [place.source, place.workspaceId, number],
  );
  return rows[0] === undefined ? undefined : parse(rows[0]);
}

const eventRow = z.object({
  kind: z.enum(["created", "edited"]),
  actor_id: z.string(),
  actor_name: z.string().nullable(),
  at: z.date(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()),
});

/** A built-in task's changes, oldest first. */
export async function taskHistory(db: Db, taskId: string): Promise<TaskEvent[]> {
  const rows = await db.query(
    `select kind, actor_id, actor_name, at, before, after from task_events
     where task_id = $1 order by seq`,
    [taskId],
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

interface Fields {
  title: string;
  description: string | null;
  status: TaskStatus;
  assignee: { actorId: string; name: string | null } | null;
}

function fieldsOf(row: BuiltinTask): Fields {
  return {
    title: row.title,
    description: row.description,
    status: row.status,
    assignee:
      row.assignee_actor_id === null
        ? null
        : { actorId: row.assignee_actor_id, name: row.assignee_name },
  };
}

async function recordEvent(
  db: Db,
  taskId: string,
  kind: "created" | "edited",
  actor: AreaActor,
  before: Fields | null,
  after: Fields,
): Promise<void> {
  await db.query(
    `insert into task_events (task_id, kind, actor_id, actor_name, before, after)
     values ($1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb)`,
    [
      taskId,
      kind,
      actor.actorId,
      actor.name,
      before === null ? null : toJsonText(before),
      toJsonText(after),
    ],
  );
}

async function assigneeName(db: Db, actor: AreaActor, actorId: string): Promise<string | null> {
  return (await knownName(db, actor, actorId)) ?? (actorId === actor.actorId ? actor.name : null);
}

function emptyToNull(text: string | null | undefined): string | null {
  if (text == null) return null;
  const clean = storable(text).trim();
  return clean === "" ? null : clean;
}

export type TaskWrite =
  | { status: "created" | "edited" | "unchanged" | "changed"; row: BuiltinTask }
  | { status: "not_found"; row?: undefined };

/** Creates a built-in task, as the person. */
export async function createTask(
  db: Db,
  actor: AreaActor,
  request: CreateTaskRequest,
): Promise<TaskWrite> {
  return db.transaction(async (tx) => {
    const assignee = request.assigneeActorId ?? null;
    const rows = await tx.query(
      `insert into tasks (source, workspace_id, title, description, status, assignee_actor_id,
         assignee_name, created_by_actor_id, created_by_name)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning ${columns}`,
      [
        actor.source,
        actor.workspaceId,
        storable(request.title).trim(),
        emptyToNull(request.description),
        request.status ?? "todo",
        assignee,
        assignee === null ? null : await assigneeName(tx, actor, assignee),
        actor.actorId,
        actor.name,
      ],
    );
    const row = parse(rows[0]);
    await recordEvent(tx, row.id, "created", actor, null, fieldsOf(row));
    return { status: "created", row };
  });
}

/** Edits a built-in task, as the person, on the version they saw. */
export async function editTask(
  db: Db,
  actor: AreaActor,
  taskId: string,
  request: EditTaskRequest,
): Promise<TaskWrite> {
  return db.transaction(async (tx) => {
    const rows = await tx.query(
      `select ${columns} from tasks
       where id = $1 and source = $2 and workspace_id = $3 for update`,
      [taskId, actor.source, actor.workspaceId],
    );
    if (rows[0] === undefined) return { status: "not_found" };
    const current = parse(rows[0]);
    if (current.version !== request.version) return { status: "changed", row: current };
    const before = fieldsOf(current);
    const assigneeId =
      request.assigneeActorId === undefined
        ? (current.assignee_actor_id ?? null)
        : request.assigneeActorId;
    const after: Fields = {
      title: request.title === undefined ? current.title : storable(request.title).trim(),
      description:
        request.description === undefined ? current.description : emptyToNull(request.description),
      status: request.status ?? current.status,
      assignee:
        assigneeId === null
          ? null
          : assigneeId === current.assignee_actor_id
            ? before.assignee
            : { actorId: assigneeId, name: await assigneeName(tx, actor, assigneeId) },
    };
    if (JSON.stringify(after) === JSON.stringify(before)) {
      return { status: "unchanged", row: current };
    }
    const updated = await tx.query(
      `update tasks
       set title = $2, description = $3, status = $4, assignee_actor_id = $5, assignee_name = $6,
           version = version + 1, updated_at = now()
       where id = $1
       returning ${columns}`,
      [
        taskId,
        after.title,
        after.description,
        after.status,
        after.assignee?.actorId ?? null,
        after.assignee?.name ?? null,
      ],
    );
    await recordEvent(tx, taskId, "edited", actor, before, after);
    return { status: "edited", row: parse(updated[0]) };
  });
}

/**
 * Marks a built-in task done, kept in its history as done by `actor` (a goal whose pull request
 * merged, slice 4.4: `job:<name>`). Nothing when it is done already or there is no such task.
 * Answers whether it changed it. Run inside the caller's transaction.
 */
export async function markTaskDone(
  db: Db,
  place: Place,
  key: string,
  actor: AreaActor,
): Promise<boolean> {
  const number = builtinNumber(key);
  if (number === undefined) return false;
  const rows = await db.query(
    `select ${columns} from tasks
     where source = $1 and workspace_id = $2 and number = $3 for update`,
    [place.source, place.workspaceId, number],
  );
  if (rows[0] === undefined) return false;
  const current = parse(rows[0]);
  if (current.status === "done") return false;
  await db.query(
    `update tasks set status = 'done', version = version + 1, updated_at = now() where id = $1`,
    [current.id],
  );
  const before = fieldsOf(current);
  await recordEvent(db, current.id, "edited", actor, before, { ...before, status: "done" });
  return true;
}

/** Links a thread to a task by key (SCRUM-8): one at a time, the latest replacing it. */
export async function linkThreadToTask(db: Db, conversationId: string, key: string): Promise<void> {
  await db.query(`update conversations set task_key = $2, task_linked_at = now() where id = $1`, [
    conversationId,
    key,
  ]);
}

/** The threads linked to a task. */
export async function threadsForTask(
  db: Db,
  place: Place,
  key: string,
): Promise<{ conversationId: string; channelId: string; threadId: string; linkedAt: string }[]> {
  const rows = await db.query(
    `select id, channel_id, thread_id, task_linked_at from conversations
     where source = $1 and workspace_id = $2 and task_key = $3
     order by task_linked_at desc limit 50`,
    [place.source, place.workspaceId, key],
  );
  return rows.map((r) => {
    const d = z
      .object({
        id: z.string(),
        channel_id: z.string(),
        thread_id: z.string(),
        task_linked_at: z.date(),
      })
      .parse(r);
    return {
      conversationId: d.id,
      channelId: d.channel_id,
      threadId: d.thread_id,
      linkedAt: d.task_linked_at.toISOString(),
    };
  });
}
