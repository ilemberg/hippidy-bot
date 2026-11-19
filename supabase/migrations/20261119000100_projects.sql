-- Slice 5A, part A (decision 163; `docs/planning/slice-5a.md`): projects, the roles people
-- hold, and approvals, for the project workflow of `docs/planning/projects.md`.
--
-- Additive only (decision 86): the code before this never reads the new tables or columns,
-- and the code after it treats a null project and a null agent kind as today's behaviour.

-- A project (decision 135). hippidy-bot owns its stage and approvals; the document and ticket
-- systems hold the content. Stages are loose: a project may move backwards (decision 136).
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 200),
  stage text not null default 'plan' check (stage in ('plan', 'roadmap', 'ship', 'end')),
  -- Who asked for it, as on inbound_messages and actor_roles.
  created_by_source text not null,
  created_by_workspace_id text not null,
  created_by_actor_id text not null,
  -- The project's main thread (decision 155): the latest thread in which the bot was
  -- mentioned. Set from part D on.
  main_conversation_id uuid references public.conversations (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The hand-made map from a person to their role (decision 138). One role per person per
-- workspace. Someone with no row is treated as today: they may ask questions and ask for
-- development.
create table public.actor_roles (
  source text not null,
  workspace_id text not null,
  actor_id text not null,
  role text not null check (
    role in ('engineering_manager', 'product_manager', 'tech_lead', 'engineer', 'qa', 'designer')
  ),
  updated_at timestamptz not null default now(),
  primary key (source, workspace_id, actor_id)
);

-- Every approval and withdrawal, as the agent reports it (decision 152). Append-only: the
-- current state of a subject is its latest row per approver. Recording is not checking
-- (decision 146): nothing here stops a stage change.
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  -- Restrict, not cascade: deleting a project must not erase its approval history.
  project_id uuid not null references public.projects (id) on delete restrict,
  subject text not null check (subject in ('plan', 'roadmap', 'ticket', 'end')),
  -- The document or ticket in the content system; free text until E1 picks the system. A
  -- ticket approval must name its ticket, or two tickets' approvals would read as one.
  subject_ref text not null default '',
  -- The version approved, so an edit after approval can be noticed (decision 137).
  subject_version text not null default '',
  action text not null check (action in ('approve', 'withdraw')),
  actor_source text not null,
  actor_workspace_id text not null,
  actor_id text not null,
  -- The role the person held when they acted, copied so a later change does not rewrite it.
  role text check (
    role in ('engineering_manager', 'product_manager', 'tech_lead', 'engineer', 'qa', 'designer')
  ),
  -- The conversation the approval was given in, when there is one.
  conversation_id uuid references public.conversations (id) on delete set null,
  recorded_at timestamptz not null default now(),
  -- The order rows were recorded in, so "latest per approver" never ties, even for two rows
  -- written in one transaction (same now()).
  seq bigint generated always as identity,
  check (subject <> 'ticket' or subject_ref <> '')
);

create index approvals_project_idx on public.approvals (project_id, subject, seq);

-- Which project a thread belongs to, and which agent it was given (decisions 139, 153). Both
-- null for every thread so far: no project, and today's agent (the engineer).
alter table public.conversations
  add column project_id uuid references public.projects (id) on delete set null,
  add column agent_kind text check (agent_kind in ('engineer', 'product'));

create index conversations_project_idx
  on public.conversations (project_id)
  where project_id is not null;

alter table public.projects enable row level security;
alter table public.actor_roles enable row level security;
alter table public.approvals enable row level security;

-- The first migration takes default privileges away from Supabase's Data API roles; revoke
-- again here so these tables are closed even if that ever changed.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.projects, public.actor_roles, public.approvals
      from anon, authenticated;
  end if;
end
$$;
