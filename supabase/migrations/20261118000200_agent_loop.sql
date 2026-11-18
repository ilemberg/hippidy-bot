-- The agent loop (slice 2, pull request B), on top of the storage tables.

-- Whether the thread's session can still take messages. A session that reached its budget or
-- ended cannot; later messages in that thread get a note instead of silence.
alter table public.conversations
  add column session_state text not null default 'active'
    check (session_state in ('active', 'budget_reached', 'terminated')),
  -- One sync of a conversation at a time (webhook and reconcile can overlap). A lease rather
  -- than a lock, so no transaction stays open while Slack or Anthropic is called.
  add column sync_lease_until timestamptz;

alter table public.inbound_messages
  -- The id the agent runtime gave the message when it was sent. A message is settled only
  -- once the runtime reports that event as processed before the turn ended.
  add column agent_event_id text,
  -- Failed attempts to hand the message to the agent; after a few, it is reported as failed.
  add column forward_attempts integer not null default 0;

-- Deliveries keep what they will send, so a failed one is retried from here, in order.
alter table public.deliveries
  add column payload jsonb,
  add column seq bigint generated always as identity;

alter table public.deliveries drop constraint deliveries_status_check;
alter table public.deliveries alter column status set default 'pending';
-- A queued delivery has not been attempted yet (it used to be claimed on its first attempt).
alter table public.deliveries alter column attempts set default 0;
alter table public.deliveries
  add constraint deliveries_status_check
    check (status in ('pending', 'sending', 'sent', 'failed', 'abandoned'));

alter table public.deliveries drop constraint deliveries_kind_check;
alter table public.deliveries
  add constraint deliveries_kind_check
    check (kind in ('reply', 'failure', 'stopped', 'status', 'note'));

drop index public.deliveries_unsent_idx;
create index deliveries_unsent_idx
  on public.deliveries (conversation_id, seq)
  where status in ('pending', 'sending', 'failed');
