-- Slice 3.4, part A (decision 212; `docs/planning/slice-3-4.md`): who gets a daily brief and
-- in which time zone, who said "stop briefs", and each brief, one per person and local day.
-- Additive only (decision 86).

create table public.brief_people (
  source text not null check (source in ('slack', 'ui')),
  workspace_id text not null,
  actor_id text not null,
  -- The person's IANA time zone, as the source last said it, and when it was asked.
  time_zone text check (time_zone is null or char_length(time_zone) <= 64),
  time_zone_checked_at timestamptz,
  -- Set when they said "stop briefs"; cleared by "start briefs".
  stopped_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (source, workspace_id, actor_id)
);

create table public.briefs (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('slack', 'ui')),
  workspace_id text not null,
  actor_id text not null,
  -- The day in the person's time zone it is for: one brief a day at most.
  local_date date not null,
  -- `empty`: nothing new, nothing sent. `abandoned`: three sends failed.
  status text not null check (status in ('empty', 'pending', 'sent', 'abandoned')),
  text text check (text is null or char_length(text) <= 20000),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text check (last_error is null or char_length(last_error) <= 500),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, workspace_id, actor_id, local_date)
);

create index briefs_person_idx on public.briefs (source, workspace_id, actor_id, sent_at desc);

alter table public.brief_people enable row level security;
alter table public.briefs enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.brief_people, public.briefs from anon, authenticated;
  end if;
end
$$;
