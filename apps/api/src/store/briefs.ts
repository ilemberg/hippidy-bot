import type { Brief, BriefLine, BriefSection, BriefSectionKind } from "@hippidy/contracts";
import { z } from "zod";
import type { Place } from "./areas.ts";
import type { Db, Row } from "./db.ts";
import { storable } from "./json.ts";

// Daily briefs (slice 3.4, decision 212): who gets one, what it says, and each one sent. Built
// from the records with no model and no call to the source.

/** The most lines a section shows; the rest are counted. */
export const LINES_PER_SECTION = 5;
/** How far back a brief looks when the last one was long ago, or never. */
export const LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

/** A person who may get a brief, and what is known of them. */
export interface BriefPerson {
  actorId: string;
  timeZone: string | null;
  timeZoneCheckedAt: Date | null;
  stopped: boolean;
}

/**
 * Who may get a brief (G13): everyone who has written to the bot, owns an area, or is waited on,
 * with their time zone and whether they said "stop briefs".
 */
export async function briefPeople(db: Db, place: Place): Promise<BriefPerson[]> {
  const rows = await db.query(
    `with people as (
       select actor_id from inbound_messages where source = $1 and workspace_id = $2
       union
       select owner_actor_id from areas
       where source = $1 and workspace_id = $2 and owner_actor_id is not null
       union
       select waiting_on_actor_id from waits
       where source = $1 and workspace_id = $2 and ended_at is null
     )
     select p.actor_id, b.time_zone, b.time_zone_checked_at, b.stopped_at is not null as stopped
     from people p
     left join brief_people b
       on b.source = $1 and b.workspace_id = $2 and b.actor_id = p.actor_id
     order by p.actor_id`,
    [place.source, place.workspaceId],
  );
  return rows.map((r) => {
    const d = z
      .object({
        actor_id: z.string(),
        time_zone: z.string().nullable(),
        time_zone_checked_at: z.date().nullable(),
        stopped: z.boolean(),
      })
      .parse(r);
    return {
      actorId: d.actor_id,
      timeZone: d.time_zone,
      timeZoneCheckedAt: d.time_zone_checked_at,
      stopped: d.stopped,
    };
  });
}

/** One person's settings, as `briefPeople` gives them, whether or not they qualify. */
export async function briefPerson(
  db: Db,
  place: Place,
  actorId: string,
): Promise<BriefPerson & { lastSentAt: Date | null }> {
  const rows = await db.query(
    `select b.time_zone, b.time_zone_checked_at, b.stopped_at is not null as stopped,
            (select max(sent_at) from briefs s
             where s.source = $1 and s.workspace_id = $2 and s.actor_id = $3) as last_sent_at
     from (select 1) one
     left join brief_people b on b.source = $1 and b.workspace_id = $2 and b.actor_id = $3`,
    [place.source, place.workspaceId, actorId],
  );
  const d = z
    .object({
      time_zone: z.string().nullable(),
      time_zone_checked_at: z.date().nullable(),
      stopped: z.boolean().nullable(),
      last_sent_at: z.date().nullable(),
    })
    .parse(rows[0]);
  return {
    actorId,
    timeZone: d.time_zone,
    timeZoneCheckedAt: d.time_zone_checked_at,
    stopped: d.stopped === true,
    lastSentAt: d.last_sent_at,
  };
}

/** "stop briefs" (off) or "start briefs" (on), as the person. */
export async function setBriefs(db: Db, place: Place, actorId: string, on: boolean): Promise<void> {
  await db.query(
    `insert into brief_people (source, workspace_id, actor_id, stopped_at)
     values ($1, $2, $3, case when $4 then null else now() end)
     on conflict (source, workspace_id, actor_id) do update
       set stopped_at = case when $4 then null else coalesce(brief_people.stopped_at, now()) end,
           updated_at = now()`,
    [place.source, place.workspaceId, actorId, on],
  );
}

