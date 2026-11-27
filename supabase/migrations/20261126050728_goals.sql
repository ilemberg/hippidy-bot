-- Slice 4.4, part A (decision 221; `docs/planning/slice-4-4.md`): a feature goal, a job of kind
-- `goal` that a person makes for one thread, with its tickets in order. Additive in effect
-- (decision 86): the kind check only grows, and the tables are new.

alter table public.jobs drop constraint if exists jobs_kind_check;
alter table public.jobs
  add constraint jobs_kind_check check (kind in ('capture', 'briefs', 'checker', 'goal'));

-- A goal job's thread and limit. One goal per thread.
create table public.goals (
  job_id uuid primary key references public.jobs (id) on delete cascade,
  conversation_id uuid not null unique references public.conversations (id) on delete cascade,
  -- The most changes it has open at once.
  open_limit integer not null default 2 check (open_limit between 1 and 5),
  -- When it said every ticket is settled, so it says so once; cleared when a ticket is added.
  settled_said_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Its tickets in order, each with where it is and the change its brief started.
create table public.goal_tickets (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.goals (job_id) on delete cascade,
  key text not null check (key ~ '^[A-Z][A-Z0-9]{0,19}-[1-9][0-9]{0,8}$'),
  position integer not null check (position between 0 and 99),
  -- Its title as the tracker gave it when it was added or last briefed, and its link there.
  title text not null check (char_length(title) <= 500),
  url text check (url is null or char_length(url) <= 500),
  state text not null default 'pending'
    check (state in ('pending', 'briefed', 'merged', 'closed', 'stopped', 'done_elsewhere',
                     'skipped')),
  change_id uuid references public.changes (id) on delete set null,
  brief_id uuid references public.change_briefs (id) on delete set null,
  -- Model calls in a row that gave no brief; at three it is skipped.
  failures integer not null default 0 check (failures between 0 and 10),
  error text check (error is null or char_length(error) <= 500),
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, key)
);

create index goal_tickets_job_idx on public.goal_tickets (job_id, position);

alter table public.goals enable row level security;
alter table public.goal_tickets enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.goals, public.goal_tickets from anon, authenticated;
  end if;
end
$$;
