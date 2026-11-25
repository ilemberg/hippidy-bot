-- Slice 2.5, part A (decisions 198 and 199; `docs/planning/slice-2-5.md`): listening in
-- channels, and decisions proposed from what it reads.
--
-- Additive only (decision 86): four new tables and new nullable columns on `decisions`.
-- Nothing writes them until part B.

-- Channels someone switched listening on in, with who last switched it and when.
create table public.listening_channels (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('slack', 'ui')),
  workspace_id text not null,
  channel_id text not null,
  listening boolean not null,
  -- When listening was last switched on, kept after it is switched off.
  started_at timestamptz not null,
  changed_by_actor_id text not null,
  changed_by_name text,
  changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (source, workspace_id, channel_id)
);

-- What people wrote in a listened channel (G8): the text, who and when, and the ids of its
-- link. Never the source's payload. Deleted 30 days after it was sent.
create table public.observed_messages (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('slack', 'ui')),
  workspace_id text not null,
  channel_id text not null,
  -- The thread's root message; a message that starts no thread is its own root.
  thread_id text not null,
  message_id text not null,
  actor_id text not null,
  actor_name text,
  text text not null check (char_length(text) <= 40000),
  sent_at timestamptz not null,
  edited_at timestamptz,
  created_at timestamptz not null default now(),
  unique (source, workspace_id, channel_id, message_id)
);

create index observed_messages_thread_idx
  on public.observed_messages (source, workspace_id, channel_id, thread_id, sent_at);
create index observed_messages_sent_at_idx on public.observed_messages (sent_at);

-- A listened thread, and where capture is with it.
create table public.observed_threads (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('slack', 'ui')),
  workspace_id text not null,
  channel_id text not null,
  thread_id text not null,
  -- When its latest message was sent, and when the newest message capture read was sent.
  last_message_at timestamptz not null,
  captured_through timestamptz,
  -- Kept messages in the thread. Capture reads only threads with two or more: a top-level
  -- message nobody answered is not read on its own, so no model runs per message (176).
  message_count integer not null default 0 check (message_count >= 0),
  -- Failed captures in a row; at three it waits for a new message.
  capture_failures integer not null default 0 check (capture_failures >= 0),
  -- A capture holds the thread until then, so two reconciles do not read it at once.
  capture_lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, workspace_id, channel_id, thread_id)
);

create index observed_threads_due_idx on public.observed_threads (last_message_at)
  where captured_through is null or captured_through < last_message_at;

-- Every call capture made, with its cost (G10). No text is kept here.
create table public.capture_runs (
  id uuid primary key default gen_random_uuid(),
  observed_thread_id uuid references public.observed_threads (id) on delete set null,
  source text not null,
  workspace_id text not null,
  channel_id text not null,
  thread_id text not null,
  model text not null,
  outcome text not null
    check (outcome in ('proposed', 'nothing', 'refused', 'cut_off', 'failed')),
  messages_read integer not null default 0,
  -- Whether the thread was longer than one call reads, so only its end was read.
  truncated boolean not null default false,
  proposals integer not null default 0,
  input_tokens integer,
  output_tokens integer,
  -- List cost in millionths of a dollar: a capture costs a fraction of a cent.
  cost_micros bigint,
  error text,
  started_at timestamptz not null,
  finished_at timestamptz not null default now()
);

create index capture_runs_finished_at_idx on public.capture_runs (finished_at);

-- Where a decision proposed from listening came from, after its messages are deleted, and
-- who may confirm it (G11).
alter table public.decisions
  add column channel_id text,
  add column thread_id text,
  add column capture_run_id uuid references public.capture_runs (id) on delete set null,
  add column confirmable_by text[];

-- One proposal per statement per thread, whatever runs read it.
create unique index decisions_capture_statement_idx
  on public.decisions (decided_by_source, decided_by_workspace_id, channel_id, thread_id, lower(statement))
  where origin = 'capture';

alter table public.listening_channels enable row level security;
alter table public.observed_messages enable row level security;
alter table public.observed_threads enable row level security;
alter table public.capture_runs enable row level security;

-- The first migration takes default privileges away from Supabase's Data API roles; revoke
-- again here so these tables are closed even if that ever changed.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.listening_channels, public.observed_messages,
      public.observed_threads, public.capture_runs from anon, authenticated;
  end if;
end
$$;