/** Keeps a person's time zone as the source said it (null: it could not say). */
export async function setTimeZone(
  db: Db,
  place: Place,
  actorId: string,
  timeZone: string | null,
): Promise<void> {
  await db.query(
    `insert into brief_people (source, workspace_id, actor_id, time_zone, time_zone_checked_at)
     values ($1, $2, $3, $4, now())
     on conflict (source, workspace_id, actor_id) do update
       set time_zone = coalesce($4, brief_people.time_zone), time_zone_checked_at = now(),
           updated_at = now()`,
    [place.source, place.workspaceId, actorId, timeZone],
  );
}

/** Where a line leads: the web app's pages, and Slack threads. */
export interface Links {
  web: (path: string) => string | null;
  thread: (channelId: string, threadId: string) => string | null;
}

/** Links to the web app at `webBaseUrl`, and to Slack's threads. */
export function linksFor(webBaseUrl: string | undefined): Links {
  return {
    web: (path) => (webBaseUrl === undefined ? null : `${webBaseUrl}${path}`),
    thread: (channelId, threadId) =>
      `https://slack.com/archives/${encodeURIComponent(channelId)}/p${threadId.replace(".", "")}`,
  };
}

function ago(from: Date, now: Date): string {
  const hours = Math.floor((now.getTime() - from.getTime()) / 3_600_000);
  if (hours < 1) return "under an hour";
  if (hours < 48) return `${String(hours)} hour${hours === 1 ? "" : "s"}`;
  return `${String(Math.floor(hours / 24))} days`;
}

