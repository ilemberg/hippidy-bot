-- Slice 2.6, part A (decisions 201 and 202; `docs/planning/slice-2-6.md`): the history of each
-- decision after it was recorded, with who made each change and when. Additive only (86).

create table public.decision_events (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references public.decisions (id) on delete cascade,
  kind text not null check (kind in ('edited', 'confirmed', 'rejected', 'superseded')),
  actor_source text not null check (actor_source in ('slack', 'ui')),
  actor_workspace_id text not null,
  actor_id text not null,
  actor_name text,
  -- For an edit: the statement, reason and area before and after.
  before jsonb,
  after jsonb,
  check (kind <> 'edited' or (before is not null and after is not null)),
  at timestamptz not null default now(),
  seq bigint generated always as identity
);

create index decision_events_decision_idx on public.decision_events (decision_id, seq);

-- Who rejected a proposal, and when, on the decision itself, as for confirming. And which
-- wording a proposal is at: each edit adds one, and a confirm, reject or edit names the
-- wording it was pressed on, so no one confirms words they never saw. A button in Slack
-- always means the wording first posted there, 1.
alter table public.decisions
  add column wording_version integer not null default 1 check (wording_version >= 1),
  add column rejected_by_actor_id text,
  add column rejected_by_name text,
  add column rejected_at timestamptz;

alter table public.decision_events enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.decision_events from anon, authenticated;
  end if;
end
$$;
