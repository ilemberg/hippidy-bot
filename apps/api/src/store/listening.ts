import {
  OBSERVED_MESSAGE_RETENTION_DAYS,
  messageSourceSchema,
  type ListeningChannel,
  type MessageSource,
  type Observation,
  type ObservationResult,
  type SetListeningRequest,
} from "@hippidy/contracts";
import { z } from "zod";
import type { Db, Row } from "./db.ts";
import { storable } from "./json.ts";

// Listening in channels (slice 2.5, decisions 198 and 199). A message is written only when its
// channel is listened to; it is kept as text, never the source's payload, for 30 days.

const channelRow = z.object({
  source: messageSourceSchema,
  workspace_id: z.string(),
  channel_id: z.string(),
  listening: z.boolean(),
  started_at: z.date(),
  changed_at: z.date(),
  changed_by_actor_id: z.string(),
  changed_by_name: z.string().nullable(),
});

const channelColumns = `source, workspace_id, channel_id, listening, started_at, changed_at,
  changed_by_actor_id, changed_by_name`;

function toChannel(r: Row): ListeningChannel {
  const d = channelRow.parse(r);
  return {
    source: d.source,
    workspaceId: d.workspace_id,
    channelId: d.channel_id,
    listening: d.listening,
    startedAt: d.started_at.toISOString(),
    changedAt: d.changed_at.toISOString(),
    changedBy: { actorId: d.changed_by_actor_id, name: d.changed_by_name },
  };
}

/**
 * Switches listening on or off in a channel. Switching it to what it already is changes
 * nothing, so a command sent twice posts its note once.
 */
export async function setListening(
  db: Db,
  request: SetListeningRequest,
): Promise<{ changed: boolean; channel: ListeningChannel }> {
  return db.transaction(async (tx) => {
    // `for update` locks nothing before the channel's first row exists: two first "listen"
    // commands at once would both post a note. A lock on the channel's key serializes them.
    await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [
      `listening:${request.source}:${request.workspaceId}:${request.channelId}`,
    ]);
    const existing = await tx.query(
      `select ${channelColumns} from listening_channels
       where source = $1 and workspace_id = $2 and channel_id = $3 for update`,
      [request.source, request.workspaceId, request.channelId],
    );
    const current = existing[0] === undefined ? undefined : toChannel(existing[0]);
    if (current?.listening === request.listening) return { changed: false, channel: current };
    if (current === undefined && !request.listening) {
      // Never listened to: nothing to switch off, and nothing to record.
      const now = new Date().toISOString();
      return {
        changed: false,
        channel: {
          source: request.source,
          workspaceId: request.workspaceId,
          channelId: request.channelId,
          listening: false,
          startedAt: now,
          changedAt: now,
          changedBy: { actorId: request.actor.id, name: request.actor.displayName ?? null },
        },
      };
    }
    const rows = await tx.query(
      `insert into listening_channels (source, workspace_id, channel_id, listening, started_at,
         changed_by_actor_id, changed_by_name, changed_at)
       values ($1, $2, $3, $4, now(), $5, $6, now())
       on conflict (source, workspace_id, channel_id) do update set
         listening = excluded.listening,
         started_at = case when excluded.listening then now()
                           else listening_channels.started_at end,
         changed_by_actor_id = excluded.changed_by_actor_id,
         changed_by_name = excluded.changed_by_name,
         changed_at = now()
       returning ${channelColumns}`,
      [
        request.source,
        request.workspaceId,
        request.channelId,
        request.listening,
        request.actor.id,
        request.actor.displayName ?? null,
      ],
    );
    const row = rows[0];
    if (row === undefined) throw new Error("listening channel was not written");
    return { changed: true, channel: toChannel(row) };
  });
}

/** Every channel listening was ever switched on in, listened ones first. */
export async function listListening(db: Db): Promise<ListeningChannel[]> {
  const rows = await db.query(
    `select ${channelColumns} from listening_channels
     order by listening desc, changed_at desc`,
  );
  return rows.map(toChannel);
}

/**
 * Keeps, updates or deletes a message of a channel, if the channel is listened to. A message
 * that arrives twice (a source retrying) is kept once. A new message makes its thread due for
 * capture again and clears its failures.
 */
