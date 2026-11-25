-- Slice 2.1, part B (decisions 181, 183, 184; `docs/planning/slice-2-1.md`): a thread may now
-- have more than one agent session. The session people talk to (the teammate, or the one
-- session of an older thread) stays on `conversations`, as before; each change gets its own
-- coding worker, whose session lives on the change. A brief joins the two.
--
-- Additive only (decision 86): two new tables, one nullable column, and one more value the
-- agent kind may take. The code before this never reads them; part C writes them.

-- A change to the code, asked for in a thread and handed to a coding worker (decision 181),
-- with the worker's session and the loop's state for it, as `conversations` holds them for the
-- thread's own session.
create table public.changes (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  -- Who asked: the sender of the message the teammate was answering when it wrote the first
  -- brief. The worker is told this name (`slice-2-1.md`, "The brief").
  requested_by_source text not null,
  requested_by_workspace_id text not null,
  requested_by_actor_id text not null,
  requested_by_name text,
  -- waiting_for_start: no brief of it has been started yet. started: the worker has work.
  -- stopped: someone stopped the thread; nothing more is sent to the worker.
  status text not null default 'waiting_for_start'
    check (status in ('waiting_for_start', 'started', 'stopped')),
  -- The worker's session: null until started; 'starting:<uuid>' while one request claims the
  -- start, as on `conversations`.
  agent_session_id text unique,
  agent_id text,
  agent_version integer,
  session_state text not null default 'active'
    check (session_state in ('active', 'budget_reached', 'terminated')),
  -- When the worker was last given a brief it has not finished; drives reconcile and the time
  -- limit, as on `conversations`.
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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index changes_conversation_idx on public.changes (conversation_id, created_at);
create index changes_waiting_idx on public.changes (waiting_since) where waiting_since is not null;

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
  -- Failed tries to hand it to the worker; after a few, or when the worker can take no more,
  -- it is given up and the messages that led to it are answered with a note.
  hand_over_attempts integer not null default 0,
  gave_up_at timestamptz,
  check (gave_up_at is null or worker_event_id is null),
  seq bigint generated always as identity,
  created_at timestamptz not null default now()
);

create index change_briefs_change_idx on public.change_briefs (change_id, seq);
create index change_briefs_unsent_idx
  on public.change_briefs (change_id)
  where started_at is not null and worker_event_id is null and gave_up_at is null;

-- The brief a person's message led to. Such a message is settled by the worker's turn that
-- handled the brief (✅ only once its pull request's CI has passed, decision 132), not by the
-- teammate's turn that wrote it.
alter table public.inbound_messages
  add column change_brief_id uuid references public.change_briefs (id) on delete set null;

create index inbound_messages_brief_idx
  on public.inbound_messages (change_brief_id)
  where change_brief_id is not null;

-- New threads get the teammate (part E); older threads keep the agent they were given (59).
alter table public.conversations drop constraint conversations_agent_kind_check;
alter table public.conversations
  add constraint conversations_agent_kind_check
    check (agent_kind in ('engineer', 'product', 'teammate'));

alter table public.changes enable row level security;
alter table public.change_briefs enable row level security;

-- The first migration takes default privileges away from Supabase's Data API roles; revoke
-- again here so these tables are closed even if that ever changed.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.changes, public.change_briefs from anon, authenticated;
    revoke all on all sequences in schema public from anon, authenticated;
  end if;
end
$$;
