-- Fixes the transcript's notes. The production client stored each delivery's payload as a
-- JSON string holding JSON, not as the object itself, so `payload ->> 'text'` found nothing
-- and a note's text came out null. Found in slice 3, before anything read the view
-- (decision 90).
--
-- Safe with the code before and after it: both read a payload in either form. The code that
-- ships with this migration stores objects; until it is live, new rows may still be strings,
-- so the view accepts both.

-- Turn the payloads stored so far into objects, one row at a time. Text that jsonb cannot
-- hold (the null character, written as the escape \u0000) is removed first; a row that still
-- cannot be converted keeps its string, which the API reads as before, and is reported.
do $$
declare
  delivery record;
begin
  for delivery in
    select id, payload #>> '{}' as raw
    from public.deliveries
    where jsonb_typeof(payload) = 'string'
  loop
    begin
      update public.deliveries
      set payload = replace(delivery.raw, '\u0000', '')::jsonb
      where id = delivery.id;
    exception when others then
      raise notice 'delivery % keeps its payload as a string: %', delivery.id, sqlerrm;
    end;
  end loop;
end
$$;

-- The same view, reading a note's text from either form, with one new column at the end:
-- `position` breaks ties between lines of one kind that share a time (the order agent events
-- or notes were stored in). Order a transcript by (occurred_at, recorded_at, position).
-- Notes are the API's own fixed texts, so converting a string payload here cannot fail.
create or replace view public.conversation_transcript
with (security_invoker = true) as
select
  m.conversation_id,
  'user'::text as role,
  m.sent_at as occurred_at,
  m.text,
  m.actor_id,
  m.actor_name,
  m.message_id as ref,
  m.status as message_status,
  null::text as delivery_status,
  m.created_at as recorded_at,
  null::bigint as position
from public.inbound_messages m
union all
select
  e.conversation_id,
  'agent'::text,
  coalesce(e.processed_at, e.created_at),
  e.text,
  null::text,
  null::text,
  e.event_id,
  null::text,
  d.status,
  e.created_at,
  e.seq
from public.agent_events e
left join public.deliveries d
  on d.conversation_id = e.conversation_id and d.agent_event_id = e.event_id
where e.kind = 'agent_message'
union all
select
  d.conversation_id,
  'note'::text,
  d.created_at,
  (case
     when jsonb_typeof(d.payload) = 'string' then (d.payload #>> '{}')::jsonb
     else d.payload
   end) ->> 'text',
  null::text,
  null::text,
  d.agent_event_id,
  null::text,
  d.status,
  d.created_at,
  d.seq
from public.deliveries d
where d.kind = 'note';
