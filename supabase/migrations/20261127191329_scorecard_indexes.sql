-- Slice 4.5, part A (decision 223; `docs/planning/slice-4-5.md`): the scorecard counts each kind
-- of record by its time, this week and last. One index per count on that time, so each count
-- reads only its two weeks. Additive only (decision 86): indexes, nothing else.

-- Decisions made active: recorded active, or confirmed (`apps/api/src/store/scorecard.ts`).
create index if not exists decisions_made_active_idx
  on public.decisions ((coalesce(confirmed_at, decided_at)))
  where status in ('active', 'superseded');

create index if not exists conflicts_settled_idx
  on public.conflicts (source, workspace_id, settled_at)
  where settled_at is not null;

create index if not exists waits_ended_idx
  on public.waits (source, workspace_id, ended_at)
  where ended_at is not null;

create index if not exists change_briefs_started_idx
  on public.change_briefs (started_at)
  where started_at is not null;

-- A posted review is never updated again, so its `updated_at` is when it was posted.
create index if not exists pull_request_reviews_posted_idx
  on public.pull_request_reviews (updated_at)
  where status = 'posted';

create index if not exists goal_tickets_merged_idx
  on public.goal_tickets (settled_at)
  where state = 'merged';
