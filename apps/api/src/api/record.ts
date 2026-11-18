import {
  SessionNotFoundError,
  type AgentEventRecord,
  type AgentRuntime,
} from "../agent/runtime.ts";
import type { Logger } from "../log.ts";
import type { Db } from "../store/db.ts";
import {
  conversationsToBackfill,
  markAgentEventsSynced,
  recordUsage,
  storeAgentEvents,
  type AgentEventToStore,
} from "../store/record.ts";

// Keeping the record (slice 3): what the agent runtime reported, stored beside the
// conversation loop. Keeping it must never cost someone their answer, so nothing here throws:
// a failure is logged, and the next sync or the backfill tries again.

export interface RecordDeps {
  db: Db;
  runtime: AgentRuntime;
}

/** Conversations from before the record existed that one reconcile run catches up on. */
export const BACKFILL_PER_RUN = 3;

function toStore(record: AgentEventRecord): AgentEventToStore {
  const event = record.event;
  return {
    id: record.id,
    type: record.type,
    kind: event?.kind ?? null,
    text: event?.kind === "agent_message" ? event.text : null,
    processedAt: record.processedAt,
    payload: record.payload,
  };
}

/** Stores a session's events as just listed. Returns false, after logging, if it could not. */
export async function keepEvents(
  db: Db,
  conversationId: string,
  sessionId: string,
  records: readonly AgentEventRecord[],
  log: Logger,
): Promise<boolean> {
  try {
    const written = await storeAgentEvents(db, conversationId, sessionId, records.map(toStore));
    await markAgentEventsSynced(db, conversationId);
    if (written > 0) log.info("record.events_stored", { conversationId, written });
    return true;
  } catch (error) {
    log.error("record.events_failed", { conversationId, sessionId, error });
    return false;
  }
}

/** Reads the session's usage from the runtime and stores it. Logs, never throws. */
export async function keepUsage(
  deps: RecordDeps,
  conversationId: string,
  sessionId: string,
  log: Logger,
): Promise<void> {
  try {
    await recordUsage(deps.db, conversationId, await deps.runtime.readUsage(sessionId));
  } catch (error) {
    log.warn("record.usage_failed", { conversationId, sessionId, error });
  }
}

/**
 * Catches up a few conversations whose events were never stored (decision 80): those from
 * before the record existed. A session the runtime no longer has is marked as visited, so it
 * is not tried for ever; any other failure is left for a later run. Returns how many
 * conversations were dealt with.
 */
export async function backfillRecord(deps: RecordDeps, log: Logger): Promise<number> {
  let done = 0;
  try {
    for (const { id, sessionId } of await conversationsToBackfill(deps.db, BACKFILL_PER_RUN)) {
      try {
        const records = await deps.runtime.listEvents(sessionId);
        if (!(await keepEvents(deps.db, id, sessionId, records, log))) continue;
        await keepUsage(deps, id, sessionId, log);
        log.info("record.backfilled", { conversationId: id, events: records.length });
        done++;
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          await markAgentEventsSynced(deps.db, id);
          log.warn("record.backfill_session_gone", { conversationId: id, sessionId });
          done++;
        } else {
          log.error("record.backfill_failed", { conversationId: id, sessionId, error });
        }
      }
    }
  } catch (error) {
    log.error("record.backfill_failed", { error });
  }
  return done;
}
