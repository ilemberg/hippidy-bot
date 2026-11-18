-- Slice 2 storage (decision 8): only what the API must remember between requests.
-- Slice 3 adds the full record (messages, agent events).
--
-- Only the API reaches these tables, through a direct database connection. Supabase's Data
-- API roles (anon, authenticated) get no privileges on them, and row level security is on
-- with no policies as a second fence.
--
-- Migrations run before or after the deploy that needs them (CI and Vercel both start on the
-- merge), so every migration must work with the code before and after it.

-- One per thread of work (decision 51: one Slack thread = one conversation = one session).
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('slack', 'ui')),
  workspace_id text not null,
  channel_id text not null,
  thread_id text not null,
  agent_session_id text unique,
  agent_id text,
  agent_version integer,
  status text not null default 'new'
    check (status in ('new', 'waiting', 'answered', 'failed', 'stopped')),
  -- When the conversation last started waiting for the agent; drives the reconcile job.
  waiting_since timestamptz,
  -- The last agent runtime event already handled, so a sync can skip what it has seen.
  agent_event_cursor text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, workspace_id, channel_id, thread_id)
);

-- Every accepted inbound message. Unique twice over: on the source's delivery id (Slack
-- retries) and on the message itself (one message can arrive as two different events).
create table public.inbound_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  source text not null,
  source_event_id text not null,
  workspace_id text not null,
  channel_id text not null,
  message_id text not null,
  actor_id text not null,
  text text not null,
  sent_at timestamptz not null,
  status text not null default 'received'
    check (status in ('received', 'answered', 'failed', 'stopped')),
  -- When the message was handed to the agent. A message is only settled (answered, failed,
  -- stopped) by an agent outcome observed after it was handed over.
  forwarded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (source, source_event_id),
  unique (source, workspace_id, channel_id, message_id)
);

create index inbound_messages_pending_idx
  on public.inbound_messages (conversation_id)
  where status = 'received';

-- Each thing sent back to the source, claimed before sending so two workers never send it
-- at once. A claim that goes silent can be taken over, so delivery is at least once in the
-- rare case of a worker that sent and then died before recording it.
-- agent_event_id is the agent runtime's event id, or a synthetic key for status messages.
create table public.deliveries (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  agent_event_id text not null,
  kind text not null check (kind in ('reply', 'failure', 'stopped')),
  status text not null default 'sending' check (status in ('sending', 'sent', 'failed')),
  attempts integer not null default 1,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (conversation_id, agent_event_id)
);

create index conversations_waiting_idx
  on public.conversations (waiting_since)
  where status = 'waiting';

create index deliveries_unsent_idx
  on public.deliveries (conversation_id)
  where status <> 'sent';

alter table public.conversations enable row level security;
alter table public.inbound_messages enable row level security;
alter table public.deliveries enable row level security;

-- Supabase grants every new table in public to its Data API roles by default. Take that
-- back, for these tables and for tables created later. The roles only exist on Supabase.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema public from anon, authenticated;
    revoke all on all sequences in schema public from anon, authenticated;
    revoke all on all functions in schema public from anon, authenticated;
    alter default privileges in schema public revoke all on tables from anon, authenticated;
    alter default privileges in schema public revoke all on sequences from anon, authenticated;
    alter default privileges in schema public revoke all on functions from anon, authenticated;
  end if;
end
$$;
