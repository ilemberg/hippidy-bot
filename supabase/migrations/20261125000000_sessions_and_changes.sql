-- Slice 2.1, part B (decisions 181, 183; `docs/planning/slice-2-1.md`): a thread may now have
-- more than one agent session, a teammate and a coding worker per change, joined by briefs.
--
-- Additive only (decision 86): three new tables. The code before this never reads them; part C
-- moves the loop onto `agent_sessions`, giving each existing conversation one `legacy` row,
-- and part D writes changes and briefs. The loop's columns on `conversations` stay until a
-- later migration removes them (add first, remove later).

-- A change to the code, asked for in a thread and handed to a coding worker (decision 181).
create table public.changes (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  -- Who asked: the sender of the message the teammate was answering when it wrote the first
  -- brief. The worker is told this name (`slice-2-1.md`, "The brief").
  requested_by_source text not null,
  requested_by_workspace_id text not null,
  requested_by_actor_id text not null,
  requested_by_name text,
  -- waiting_for_start: its latest brief needs a person to start it. started: the worker has
  -- it. stopped: someone stopped the thread.
  status text not null default 'waiting_for_start'
    check (status in ('waiting_for_start', 'started', 'stopped')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index changes_conversation_idx on public.changes (conversation_id, created_at);

-- Every runtime session of a conversation (decision 78: split from `conversations` once a
-- second session per conversation is real). Part C moves the loop's per-session state here.
create table public.agent_sessions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  -- legacy: a thread's one session from before slice 2.1 (slice 4's agent or the product
  -- agent). teammate: the session every new thread talks to. worker: a change's coding worker.
  kind text not null check (kind in ('legacy', 'teammate', 'worker')),
  change_id uuid references public.changes (id) on delete cascade,
  -- Null until the runtime session has been created.
  agent_session_id text unique,
  agent_id text,
  agent_version integer,
  -- The loop's state, as on `conversations` until part C.
  session_state text not null default 'active'
    check (session_state in ('active', 'budget_reached', 'terminated')),
  waiting_since timestamptz,
  agent_event_cursor text,
  sync_lease_until timestamptz,
  sync_lease_owner uuid,
  -- Usage as the runtime reports it (cumulative); money in minor units, as on `conversations`.
  usage_input_tokens bigint,
  usage_output_tokens bigint,
  usage_cache_read_tokens bigint,
  usage_cache_creation_tokens bigint,
  usage_active_seconds double precision,
  usage_list_cost_minor bigint,
  budget_list_cost_minor bigint,
  cost_currency text,
  usage_updated_at timestamptz,
  agent_events_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A worker belongs to a change; nothing else does.
  check ((kind = 'worker') = (change_id is not null))
);

-- One session a thread talks to (legacy or teammate), and one worker per change.
create unique index agent_sessions_front_idx
  on public.agent_sessions (conversation_id)
  where kind in ('legacy', 'teammate');
create unique index agent_sessions_worker_idx
  on public.agent_sessions (change_id)
  where kind = 'worker';
create index agent_sessions_waiting_idx
  on public.agent_sessions (waiting_since)
  where waiting_since is not null;

-- Every brief the teammate wrote for a change, in order. Append-only apart from its start and
-- its hand-over to the worker, each set once.
create table public.change_briefs (
  id uuid primary key default gen_random_uuid(),
  change_id uuid not null references public.changes (id) on delete cascade,
  -- The teammate's `start_change` call: each call is answered once and writes once (167).
  custom_tool_use_id text not null unique,
  title text not null check (char_length(title) between 1 and 200),
  what text not null,
  why text not null,
  done_when text not null,
  -- The tickets, documents and pull requests it names: a JSON array of strings. Passed as
  -- text and cast (`$1::text::jsonb`, see CLAUDE.md).
  links jsonb not null default '[]'::jsonb check (jsonb_typeof(links) = 'array'),
  -- The contract caps the whole brief, links included, at 4,000 characters; this is the
  -- database's backstop on the text a person reads.
  check (char_length(title) + char_length(what) + char_length(why) + char_length(done_when) <= 4000),
  -- The start rule (G18): whether a person must start it, and why (for example the Atlassian
  -- tools the teammate called before writing it).
  start_needed boolean not null,
  start_reason text,
  check (start_needed = (start_reason is not null)),
  -- When it was started, and by whom when a person started it. A brief that needs no start is
  -- started when it is written, with no person.
  started_at timestamptz,
  started_by_source text,
  started_by_workspace_id text,
  started_by_actor_id text,
  started_by_name text,
  check (started_by_actor_id is null or started_at is not null),
  check (not start_needed or started_at is null or started_by_actor_id is not null),
  -- The event id the worker's session gave the brief when it was sent, so it is sent once.
  worker_event_id text unique,
  check (worker_event_id is null or started_at is not null),
  seq bigint generated always as identity,
  created_at timestamptz not null default now()
);

create index change_briefs_change_idx on public.change_briefs (change_id, seq);
create index change_briefs_unsent_idx
  on public.change_briefs (change_id)
  where started_at is not null and worker_event_id is null;

alter table public.changes enable row level security;
alter table public.agent_sessions enable row level security;
alter table public.change_briefs enable row level security;

-- The first migration takes default privileges away from Supabase's Data API roles; revoke
-- again here so these tables are closed even if that ever changed.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.changes, public.agent_sessions, public.change_briefs
      from anon, authenticated;
    revoke all on all sequences in schema public from anon, authenticated;
  end if;
end
$$;
