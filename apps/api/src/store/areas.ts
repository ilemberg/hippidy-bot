import type {
  Area,
  AreaEvent,
  CreateAreaRequest,
  EditAreaRequest,
  MessageSource,
} from "@hippidy/contracts";
import { z } from "zod";
import type { Db, Row } from "./db.ts";
import { storable, toJsonText } from "./json.ts";

// Areas and their owners (slice 3.1, decisions 205 and 206). Anyone signed in may create or
// change one, as themselves, on the version they saw; every change is kept with its before and
// after.

/** The workspace an area belongs to. */
export interface Place {
  source: MessageSource;
  workspaceId: string;
}

/** Who makes a change. */
export interface AreaActor extends Place {
  actorId: string;
  name: string | null;
}

const areaColumns = `id, name, description, owner_actor_id, owner_name, paths, words, version,
  created_by_actor_id, created_by_name, created_at, updated_at`;

const areaRow = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  owner_actor_id: z.string().nullable(),
  owner_name: z.string().nullable(),
  paths: z.array(z.string()),
  words: z.array(z.string()),
  version: z.number().int(),
  created_by_actor_id: z.string(),
  created_by_name: z.string().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});

function toArea(r: Row): Area {
  const d = areaRow.parse(r);
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    owner: d.owner_actor_id === null ? null : { actorId: d.owner_actor_id, name: d.owner_name },
    paths: d.paths,
    words: d.words,
    version: d.version,
    createdBy: { actorId: d.created_by_actor_id, name: d.created_by_name },
    createdAt: d.created_at.toISOString(),
    updatedAt: d.updated_at.toISOString(),
  };
}

/** Every area of the workspace, by name. */
export async function listAreas(db: Db, place: Place): Promise<Area[]> {
  const rows = await db.query(
    `select ${areaColumns} from areas where source = $1 and workspace_id = $2 order by name`,
    [place.source, place.workspaceId],
  );
  return rows.map(toArea);
}

/** One area by its name, any case. */
export async function findAreaByName(
  db: Db,
  place: Place,
  name: string,
): Promise<Area | undefined> {
  const rows = await db.query(
    `select ${areaColumns} from areas where source = $1 and workspace_id = $2 and name = lower($3)`,
    [place.source, place.workspaceId, name.trim()],
  );
  return rows[0] === undefined ? undefined : toArea(rows[0]);
}

const fieldsRow = z.object({
  name: z.string(),
  description: z.string().nullable(),
  owner: z.object({ actorId: z.string(), name: z.string().nullable() }).nullable(),
  paths: z.array(z.string()),
  words: z.array(z.string()),
});

const eventRow = z.object({
  kind: z.enum(["created", "edited"]),
  actor_id: z.string(),
  actor_name: z.string().nullable(),
  at: z.date(),
  before: fieldsRow.nullable(),
  after: fieldsRow,
});

