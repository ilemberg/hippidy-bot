-- Slice 3: the record. Schema only; the code that writes and reads it ships in later pull
-- requests, so this migration is live before anything depends on it.
--
-- Decisions 75, 77 and 78: Supabase owns conversations and messages, and keeps the agent
-- runtime's raw events as a log, so a conversation can be rebuilt from the database alone.

-- Every event of a conversation's agent session, as the runtime reported it. Rows are never
-- deleted, but a row can change (decision 85): a user message is listed while it waits in
-- the session's queue (no processed time yet) and again once the agent has processed it.
-- Writers upsert on (conversation_id, event_id).
create table public.agent_events (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  agent_session_id text not null,
  -- The runtime's own id and type for the event, for example 'agent.message'.
  event_id text not null,
  type text not null,
  -- What the API makes of the event (the AgentRuntime interface's kinds, such as
  -- 'agent_message' or 'idle'); null for events the API does not act on. Not constrained
  -- here: the set grows with the interface, and rows are checked with Zod when read.
  kind text,
  -- The text of an agent message, so the transcript does not depend on the payload's shape.
  text text,
  -- The runtime's clock. Null while a user message is still queued.
  processed_at timestamptz,
  payload jsonb not null,
  -- The order events were first stored in.
  seq bigint generated always as identity,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (conversation_id, event_id)
);

create index agent_events_processed_idx
  on public.agent_events (conversation_id, processed_at);

alter table public.agent_events enable row level security;

-- What the session has used so far, as the runtime reports it (cumulative), and the budget it
-- was started with. Money is in minor units of the currency (cents for USD), as the runtime
-- gives it. These stay on the conversation while one thread is one session (decision 51).
alter table public.conversations
  add column usage_input_tokens bigint,
  add column usage_output_tokens bigint,
  add column usage_cache_read_tokens bigint,
  add column usage_cache_creation_tokens bigint,
  add column usage_active_seconds double precision,
  add column usage_list_cost_minor bigint,
  add column budget_list_cost_minor bigint,
  add column cost_currency text,
  add column usage_updated_at timestamptz,
  -- When the session's events were last stored in agent_events. Null for conversations from
  -- before this migration, which is how they are found for the one-off backfill.
  add column agent_events_synced_at timestamptz;

-- A conversation as people saw it, oldest first when ordered by (occurred_at, recorded_at):
-- what they wrote, what the agent answered, and the notes the API posted itself (for example
-- "spending limit reached"). Built from the tables above, so it cannot drift from them.
-- security_invoker: the view gives no more access than the tables under it.
create view public.conversation_transcript
with (security_invoker = true) as
select
  m.conversation_id,
  'user'::text as role,
  m.sent_at as occurred_at,
  m.text,
  m.actor_id,
  m.actor_name,
  -- The message's id in its source, the agent event's id, or the note's delivery key.
  m.message_id as ref,
  -- How a person's message ended (received, answered, failed, stopped).
  m.status as message_status,
  -- Whether an agent message or note reached the source (pending, sent, abandoned, ...).
  null::text as delivery_status,
  m.created_at as recorded_at
from public.inbound_messages m
union all
select
  e.conversation_id,
  'agent'::text,
  coalesce(e.processed_at, e.created_at),
  e.text,
  null::text,
  null::text,
  e.event_id,
  null::text,
  d.status,
  e.created_at
from public.agent_events e
left join public.deliveries d
  on d.conversation_id = e.conversation_id and d.agent_event_id = e.event_id
where e.kind = 'agent_message'
union all
select
  d.conversation_id,
  'note'::text,
  d.created_at,
  d.payload ->> 'text',
  null::text,
  null::text,
  d.agent_event_id,
  null::text,
  d.status,
  d.created_at
from public.deliveries d
where d.kind = 'note';

-- The first migration already takes new tables in public away from Supabase's Data API
-- roles by default. Said again here for the new table and the view, so this file is safe on
-- its own. The roles only exist on Supabase.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.agent_events from anon, authenticated;
    revoke all on public.conversation_transcript from anon, authenticated;
    revoke all on all sequences in schema public from anon, authenticated;
  end if;
end
$$;
