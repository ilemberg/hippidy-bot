-- Slice 4.1, part A (decision 215; `docs/planning/slice-4-1.md`): standing jobs, each wake they
-- make with its cost, and each change a person makes to one. Additive only (decision 86).

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('slack', 'ui')),
  workspace_id text not null,
  name text not null check (char_length(name) between 1 and 60 and name = lower(name)),
  kind text not null check (kind in ('capture', 'briefs')),
  -- What it is for, in words; a person's to change (G16).
  goal text check (goal is null or char_length(goal) <= 2000),
  owner_actor_id text,
  owner_name text,
  every_minutes integer not null default 1 check (every_minutes between 1 and 1440),
  state text not null default 'active' check (state in ('active', 'paused', 'capped')),
  -- Its monthly cap in cents (G21), and the month it was capped in, so it wakes again after.
  cap_cents integer not null check (cap_cents >= 0),
  capped_month date,
  -- What the job keeps between wakes (rule 14), written only by the job.
  notes jsonb,
  last_wake_at timestamptz,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, workspace_id, name)
);

create table public.job_wakes (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs (id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  outcome text check (outcome in ('said', 'silent', 'failed', 'skipped')),
  summary text check (summary is null or char_length(summary) <= 500),
  cost_micros bigint not null default 0 check (cost_micros >= 0),
  error text check (error is null or char_length(error) <= 500)
);

create index job_wakes_job_idx on public.job_wakes (job_id, started_at desc);

create table public.job_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs (id) on delete cascade,
  actor_id text not null,
  actor_name text,
  before jsonb,
  after jsonb not null,
  at timestamptz not null default now(),
  seq bigint generated always as identity
);

alter table public.jobs enable row level security;
alter table public.job_wakes enable row level security;
alter table public.job_events enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.jobs, public.job_wakes, public.job_events from anon, authenticated;
  end if;
end
$$;
