-- Slice 5A (decision 170): one person may hold more than one role. Until the team has more
-- people, the owner is both the product manager and the engineering manager, and their one
-- approval counts for both.
--
-- `actor_roles.role` stays the person's main role, which chooses their thread's agent as
-- before; `extra_roles` holds the others. An approval copies both onto its row, so a later
-- change of roles does not rewrite it.
--
-- Additive only (decision 86): columns with defaults. The code before this never reads them
-- and keeps working while it is deployed.
alter table public.actor_roles
  add column extra_roles text[] not null default '{}' check (
    extra_roles <@ array[
      'engineering_manager', 'product_manager', 'tech_lead', 'engineer', 'qa', 'designer'
    ]::text[]
    and not (role = any (extra_roles))
  );

alter table public.approvals
  add column extra_roles text[] not null default '{}' check (
    extra_roles <@ array[
      'engineering_manager', 'product_manager', 'tech_lead', 'engineer', 'qa', 'designer'
    ]::text[]
  );
