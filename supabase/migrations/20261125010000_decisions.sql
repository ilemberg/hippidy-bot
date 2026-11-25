-- Slice 2.2, part A (decisions 190 to 192; `docs/planning/slice-2-2.md`): what the team has
-- decided, the first of the team layer's own records (`team-layer.md`, "Its records").
--
-- Additive only (decision 86): one new table. Nothing reads it until part C.

create table public.decisions (
  id uuid primary key default gen_random_uuid(),
  -- The number people cite it by ("decision 12 on record"), in the order recorded.
  number bigint generated always as identity unique,
  -- What was decided, and why. The tool keeps a statement to 500 characters and a reason to
  -- 2,000; entries imported from the log are longer, so the table's limits are looser.
  statement text not null check (char_length(statement) between 1 and 4000),
  reason text check (reason is null or char_length(reason) <= 4000),
  -- A free label until wave 3 gives areas owners.
  area text check (area is null or char_length(area) between 1 and 100),
  status text not null check (status in ('proposed', 'active', 'superseded', 'rejected')),
  -- Who decided. An imported decision names the owner, with no id.
  decided_by_source text,
  decided_by_workspace_id text,
  decided_by_actor_id text,
  decided_by_name text,
  check (decided_by_actor_id is not null or decided_by_name is not null),
  decided_at timestamptz not null,
  -- Where: a thread (its conversation and the message it was decided in), the log, or, from
  -- slice 2.5, a listened channel.
  origin text not null check (origin in ('thread', 'import', 'capture')),
  conversation_id uuid references public.conversations (id) on delete set null,
  message_id text,
  -- For an import: the entry's number in `decisions.md`.
  origin_ref text,
  check (origin <> 'import' or origin_ref is not null),
  -- The decision this one replaces; it becomes superseded when this one becomes active.
  supersedes_id uuid references public.decisions (id) on delete set null,
  -- Who confirmed a proposal, and when (decision 192).
  confirmed_by_source text,
  confirmed_by_workspace_id text,
  confirmed_by_actor_id text,
  confirmed_by_name text,
  confirmed_at timestamptz,
  check (confirmed_by_actor_id is null or confirmed_at is not null),
  -- The `record_decision` call that wrote it: each call writes once (167).
  custom_tool_use_id text unique,
  -- Full-text search for recall (no model picks what bears on a message).
  search tsvector generated always as (
    to_tsvector(
      'english',
      coalesce(area, '') || ' ' || statement || ' ' || coalesce(reason, '')
    )
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index decisions_origin_ref_idx
  on public.decisions (origin, origin_ref)
  where origin_ref is not null;
create index decisions_search_idx on public.decisions using gin (search);
create index decisions_status_idx on public.decisions (status, decided_at desc);

alter table public.decisions enable row level security;

-- The first migration takes default privileges away from Supabase's Data API roles; revoke
-- again here so this table is closed even if that ever changed.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.decisions from anon, authenticated;
    revoke all on all sequences in schema public from anon, authenticated;
  end if;
end
$$;