/** An area's changes, oldest first. */
export async function areaHistory(db: Db, areaId: string): Promise<AreaEvent[]> {
  const rows = await db.query(
    `select kind, actor_id, actor_name, at, before, after from area_events
     where area_id = $1 order by seq`,
    [areaId],
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

/** An owner's name: the record's, or the person's own when they name themselves. */
async function ownerName(db: Db, actor: AreaActor, ownerId: string): Promise<string | null> {
  return (await knownName(db, actor, ownerId)) ?? (ownerId === actor.actorId ? actor.name : null);
}

/** The latest name the record knows for a person, if any. */
export async function knownName(db: Db, place: Place, actorId: string): Promise<string | null> {
  const people = await listPeople(db, place);
  return people.find((p) => p.actorId === actorId)?.name ?? null;
}

/**
 * The people the record knows (slice 3.1): who wrote to the bot, owns or made an area, or
 * decided or confirmed something, with the latest name seen. Nobody is looked up in the source for it.
 */
export async function listPeople(
  db: Db,
  place: Place,
): Promise<{ actorId: string; name: string | null }[]> {
  const rows = await db.query(
    `with seen as (
       select actor_id, actor_name as name, created_at as at from inbound_messages
       where source = $1 and workspace_id = $2
       union all
       select owner_actor_id, owner_name, updated_at from areas
       where source = $1 and workspace_id = $2 and owner_actor_id is not null
       union all
       select created_by_actor_id, created_by_name, created_at from areas
       where source = $1 and workspace_id = $2
       union all
       select decided_by_actor_id, decided_by_name, decided_at from decisions
       where decided_by_source = $1 and decided_by_workspace_id = $2
         and decided_by_actor_id is not null
       union all
       select confirmed_by_actor_id, confirmed_by_name, confirmed_at from decisions
       where confirmed_by_source = $1 and confirmed_by_workspace_id = $2
         and confirmed_by_actor_id is not null
     )
     select actor_id,
            (array_agg(name order by at desc) filter (where name is not null))[1] as name
     from seen group by actor_id
     order by lower(coalesce((array_agg(name order by at desc)
                filter (where name is not null))[1], actor_id))`,
    [place.source, place.workspaceId],
  );
  return rows.map((r) => {
    const d = z.object({ actor_id: z.string(), name: z.string().nullable() }).parse(r);
    return { actorId: d.actor_id, name: d.name };
  });
}

type Fields = z.infer<typeof fieldsRow>;

function fieldsOf(area: Area): Fields {
  return {
    name: area.name,
    description: area.description,
    owner: area.owner,
    paths: area.paths,
    words: area.words,
  };
}

/** Trimmed, without empty ones or repeats, in the order given. */
function distinct(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => storable(v).trim()).filter((v) => v !== ""))];
}

async function recordEvent(
  db: Db,
  areaId: string,
  kind: "created" | "edited",
  actor: AreaActor,
  before: Fields | null,
  after: Fields,
): Promise<void> {
  await db.query(
    `insert into area_events (area_id, kind, actor_id, actor_name, before, after)
     values ($1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb)`,
    [
      areaId,
      kind,
      actor.actorId,
      actor.name,
      before === null ? null : toJsonText(before),
      toJsonText(after),
    ],
  );
}

export type AreaWrite =
  | { status: "created" | "edited" | "unchanged" | "changed"; area: Area }
  | { status: "name_taken" | "not_found"; area?: undefined };

/** Creates an area, as the person; a name already taken in the workspace is refused. */
export async function createArea(
  db: Db,
  actor: AreaActor,
  request: CreateAreaRequest,
): Promise<AreaWrite> {
  return db.transaction(async (tx) => {
    const ownerId = request.ownerActorId ?? null;
    const ownerNameNow = ownerId === null ? null : await ownerName(tx, actor, ownerId);
    const rows = await tx.query(
      `insert into areas (source, workspace_id, name, description, owner_actor_id, owner_name,
         owner_since, paths, words, created_by_actor_id, created_by_name)
       values ($1, $2, $3, $4, $5, $6, case when $5::text is null then null else now() end,
         $7::text[], $8::text[], $9, $10)
       on conflict (source, workspace_id, name) do nothing
       returning ${areaColumns}`,
      [
        actor.source,
        actor.workspaceId,
        request.name,
        request.description ? storable(request.description) : null,
        ownerId,
        ownerNameNow,
        distinct(request.paths ?? []),
        distinct((request.words ?? []).map((w) => w.toLowerCase())),
        actor.actorId,
        actor.name,
      ],
    );
    if (rows[0] === undefined) return { status: "name_taken" };
    const area = toArea(rows[0]);
    await recordEvent(tx, area.id, "created", actor, null, fieldsOf(area));
    return { status: "created", area };
  });
}

/**
 * Changes an area, as the person, on the version they saw: one changed since is refused, so no
 * one overwrites a change they did not see. A change that changes nothing records nothing.
 */
export async function editArea(
  db: Db,
  actor: AreaActor,
  areaId: string,
  request: EditAreaRequest,
): Promise<AreaWrite> {
  return editAreaOnce(db, actor, areaId, request).catch((failure: unknown): AreaWrite => {
    // Two renames to one name at once: the second meets the unique name, not the check above.
    if (uniqueViolation(failure)) return { status: "name_taken" };
    throw failure;
  });
}

