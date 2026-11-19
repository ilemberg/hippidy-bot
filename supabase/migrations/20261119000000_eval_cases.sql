-- Slice 4, pull request E (decisions 121, 127): every request is kept as a candidate eval
-- case, as a view over the record. Your verdict on each case waits for slice 6.
--
-- One row per message a person sent (stop messages left out): what they asked, how it ended
-- (answered, failed, stopped), and the pull request the agent opened, updated or read after
-- the message was handed over, if any. The experiment showed a pull request appears in the
-- events as a GitHub tool's result whose text holds the pull request's `html_url`; the loop
-- stores those with kind 'pull_request' (decision 132). The base commit is not in the record;
-- GitHub keeps it on the pull request.
--
-- Only adds a view: the code before and after it never reads it.
-- security_invoker: the view gives no more access than the tables under it.
create view public.eval_cases
with (security_invoker = true) as
select
  m.id as message_id,
  m.conversation_id,
  c.agent_session_id,
  m.sent_at,
  m.actor_id,
  m.actor_name,
  m.text as request,
  m.status,
  pr.url as pull_request_url,
  -- What the whole conversation cost so far, in minor units of cost_currency.
  c.usage_list_cost_minor as conversation_cost_minor,
  c.cost_currency
from public.inbound_messages m
join public.conversations c on c.id = m.conversation_id
left join lateral (
  select substring(e.payload::text from 'https://github\.com/[^/"\\]+/[^/"\\]+/pull/[0-9]+') as url
  from public.agent_events e
  where e.conversation_id = m.conversation_id
    and e.kind = 'pull_request'
    and m.forwarded_at is not null
    and e.processed_at >= m.forwarded_at
  order by e.processed_at desc, e.seq desc
  limit 1
) pr on true
where m.text <> 'stop';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.eval_cases from anon, authenticated;
  end if;
end
$$;
