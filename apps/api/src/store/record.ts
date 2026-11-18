import { z } from "zod";
import { STARTING_PREFIX } from "./conversations.ts";
import type { Db } from "./db.ts";

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
  /** The runtime's clock. Null while a user message waits in the session's queue. */
  processedAt: Date | null;
  /** The event as the runtime sent it: anything JSON can hold. */
  payload: unknown;
}

/** Events are written this many at a time, so one statement stays a reasonable size. */
const STORE_BATCH = 200;

/**
 * Keeps a session's events. An event is stored once; storing it again updates the row only
 * if the runtime now reports it differently (a queued user message gains its processed time
 * later, decision 85) and otherwise changes nothing. Returns how many rows were added or
 * changed.
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
      processed_at: event.processedAt === null ? null : event.processedAt.toISOString(),
      payload: event.payload ?? null,
    }));
    // The parameter is cast from text: the production client would otherwise send a string
    // as a JSON string, not as the JSON it holds.
    const rows = await db.query(
      `insert into agent_events
         (conversation_id, agent_session_id, event_id, type, kind, text, processed_at, payload)
       select $1::uuid, $2::text, e.item ->> 'event_id', e.item ->> 'type', e.item ->> 'kind',
              e.item ->> 'text', (e.item ->> 'processed_at')::timestamptz, e.item -> 'payload'
       from jsonb_array_elements($3::text::jsonb) with ordinality as e(item, position)
       order by e.position
       on conflict (conversation_id, event_id) do update
         set type = excluded.type, kind = excluded.kind, text = excluded.text,
             processed_at = excluded.processed_at, payload = excluded.payload,
             updated_at = now()
         where (agent_events.type, agent_events.kind, agent_events.text,
                agent_events.processed_at, agent_events.payload)
               is distinct from
               (excluded.type, excluded.kind, excluded.text,
                excluded.processed_at, excluded.payload)
       returning event_id`,
      [conversationId, sessionId, toJson(items)],
    );
    written += rows.length;
  }
  return written;
}

/** JSON text Postgres accepts: it cannot store the null character inside a string. */
function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "string" ? item.replaceAll("\u0000", "") : item,
  );
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
 * Keeps the latest usage of the conversation's session. A number the runtime did not report
 * keeps its earlier value; if it reported nothing at all, nothing changes. Returns whether
 * anything was written.
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
     set usage_input_tokens = coalesce($2, usage_input_tokens),
         usage_output_tokens = coalesce($3, usage_output_tokens),
         usage_cache_read_tokens = coalesce($4, usage_cache_read_tokens),
         usage_cache_creation_tokens = coalesce($5, usage_cache_creation_tokens),
         usage_active_seconds = coalesce($6, usage_active_seconds),
         usage_list_cost_minor = coalesce($7, usage_list_cost_minor),
         budget_list_cost_minor = coalesce($8, budget_list_cost_minor),
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
 * from before the record existed. In no particular order, so one that keeps failing cannot
 * hold up the rest. Conversations being synced right now are skipped; the sync stores them.
 */
export async function conversationsToBackfill(
  db: Db,
  limit: number,
): Promise<ConversationToBackfill[]> {
  const rows = await db.query(
    `select id, agent_session_id from conversations
     where agent_events_synced_at is null
       and agent_session_id is not null and agent_session_id not like $1
       and (sync_lease_until is null or sync_lease_until < now())
     order by random()
     limit $2`,
    [`${STARTING_PREFIX}%`, limit],
  );
  return rows.map((row) => {
    const r = z.object({ id: z.string(), agent_session_id: z.string() }).parse(row);
    return { id: r.id, sessionId: r.agent_session_id };
  });
}
