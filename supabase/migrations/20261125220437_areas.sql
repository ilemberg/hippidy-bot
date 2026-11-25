-- Slice 3.1, part A (decisions 205 and 206; `docs/planning/slice-3-1.md`): areas with owners,
-- their history, and which areas a change was said to touch. Additive only (decision 86).

create table public.areas (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('slack', 'ui')),
  workspace_id text not null,
  -- The label decisions already carry: lowercase, so a decision in `search` is in this area.
  name text not null check (
    char_length(name) between 1 and 60 and name = lower(name) and name = btrim(name)
  ),
  description text check (description is null or char_length(description) <= 300),
  -- One owner, or none: none means the fallback (rule 10 of `wave-3.md`).
  owner_actor_id text,
  owner_name text,
  -- Glob patterns over the repository, like CODEOWNERS, and words that mark it in text.
  paths text[] not null default '{}' check (cardinality(paths) <= 50),
  words text[] not null default '{}' check (cardinality(words) <= 30),
  -- One more for each change: an edit names the version it was made on (as 203).
  version integer not null default 1 check (version >= 1),
  created_by_actor_id text not null,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, workspace_id, name)
);

create table public.area_events (
  id uuid primary key default gen_random_uuid(),
  area_id uuid not null references public.areas (id) on delete cascade,
  kind text not null check (kind in ('created', 'edited')),
  actor_id text not null,
  actor_name text,
  -- The area's name, description, owner, paths and words before and after.
  before jsonb,
  after jsonb not null,
  at timestamptz not null default now(),
  seq bigint generated always as identity
);

create index area_events_area_idx on public.area_events (area_id, seq);

-- Which areas a change was said to touch, so each is named once per change.
create table public.change_areas (
  change_id uuid not null references public.changes (id) on delete cascade,
  area_id uuid not null references public.areas (id) on delete cascade,
  via text not null check (via in ('brief', 'pull_request')),
  named_at timestamptz not null default now(),
  primary key (change_id, area_id)
);

-- A change's latest pull request, as the worker's turn reported it, and the one whose files
-- were last matched to areas, so GitHub is asked once per pull request.
alter table public.changes
  add column pull_request_url text,
  add column areas_checked_url text;

alter table public.areas enable row level security;
alter table public.area_events enable row level security;
alter table public.change_areas enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.areas, public.area_events, public.change_areas
      from anon, authenticated;
  end if;
end
$$;
