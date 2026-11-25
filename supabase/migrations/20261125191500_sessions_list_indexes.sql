-- Slice 2.4 (decision 197): indexes for `GET /v1/sessions`, found by its review. Additive only
-- (decision 86).

-- A thread's first message, for its title and who asked. Without it each listed thread read
-- every inbound message: 13 seconds at 3,000 threads in the review's measurement.
create index inbound_messages_conversation_sent_idx
  on public.inbound_messages (conversation_id, sent_at, created_at);

-- A session's latest words: one lookup instead of every event of the conversation.
create index agent_events_latest_message_idx
  on public.agent_events (conversation_id, agent_session_id, processed_at desc, seq desc)
  where kind = 'agent_message' and processed_at is not null;
