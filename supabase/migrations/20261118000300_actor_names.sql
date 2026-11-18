-- Slice 2, pull request C: the sender's display name, so the agent can address people by name
-- (decision 34), including for messages handed over later by reconcile. Optional: a message
-- whose sender could not be looked up keeps working with the id alone.
alter table public.inbound_messages add column actor_name text;

