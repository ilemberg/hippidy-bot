import { z } from "zod";
import { STARTING_PREFIX } from "./conversations.ts";
import type { Db } from "./db.ts";
import { toJsonText } from "./json.ts";

// The record (slice 3): the agent runtime's events and usage, kept so a conversation can be
// rebuilt from the database alone (decision 75). Nothing here decides what the conversation
// loop does; it only keeps what happened.

/** One agent runtime event to keep: as reported, plus what the API makes of it. */
export interface AgentEventToStore {
  id: string;
  /** The runtime's own name for the event, for example "agent.message". */
  type: string;
  /** The AgentRuntime interface's kind, or null for events the API only records. */
  kind: string | null;
  /** The text of an agent message; null for everything else. */
  text: string | null;
  /** The runtime's clock, as an ISO 8601 timestamp. Null while a user message is queued. */
  processedAt: string | null;
  /** The event as the runtime sent it: anything JSON can hold. */
  payload: unknown;
}

/** Events are written this many at a time, so one statement stays a reasonable size. */
const STORE_BATCH = 200;

/**
 * Keeps a session's events. An event is stored once. Storing it again updates the row only if
 * the runtime now reports it differently (a queued user message gains its processed time
 * later, decision 85); an event that has not changed is not touched at all. A processed time
 * is never taken away again, so a list read earlier cannot undo one read later. Returns how
 * many rows were added or changed.
 */
export async function storeAgentEvents(
  db: Db,
  conversationId: string,
  sessionId: string,
  events: readonly AgentEventToStore[],
): Promise<number> {
  // One statement cannot touch a row twice: the last report of an event wins.
  const latest = [...new Map(events.map((event) => [event.id, event])).values()];
  let written = 0;
  for (let start = 0; start < latest.length; start += STORE_BATCH) {
    const items = latest.slice(start, start + STORE_BATCH).map((event) => ({
      event_id: event.id,
      type: event.type,
      kind: event.kind,
      text: event.text,
      processed_at: event.processedAt,
      payload: event.payload ?? null,
    }));
    const rows = await db.query(
      `with given as (
         select e.item ->> 'event_id' as event_id, e.item ->> 'type' as type,
                e.item ->> 'kind' as kind, e.item ->> 'text' as text,
                (e.item ->> 'processed_at')::timestamptz as processed_at,
                e.item -> 'payload' as payload, e.position
         from jsonb_array_elements($3::text::jsonb) with ordinality as e(item, position)
       )
       insert into agent_events
         (conversation_id, agent_session_id, event_id, type, kind, text, processed_at, payload)
       select $1::uuid, $2::text, g.event_id, g.type, g.kind, g.text, g.processed_at, g.payload
       from given g
       where not exists (
         select 1 from agent_events a
         where a.conversation_id = $1::uuid and a.event_id = g.event_id
           and (a.type, a.kind, a.text, a.processed_at, a.payload)
               is not distinct from (g.type, g.kind, g.text, g.processed_at, g.payload))
       order by g.position
       on conflict (conversation_id, event_id) do update
         set type = excluded.type, kind = excluded.kind, text = excluded.text,
             processed_at = excluded.processed_at, payload = excluded.payload,
             updated_at = now()
         where not (agent_events.processed_at is not null and excluded.processed_at is null)
       returning event_id`,
      [conversationId, sessionId, toJsonText(items)],
    );
    written += rows.length;
  }
  return written;
}

/**
 * When the session's latest stored event was processed, or undefined if none is stored. A
 * sync asks the runtime only for events from then on (decision 95).
 */
export async function latestStoredEventTime(
  db: Db,
  conversationId: string,
  sessionId: string,
): Promise<Date | undefined> {
  const rows = await db.query(
    `select max(processed_at) as latest from agent_events
     where conversation_id = $1 and agent_session_id = $2`,
    [conversationId, sessionId],
  );
  const latest = z.object({ latest: z.coerce.date().nullable() }).parse(rows[0]).latest;
  return latest ?? undefined;
}

