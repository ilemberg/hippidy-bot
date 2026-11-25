import { messageSourceSchema, activityStateSchema, type SessionActivity } from "@hippidy/contracts";
import { z } from "zod";
import type { Db, Row } from "./db.ts";

// The agents at work (slice 2.4): every thread's own session and every change's coding worker,
// read from the database alone, active first, then the most recently active.

/** The longest title or latest-activity text the list carries. */
export const SNIPPET_CHARACTERS = 200;

const row = z.object({
  kind: z.enum(["thread", "worker"]),
  conversation_id: z.string(),
  change_id: z.string().nullable(),
  title: z.string().nullable(),
  agent: z.enum(["teammate", "engineer", "product", "worker"]),
  state: activityStateSchema,
  asked_by_actor_id: z.string().nullable(),
  asked_by_name: z.string().nullable(),
  project_id: z.string().nullable(),
  project_name: z.string().nullable(),
  latest_at: z.date().nullable(),
  latest_text: z.string().nullable(),
  spent: z.number().nullable(),
  budget: z.number().nullable(),
  currency: z.string().nullable(),
  started_at: z.date(),
  source: messageSourceSchema,
  workspace_id: z.string(),
  channel_id: z.string(),
  thread_id: z.string(),
});

function snippet(text: string | null): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= SNIPPET_CHARACTERS ? flat : `${flat.slice(0, SNIPPET_CHARACTERS - 1)}…`;
}

function toActivity(r: Row): SessionActivity {
  const d = row.parse(r);
  return {
    kind: d.kind,
    conversationId: d.conversation_id,
    changeId: d.change_id,
    title: snippet(d.title) || "(no text)",
    agent: d.agent,
    state: d.state,
    askedBy:
      d.asked_by_actor_id === null ? null : { actorId: d.asked_by_actor_id, name: d.asked_by_name },
    project:
      d.project_id === null || d.project_name === null
        ? null
        : { id: d.project_id, name: d.project_name },
    latestActivity:
      d.latest_at === null || d.latest_text === null
        ? null
        : { at: d.latest_at.toISOString(), text: snippet(d.latest_text) },
    cost: { spentMinor: d.spent, budgetMinor: d.budget, currency: d.currency },
    startedAt: d.started_at.toISOString(),
    thread: {
      source: d.source,
      workspaceId: d.workspace_id,
      channelId: d.channel_id,
      threadId: d.thread_id,
    },
  };
}

/**
 * The latest sessions: those working or waiting for Start first, then by their latest activity
 * (or when they started). A thread counts once it has a session; a change once it has a worker
 * or a brief waiting for Start. Money is read as float8: bigint comes back as a string.
 */
export async function listSessions(db: Db, limit: number): Promise<SessionActivity[]> {
  const rows = await db.query(
    `with threads as (
       select 'thread'::text as kind, c.id as conversation_id, null::uuid as change_id,
              first.text as title,
              coalesce(c.agent_kind, 'engineer') as agent,
              case c.status when 'waiting' then 'working' when 'failed' then 'failed'
                            when 'stopped' then 'stopped' else 'idle' end as state,
              first.actor_id as asked_by_actor_id, first.actor_name as asked_by_name,
              p.id as project_id, p.name as project_name,
              latest.processed_at as latest_at, latest.text as latest_text,
              c.usage_list_cost_minor::float8 as spent,
              c.budget_list_cost_minor::float8 as budget, c.cost_currency as currency,
              c.created_at as started_at,
              c.source, c.workspace_id, c.channel_id, c.thread_id
       from conversations c
       left join projects p on p.id = c.project_id
       left join lateral (
         select m.text, m.actor_id, m.actor_name from inbound_messages m
         where m.conversation_id = c.id order by m.sent_at, m.created_at limit 1
       ) first on true
       left join lateral (
         select e.processed_at, e.text from agent_events e
         where e.conversation_id = c.id and e.agent_session_id = c.agent_session_id
           and e.kind = 'agent_message' and e.processed_at is not null
         order by e.processed_at desc, e.seq desc limit 1
       ) latest on true
       where c.agent_session_id is not null and c.agent_session_id not like 'starting:%'
     ),
     workers as (
       select 'worker'::text, ch.conversation_id, ch.id,
              (select b.title from change_briefs b where b.change_id = ch.id
               order by b.seq desc limit 1),
              'worker'::text,
              case when ch.status = 'stopped' then 'stopped'
                   -- The first brief, or a follow-up the start rule held (181).
                   when ch.status = 'waiting_for_start' or exists (
                     select 1 from change_briefs b
                     where b.change_id = ch.id and b.start_needed and b.started_at is null
                       and b.gave_up_at is null
                   ) then 'waiting_for_start'
                   when ch.session_state <> 'active' then 'failed'
                   when ch.waiting_since is not null then 'working'
                   else 'idle' end,
              ch.requested_by_actor_id, ch.requested_by_name,
              p.id, p.name,
              latest.processed_at, latest.text,
              ch.usage_list_cost_minor::float8, ch.budget_list_cost_minor::float8,
              ch.cost_currency, ch.created_at,
              c.source, c.workspace_id, c.channel_id, c.thread_id
       from changes ch
       join conversations c on c.id = ch.conversation_id
       left join projects p on p.id = c.project_id
       left join lateral (
         select e.processed_at, e.text from agent_events e
         where e.conversation_id = ch.conversation_id and e.agent_session_id = ch.agent_session_id
           and e.kind = 'agent_message' and e.processed_at is not null
         order by e.processed_at desc, e.seq desc limit 1
       ) latest on true
     )
     select * from (select * from threads union all select * from workers) s
     order by case when s.state in ('working', 'waiting_for_start') then 0 else 1 end,
              coalesce(s.latest_at, s.started_at) desc
     limit $1`,
    [limit],
  );
  return rows.map(toActivity);
}
