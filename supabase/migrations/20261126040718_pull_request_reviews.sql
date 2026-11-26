-- Slice 4.3, part A (decision 219; `docs/planning/slice-4-3.md`): the checker, a built-in job
-- kind, and the reviews it posts on pull requests, each head commit reviewed once. Additive in
-- effect (decision 86): the kind check only grows.

alter table public.jobs drop constraint if exists jobs_kind_check;
alter table public.jobs
  add constraint jobs_kind_check check (kind in ('capture', 'briefs', 'checker'));

create table public.pull_request_reviews (
  id uuid primary key default gen_random_uuid(),
  -- `owner/name`, lowercase.
  repository text not null check (char_length(repository) between 3 and 200),
  number integer not null check (number > 0),
  head_sha text not null check (head_sha ~ '^[0-9a-f]{7,64}$'),
  -- The change the pull request belongs to, when one does.
  change_id uuid references public.changes (id) on delete set null,
  -- `pending` while a wake reviews it; `failed` is tried again on a later wake, at most three
  -- tries in all, then `abandoned`.
  status text not null default 'pending'
    check (status in ('pending', 'posted', 'failed', 'abandoned')),
  -- Tries started, the current one included.
  attempts integer not null default 1 check (attempts between 0 and 10),
  review_url text,
  body text check (body is null or char_length(body) <= 65000),
  -- What its model calls cost, all tries together, in millionths of a dollar.
  cost_micros bigint not null default 0 check (cost_micros >= 0),
  error text check (error is null or char_length(error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (repository, number, head_sha)
);

alter table public.pull_request_reviews enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.pull_request_reviews from anon, authenticated;
  end if;
end
$$;