/**
 * The stored payloads of the session's events the loop acts on (those with a kind), in the
 * order the runtime processed them, queued messages last. Small rows only: tool calls and
 * their output, which make up most of a coding session, have no kind.
 */
export async function storedEventsToActOn(
  db: Db,
  conversationId: string,
  sessionId: string,
): Promise<unknown[]> {
  const rows = await db.query(
    `select payload from agent_events
     where conversation_id = $1 and agent_session_id = $2 and kind is not null
     order by processed_at asc nulls last, seq asc`,
    [conversationId, sessionId],
  );
  return rows.map((row) => z.object({ payload: z.unknown() }).parse(row).payload);
}

/**
 * Notes that the session's events are in the record as of now. Conversations never marked
 * are the ones the backfill still has to visit. Leaves `updated_at` alone: that column orders
 * the reconcile job's work and times out session starts.
 */
export async function markAgentEventsSynced(db: Db, conversationId: string): Promise<void> {
  await db.query(`update conversations set agent_events_synced_at = now() where id = $1`, [
    conversationId,
  ]);
}

/**
 * A session's cumulative use and budget, as its runtime reports them. Money is in minor units
 * of `currency` (cents for USD).
 */
export interface UsageToStore {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  activeSeconds: number | null;
  listCostMinor: number | null;
  budgetMinor: number | null;
  currency: string | null;
}

/**
 * Keeps the usage of the conversation's session. Usage only ever grows, so each number keeps
 * the larger of what is stored and what is given: a reading that arrives late cannot put an
 * older figure back, and a number the runtime did not report keeps its earlier value. If the
 * runtime reported nothing at all, nothing changes. Returns whether anything was written.
 */
export async function recordUsage(
  db: Db,
  conversationId: string,
  usage: UsageToStore,
): Promise<boolean> {
  const { currency, ...numbers } = usage;
  if (Object.values(numbers).every((value) => value === null)) return false;
  await db.query(
    `update conversations
     set usage_input_tokens = greatest(usage_input_tokens, $2::bigint),
         usage_output_tokens = greatest(usage_output_tokens, $3::bigint),
         usage_cache_read_tokens = greatest(usage_cache_read_tokens, $4::bigint),
         usage_cache_creation_tokens = greatest(usage_cache_creation_tokens, $5::bigint),
         usage_active_seconds = greatest(usage_active_seconds, $6::double precision),
         usage_list_cost_minor = greatest(usage_list_cost_minor, $7::bigint),
         budget_list_cost_minor = coalesce($8::bigint, budget_list_cost_minor),
         cost_currency = coalesce($9, cost_currency),
         usage_updated_at = now()
     where id = $1`,
    [
      conversationId,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheCreationTokens,
      usage.activeSeconds,
      usage.listCostMinor,
      usage.budgetMinor,
      currency,
    ],
  );
  return true;
}

export interface ConversationToBackfill {
  id: string;
  sessionId: string;
}

/**
 * Conversations with an agent session whose events were never stored (decision 80): the ones
 * from before the record existed, or whose record could not be written. A conversation
 * younger than `olderThanSeconds` is left alone: its own first sync stores it. In no
 * particular order, so one that keeps failing cannot hold up the rest. Conversations being
 * synced right now are skipped; the sync stores them.
 */
export async function conversationsToBackfill(
  db: Db,
  options: { olderThanSeconds: number; limit: number },
): Promise<ConversationToBackfill[]> {
  const rows = await db.query(
    `select id, agent_session_id from conversations
     where agent_events_synced_at is null
       and agent_session_id is not null and agent_session_id not like $1
       and created_at < now() - make_interval(secs => $2)
       and (sync_lease_until is null or sync_lease_until < now())
     order by random()
     limit $3`,
    [`${STARTING_PREFIX}%`, options.olderThanSeconds, options.limit],
  );
  return rows.map((row) => {
    const r = z.object({ id: z.string(), agent_session_id: z.string() }).parse(row);
    return { id: r.id, sessionId: r.agent_session_id };
  });
}
