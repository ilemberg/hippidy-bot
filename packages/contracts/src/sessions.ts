import { z } from "zod";
import { messageSourceSchema } from "./messages.ts";

// The agents at work (slice 2.4, the Dashboard v1 plan): every thread's own session and every
// change's coding worker, as people see them on the monitoring page. Read from the database
// alone (decision 79), never from the agent runtime.

const timestamp = z.iso.datetime({ offset: true });

export const sessionKindSchema = z.enum(["thread", "worker"]);
export type SessionKind = z.infer<typeof sessionKindSchema>;

/**
 * What a session is doing. `working`: it has a message or brief it has not finished with.
 * `waiting_for_start`: a worker's brief waits for a person to press Start. `idle`: nothing to
 * do. `failed`: its last message failed, or it can take no more (its budget, its end).
 * `stopped`: someone stopped it.
 */
export const activityStateSchema = z.enum([
  "working",
  "waiting_for_start",
  "idle",
  "failed",
  "stopped",
]);
export type ActivityState = z.infer<typeof activityStateSchema>;

export const sessionActivitySchema = z.strictObject({
  kind: sessionKindSchema,
  conversationId: z.guid(),
  /** For a worker, its change. */
  changeId: z.guid().nullable(),
  /** A thread's first message, shortened; a worker's latest brief title. */
  title: z.string(),
  /** The agent that runs it: the thread's agent, or `worker` for a change's coding worker. */
  agent: z.enum(["teammate", "engineer", "product", "worker"]),
  state: activityStateSchema,
  /** Who started it: the thread's first sender, or who asked for the change. */
  askedBy: z.strictObject({ actorId: z.string(), name: z.string().nullable() }).nullable(),
  project: z.strictObject({ id: z.guid(), name: z.string() }).nullable(),
  /** The agent's latest words, shortened, and when. */
  latestActivity: z.strictObject({ at: timestamp, text: z.string() }).nullable(),
  /** Spent so far and the cap, in minor units of `currency` (cents for USD). */
  cost: z.strictObject({
    spentMinor: z.number().nullable(),
    budgetMinor: z.number().nullable(),
    currency: z.string().nullable(),
  }),
  startedAt: timestamp,
  /** Where people talk to it. */
  thread: z.strictObject({
    source: messageSourceSchema,
    workspaceId: z.string(),
    channelId: z.string(),
    threadId: z.string(),
  }),
});
export type SessionActivity = z.infer<typeof sessionActivitySchema>;

/** Query of `GET /v1/sessions`. */
export const listSessionsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;

/** Response of `GET /v1/sessions`: the ones at work first, then the most recently active. */
export const sessionListSchema = z.strictObject({ sessions: z.array(sessionActivitySchema) });
export type SessionList = z.infer<typeof sessionListSchema>;