export async function recordObservation(
  db: Db,
  observation: Observation,
): Promise<ObservationResult["result"]> {
  const key = [
    observation.source,
    observation.workspaceId,
    observation.channelId,
    observation.messageId,
  ];
  switch (observation.kind) {
    case "deleted": {
      // Followed whether or not the channel is still listened to: what was kept goes.
      return db.transaction(async (tx) => {
        const rows = await tx.query(
          `delete from observed_messages
           where source = $1 and workspace_id = $2 and channel_id = $3 and message_id = $4
           returning thread_id`,
          key,
        );
        const threadId = rows[0]?.thread_id;
        if (typeof threadId !== "string") return "not_found";
        await tx.query(
          `update observed_threads set message_count = greatest(message_count - 1, 0),
             updated_at = now()
           where source = $1 and workspace_id = $2 and channel_id = $3 and thread_id = $4`,
          [observation.source, observation.workspaceId, observation.channelId, threadId],
        );
        return "deleted";
      });
    }
    case "edited": {
      // An edit is new activity: the thread is read again once it is quiet, so a decision
      // changed by an edit is not missed.
      return db.transaction(async (tx) => {
        const rows = await tx.query(
          `update observed_messages set text = $5, edited_at = $6
           where source = $1 and workspace_id = $2 and channel_id = $3 and message_id = $4
           returning thread_id`,
          [...key, storable(observation.text), observation.editedAt],
        );
        const threadId = rows[0]?.thread_id;
        if (typeof threadId !== "string") return "not_found";
        await tx.query(
          `update observed_threads
           set last_message_at = greatest(last_message_at, $5), updated_at = now()
           where source = $1 and workspace_id = $2 and channel_id = $3 and thread_id = $4`,
          [
            observation.source,
            observation.workspaceId,
            observation.channelId,
            threadId,
            observation.editedAt,
          ],
        );
        return "updated";
      });
    }
    case "posted": {
      return db.transaction(async (tx) => {
        const listening = await tx.query(
          `select 1 from listening_channels
           where source = $1 and workspace_id = $2 and channel_id = $3 and listening`,
          [observation.source, observation.workspaceId, observation.channelId],
        );
        if (listening.length === 0) return "not_listening";
        const inserted = await tx.query(
          `insert into observed_messages (source, workspace_id, channel_id, message_id,
             thread_id, actor_id, actor_name, text, sent_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           on conflict (source, workspace_id, channel_id, message_id) do nothing
           returning id`,
          [
            ...key,
            observation.threadId,
            observation.actor.id,
            observation.actor.displayName ?? null,
            storable(observation.text),
            observation.sentAt,
          ],
        );
        if (inserted.length === 0) return "already_kept";
        await tx.query(
          `insert into observed_threads (source, workspace_id, channel_id, thread_id,
             last_message_at, message_count)
           values ($1, $2, $3, $4, $5, 1)
           on conflict (source, workspace_id, channel_id, thread_id) do update set
             last_message_at = greatest(observed_threads.last_message_at,
                                        excluded.last_message_at),
             message_count = observed_threads.message_count + 1,
             -- A message that arrives late, older than what capture read, is read next time.
             captured_through = case
               when observed_threads.captured_through >= excluded.last_message_at then null
               else observed_threads.captured_through end,
             capture_failures = 0,
             updated_at = now()`,
          [
            observation.source,
            observation.workspaceId,
            observation.channelId,
            observation.threadId,
            observation.sentAt,
          ],
        );
        return "kept";
      });
    }
  }
}

/**
 * Deletes messages sent more than 30 days ago (G8), and threads whose last message is that old.
 * A decision proposed from them keeps its own copy of where it came from.
 */
export async function deleteExpiredObservations(
  db: Db,
  now: Date,
): Promise<{ messages: number; threads: number }> {
  const cutoff = new Date(now.getTime() - OBSERVED_MESSAGE_RETENTION_DAYS * 86_400_000);
  const messages = await db.query(`delete from observed_messages where sent_at < $1 returning id`, [
    cutoff.toISOString(),
  ]);
  const threads = await db.query(
    `delete from observed_threads where last_message_at < $1 returning id`,
    [cutoff.toISOString()],
  );
  return { messages: messages.length, threads: threads.length };
}

/** Where a listened thread is. */
export interface ObservedThread {
  id: string;
  source: MessageSource;
  workspaceId: string;
  channelId: string;
  threadId: string;
  lastMessageAt: string;
}