function clip(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const TITLES: Record<BriefSectionKind, string> = {
  waiting_on_you: "Waiting on you",
  to_decide: "Yours to decide",
  in_your_areas: "In your areas",
  your_areas: "Your areas",
  you_wait_on: "You are waiting on",
};

function section(kind: BriefSectionKind, lines: BriefLine[]): BriefSection | undefined {
  if (lines.length === 0) return undefined;
  return {
    kind,
    title: TITLES[kind],
    lines: lines.slice(0, LINES_PER_SECTION),
    more: Math.max(0, lines.length - LINES_PER_SECTION),
  };
}

const s = z.string();
const parseRows = <T extends z.ZodType>(rows: Row[], schema: T): z.infer<T>[] =>
  rows.map((r) => schema.parse(r));

/** A person's brief now: what is new since `since`, and what waits on them whenever it began. */
export async function buildBrief(
  db: Db,
  place: Place,
  actorId: string,
  since: Date,
  now: Date,
  links: Links,
): Promise<Brief> {
  const p = [place.source, place.workspaceId, actorId];

  const waitingOnYou = parseRows(
    await db.query(
      `select number::int as number, waiter_actor_id, waiter_name, what, created_at
       from waits where source = $1 and workspace_id = $2 and waiting_on_actor_id = $3
         and ended_at is null
       order by created_at limit 20`,
      p,
    ),
    z.object({
      number: z.number(),
      waiter_actor_id: s,
      waiter_name: s.nullable(),
      what: s,
      created_at: z.date(),
    }),
  ).map((w) => ({
    text: `${w.waiter_name ?? w.waiter_actor_id} is waiting on you: ${clip(w.what)} (${ago(w.created_at, now)})`,
    href: links.web("/waits"),
  }));

  const conflicts = parseRows(
    await db.query(
      `select number::int as number, summary from conflicts
       where source = $1 and workspace_id = $2 and status = 'open' and $3 = any(deciders)
       order by created_at limit 20`,
      p,
    ),
    z.object({ number: z.number(), summary: s }),
  ).map((c) => ({
    text: `Conflict ${String(c.number)}: ${clip(c.summary)}`,
    href: links.web(`/conflicts/${String(c.number)}`),
  }));

  // Proposals they may confirm: as a decider of a guarded one (3.2), or as the owner, since it
  // was proposed, of an unguarded one's area (3.1).
  const proposals = parseRows(
    await db.query(
      `select d.number::int as number, d.statement from decisions d
       left join conversations v on v.id = d.conversation_id
       where d.status = 'proposed'
         and coalesce(v.source, d.decided_by_source) = $1
         and coalesce(v.workspace_id, d.decided_by_workspace_id) = $2
         and ($3 = any(d.deciders) or (d.deciders is null and exists (
           select 1 from areas a
           where a.source = $1 and a.workspace_id = $2 and a.name = lower(d.area)
             and a.owner_actor_id = $3 and a.owner_since <= d.created_at)))
       order by d.created_at limit 20`,
      p,
    ),
    z.object({ number: z.number(), statement: s }),
  ).map((d) => ({
    text: `Decision ${String(d.number)} waits for you to confirm: ${clip(d.statement)}`,
    href: links.web(`/decisions/${String(d.number)}`),
  }));

  // New in the areas they own: decisions recorded or proposed (not those listed above), and
  // changes named for them.
  const decided = parseRows(
    await db.query(
      `select d.number::int as number, d.statement, d.status from decisions d
       join areas a on a.source = $1 and a.workspace_id = $2 and a.name = lower(d.area)
         and a.owner_actor_id = $3
       left join conversations v on v.id = d.conversation_id
       where d.created_at >= $4 and d.status in ('active', 'proposed')
         and coalesce(v.source, d.decided_by_source) = $1
         and coalesce(v.workspace_id, d.decided_by_workspace_id) = $2
         and not ($3 = any(coalesce(d.deciders, '{}')))
         and not (d.deciders is null and d.status = 'proposed' and a.owner_since <= d.created_at)
       order by d.created_at limit 20`,
      [...p, since],
    ),
    z.object({ number: z.number(), statement: s, status: s }),
  ).map((d) => ({
    text: `Decision ${String(d.number)} ${d.status === "active" ? "recorded" : "proposed"}: ${clip(d.statement)}`,
    href: links.web(`/decisions/${String(d.number)}`),
  }));
  const changed = parseRows(
    await db.query(
      `select a.name, v.channel_id, v.thread_id,
              (select b.title from change_briefs b where b.change_id = c.id
               order by b.created_at desc limit 1) as title
       from change_areas ca
       join areas a on a.id = ca.area_id
       join changes c on c.id = ca.change_id
       join conversations v on v.id = c.conversation_id
       where a.source = $1 and a.workspace_id = $2 and a.owner_actor_id = $3
         and ca.named_at >= $4
       order by ca.named_at limit 20`,
      [...p, since],
    ),
    z.object({ name: s, channel_id: s, thread_id: s, title: s.nullable() }),
  ).map((c) => ({
    text: `A change touched ${c.name}: ${clip(c.title ?? "untitled")}`,
    href: links.thread(c.channel_id, c.thread_id),
  }));

  // An area whose owner became, or stopped being, them.
  const owners = parseRows(
    await db.query(
      `select a.name, e.before -> 'owner' ->> 'actorId' as before_id,
              e.after -> 'owner' ->> 'actorId' as after_id, e.actor_name, e.actor_id
       from area_events e join areas a on a.id = e.area_id
       where a.source = $1 and a.workspace_id = $2 and e.at >= $4 and e.kind = 'edited'
         and (e.before -> 'owner' ->> 'actorId' = $3 or e.after -> 'owner' ->> 'actorId' = $3)
         and (e.before -> 'owner' ->> 'actorId') is distinct from (e.after -> 'owner' ->> 'actorId')
       order by e.seq limit 20`,
      [...p, since],
    ),
    z.object({
      name: s,
      before_id: s.nullable(),
      after_id: s.nullable(),
      actor_name: s.nullable(),
      actor_id: s,
    }),
  ).map((o) => ({
    text:
      o.after_id === actorId
        ? `You now own ${o.name} (set by ${o.actor_name ?? o.actor_id})`
        : `You no longer own ${o.name} (changed by ${o.actor_name ?? o.actor_id})`,
    href: links.web(`/areas/${encodeURIComponent(o.name)}`),
  }));

  const youWaitOn = parseRows(
    await db.query(
      `select waiting_on_actor_id, waiting_on_name, what, created_at
       from waits where source = $1 and workspace_id = $2 and waiter_actor_id = $3
         and ended_at is null
       order by created_at limit 20`,
      p,
    ),
    z.object({
      waiting_on_actor_id: s,
      waiting_on_name: s.nullable(),
      what: s,
      created_at: z.date(),
    }),
  ).map((w) => ({
    text: `${w.waiting_on_name ?? w.waiting_on_actor_id}: ${clip(w.what)} (${ago(w.created_at, now)})`,
    href: links.web("/waits"),
  }));

  return {
    since: since.toISOString(),
    sections: [
      section("waiting_on_you", waitingOnYou),
      section("to_decide", [...conflicts, ...proposals]),
      section("in_your_areas", [...decided, ...changed]),
      section("your_areas", owners),
      section("you_wait_on", youWaitOn),
    ].filter((x) => x !== undefined),
  };
}

/** The brief as Markdown, for a direct message. */
export function briefText(brief: Brief): string {
  const parts = brief.sections.map((sec) => {
    const lines = sec.lines.map((l) =>
      l.href === null ? `- ${l.text}` : `- [${l.text.replace(/[[\]]/g, "")}](${l.href})`,
    );
    if (sec.more > 0) lines.push(`- and ${String(sec.more)} more`);
    return `**${sec.title}**\n${lines.join("\n")}`;
  });
  return storable(
    `Your brief for today.\n\n${parts.join("\n\n")}\n\n_Reply stop briefs to stop these._`,
  ).slice(0, 20000);
}

/** One brief's row for a person and local day. */
export interface BriefRow {
  id: string;
  status: "empty" | "pending" | "sent" | "abandoned";
  text: string | null;
  attempts: number;
}

/**
 * The day's row for a person, made if missing with what to send (null text: nothing new, so
 * nothing is sent). Answers the row as it is now.
 */
export async function claimBrief(
  db: Db,
  place: Place,
  actorId: string,
  localDate: string,
  text: string | null,
): Promise<BriefRow> {
  await db.query(
    `insert into briefs (source, workspace_id, actor_id, local_date, status, text)
     values ($1, $2, $3, $4::date, $5, $6)
     on conflict (source, workspace_id, actor_id, local_date) do nothing`,
    [
      place.source,
      place.workspaceId,
      actorId,
      localDate,
      text === null ? "empty" : "pending",
      text,
    ],
  );
  const rows = await db.query(
    `select id, status, text, attempts from briefs
     where source = $1 and workspace_id = $2 and actor_id = $3 and local_date = $4::date`,
    [place.source, place.workspaceId, actorId, localDate],
  );
  const d = z
    .object({
      id: s,
      status: z.enum(["empty", "pending", "sent", "abandoned"]),
      text: s.nullable(),
      attempts: z.number(),
    })
    .parse(rows[0]);
  return { id: d.id, status: d.status, text: d.text ?? null, attempts: d.attempts };
}

/** Whether a person's row exists for a local day already. */
export async function briefExists(
  db: Db,
  place: Place,
  actorId: string,
  localDate: string,
): Promise<boolean> {
  const rows = await db.query(
    `select status, attempts from briefs
     where source = $1 and workspace_id = $2 and actor_id = $3 and local_date = $4::date`,
    [place.source, place.workspaceId, actorId, localDate],
  );
  const row = rows[0];
  if (row === undefined) return false;
  // A pending one with sends left is not done: it is tried again.
  return !(row.status === "pending" && Number(row.attempts) < MAX_SEND_ATTEMPTS);
}

/** How many times a brief is tried before it is given up for the day. */
export const MAX_SEND_ATTEMPTS = 3;

export async function markBriefSent(db: Db, id: string): Promise<void> {
  await db.query(
    `update briefs set status = 'sent', sent_at = now(), attempts = attempts + 1,
       last_error = null, updated_at = now()
     where id = $1`,
    [id],
  );
}

export async function markBriefFailed(db: Db, id: string, error: string): Promise<void> {
  await db.query(
    `update briefs
     set attempts = attempts + 1, last_error = $2, updated_at = now(),
         status = case when attempts + 1 >= $3 then 'abandoned' else status end
     where id = $1`,
    [id, storable(error).slice(0, 500), MAX_SEND_ATTEMPTS],
  );
}

/** When a person's last brief went, if ever. */
export async function lastBriefSent(db: Db, place: Place, actorId: string): Promise<Date | null> {
  const rows = await db.query(
    `select max(sent_at) as at from briefs
     where source = $1 and workspace_id = $2 and actor_id = $3`,
    [place.source, place.workspaceId, actorId],
  );
  return z.object({ at: z.date().nullable() }).parse(rows[0]).at;
}