function uniqueViolation(failure: unknown): boolean {
  return (
    typeof failure === "object" && failure !== null && "code" in failure && failure.code === "23505"
  );
}

async function editAreaOnce(
  db: Db,
  actor: AreaActor,
  areaId: string,
  request: EditAreaRequest,
): Promise<AreaWrite> {
  return db.transaction(async (tx) => {
    const rows = await tx.query(
      `select ${areaColumns} from areas
       where id = $1 and source = $2 and workspace_id = $3 for update`,
      [areaId, actor.source, actor.workspaceId],
    );
    if (rows[0] === undefined) return { status: "not_found" };
    const current = toArea(rows[0]);
    if (current.version !== request.version) return { status: "changed", area: current };
    const before = fieldsOf(current);
    const ownerId =
      request.ownerActorId === undefined ? (current.owner?.actorId ?? null) : request.ownerActorId;
    const after: Fields = {
      name: request.name ?? current.name,
      description:
        request.description === undefined
          ? current.description
          : request.description
            ? storable(request.description)
            : null,
      owner:
        ownerId === null
          ? null
          : ownerId === current.owner?.actorId
            ? current.owner
            : { actorId: ownerId, name: await ownerName(tx, actor, ownerId) },
      paths: request.paths === undefined ? current.paths : distinct(request.paths),
      words:
        request.words === undefined
          ? current.words
          : distinct(request.words.map((w) => w.toLowerCase())),
    };
    if (JSON.stringify(after) === JSON.stringify(before)) {
      return { status: "unchanged", area: current };
    }
    if (after.name !== current.name) {
      const taken = await tx.query(
        `select 1 from areas where source = $1 and workspace_id = $2 and name = $3 and id <> $4`,
        [actor.source, actor.workspaceId, after.name, areaId],
      );
      if (taken.length > 0) return { status: "name_taken" };
    }
    const updated = await tx.query(
      `update areas
       set name = $2, description = $3, owner_actor_id = $4, owner_name = $5,
           owner_since = case when $4::text is null then null
                              when owner_actor_id is distinct from $4 then now()
                              else owner_since end,
           paths = $6::text[], words = $7::text[], version = version + 1, updated_at = now()
       where id = $1
       returning ${areaColumns}`,
      [
        areaId,
        after.name,
        after.description,
        after.owner?.actorId ?? null,
        after.owner?.name ?? null,
        after.paths,
        after.words,
      ],
    );
    // Decisions carry the area as a label: a renamed area keeps its decisions (slice 3.1).
    if (after.name !== current.name) {
      await tx.query(
        `update decisions d set area = $4, updated_at = now()
         from (select d2.id from decisions d2
               left join conversations v on v.id = d2.conversation_id
               where lower(d2.area) = $3
                 and coalesce(v.source, d2.decided_by_source) = $1
                 and coalesce(v.workspace_id, d2.decided_by_workspace_id) = $2) mine
         where d.id = mine.id`,
        [actor.source, actor.workspaceId, current.name, after.name],
      );
    }
    await recordEvent(tx, areaId, "edited", actor, before, after);
    return { status: "edited", area: toArea(updated[0] ?? rows[0]) };
  });
}

/**
 * Notes that a change was said to touch these areas; answers the ones not named before, so
 * each is named once per change whatever names it (a brief, then a pull request).
 */
export async function nameAreasForChange(
  db: Db,
  changeId: string,
  areaIds: readonly string[],
  via: "brief" | "pull_request",
): Promise<string[]> {
  if (areaIds.length === 0) return [];
  const rows = await db.query(
    `insert into change_areas (change_id, area_id, via)
     select $1, unnest($2::uuid[]), $3
     on conflict do nothing
     returning area_id`,
    [changeId, areaIds, via],
  );
  return rows.map((r) => z.object({ area_id: z.string() }).parse(r).area_id);
}
