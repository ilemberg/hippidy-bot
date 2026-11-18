-- Slice 2 storage (decision 8): only what the API must remember between requests.
-- Slice 3 adds the full record (messages, agent events).
--
-- Only the API reaches these tables, through a direct database connection. Row level
-- security is on with no policies, so Supabase's public Data API roles can read nothing.

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
  created_at timestamptz not null default now(),
  unique (source, source_event_id),
  unique (source, workspace_id, channel_id, message_id)
);

create index inbound_messages_pending_idx
  on public.inbound_messages (conversation_id)
  where status = 'received';

-- Each thing sent back to the source, claimed before sending so it goes out exactly once.
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

alter table public.conversations enable row level security;
alter table public.inbound_messages enable row level security;
alter table public.deliveries enable row level security;
