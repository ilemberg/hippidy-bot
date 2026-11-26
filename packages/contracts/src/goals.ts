import { z } from "zod";
import { taskKeySchema, taskProviderSchema } from "./tasks.ts";

// A feature goal (slice 4.4, decision 221): a job of kind `goal` that a signed-in person makes
// for a thread the bot is already in, with the tickets it works through in order. Each wake
// settles the changes it started and, under its limit, posts the next ticket's brief for a
// person to start.

const timestamp = z.iso.datetime({ offset: true });
const noNull = (value: string) => !value.includes("\u0000");
const noNullMessage = { message: "Must not contain a null character" };

/** Most tickets one goal lists. */
export const MAX_GOAL_TICKETS = 30;
/** The most changes a goal may have open at once, and how many unless a person says. */
export const MAX_GOAL_LIMIT = 5;
export const DEFAULT_GOAL_LIMIT = 2;
/** A goal's monthly cap unless a person says: $10 (rule 17). */
export const DEFAULT_GOAL_CAP_CENTS = 1000;
/** How often a goal wakes unless a person says, in minutes. */
export const DEFAULT_GOAL_EVERY_MINUTES = 10;

/**
 * A goal's name, which is its job's name and is in its page's address: lowercase letters and
 * digits in words joined by hyphens, 1 to 60 characters.
 */
export const goalNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase letters, digits and hyphens, like export");

/** A goal's tickets, in order: 1 to 30 keys of the configured tracker, none twice. */
export const goalTicketsSchema = z
  .array(taskKeySchema)
  .min(1)
  .max(MAX_GOAL_TICKETS)
  .refine((keys) => new Set(keys).size === keys.length, { message: "A ticket is listed twice" });

const goalLimitSchema = z.number().int().min(1).max(MAX_GOAL_LIMIT);

/**
 * Where a ticket is. `pending`: not briefed yet; `briefed`: its brief is posted and its change
 * open (waiting for Start, started, or with a pull request not yet merged or closed);
 * `merged`, `closed` (without merging) and `stopped`: its change settled; `done_elsewhere`: its
 * task was done before the goal briefed it; `skipped`: its brief could not be written three
 * times in a row, or the tracker no longer has it.
 */
export const goalTicketStateSchema = z.enum([
  "pending",
  "briefed",
  "merged",
  "closed",
  "stopped",
  "done_elsewhere",
  "skipped",
]);
export type GoalTicketState = z.infer<typeof goalTicketStateSchema>;

/** One ticket of a goal, with its change once it has one. */
export const goalTicketSchema = z.strictObject({
  key: z.string(),
  /** Its title as the tracker gave it when it was added or last briefed. */
  title: z.string(),
  /** Where to open it in the tracker; null for a built-in task (its page is the web app's). */
  url: z.string().nullable(),
  state: goalTicketStateSchema,
  change: z
    .strictObject({
      id: z.guid(),
      status: z.enum(["waiting_for_start", "started", "stopped"]),
      pullRequestUrl: z.string().nullable(),
    })
    .nullable(),
  /** Model calls in a row that gave no brief for it; at three it is skipped. */
  failures: z.number().int().min(0),
  settledAt: timestamp.nullable(),
});
export type GoalTicket = z.infer<typeof goalTicketSchema>;

/** A goal job's thread, limit and tickets, in order. */
export const goalSchema = z.strictObject({
  conversationId: z.guid(),
  channelId: z.string(),
  threadId: z.string(),
  /** The most changes it has open at once. */
  limit: goalLimitSchema,
  /** Tickets `briefed` now. */
  open: z.number().int().min(0),
  provider: taskProviderSchema,
  tickets: z.array(goalTicketSchema),
});
export type Goal = z.infer<typeof goalSchema>;

/** Body of `POST /v1/goals`, from a signed-in person: the goal, its thread and its tickets. */
export const createGoalRequestSchema = z.strictObject({
  name: goalNameSchema,
  /** The goal in words, which every brief is written toward. */
  goal: z.string().trim().min(1).max(2000).refine(noNull, noNullMessage),
  /** The thread it speaks in, which must already have a conversation. */
  channelId: z.string().trim().min(1).max(255).refine(noNull, noNullMessage),
  threadId: z.string().trim().min(1).max(255).refine(noNull, noNullMessage),
  tickets: goalTicketsSchema,
  limit: goalLimitSchema.default(DEFAULT_GOAL_LIMIT),
  capCents: z.number().int().min(0).max(10_000).default(DEFAULT_GOAL_CAP_CENTS),
  everyMinutes: z.number().int().min(1).max(1440).default(DEFAULT_GOAL_EVERY_MINUTES),
});
export type CreateGoalRequest = z.input<typeof createGoalRequestSchema>;

/**
 * Body of `PATCH /v1/goals/:jobId`: its tickets as they should be, in order (add, remove one not
 * yet briefed, reorder), and its limit, on the job's version seen.
 */
export const editGoalRequestSchema = z
  .strictObject({
    version: z.number().int().positive(),
    tickets: goalTicketsSchema.optional(),
    limit: goalLimitSchema.optional(),
  })
  .refine((e) => e.tickets !== undefined || e.limit !== undefined, {
    message: "Change the tickets or the limit",
  });
export type EditGoalRequest = z.infer<typeof editGoalRequestSchema>;

/**
 * What making or changing a goal did. `no_thread`: the bot has no conversation in that thread
 * yet; `thread_taken`: the thread has a goal already; `name_taken`: a job has that name;
 * `unknown_tickets`: the tracker has no such tickets (named in `tickets`);
 * `tracker_unavailable`: the tracker could not say; `briefed_tickets`: a ticket left out has
 * been briefed, so it stays (named in `tickets`); `changed`: edited since the version named;
 * `not_found`: no such goal.
 */
export const goalActionResultSchema = z.strictObject({
  status: z.enum([
    "created",
    "edited",
    "unchanged",
    "changed",
    "not_found",
    "no_thread",
    "thread_taken",
    "name_taken",
    "unknown_tickets",
    "tracker_unavailable",
    "briefed_tickets",
  ]),
  /** The goal's job name, once it is made or changed. */
  name: z.string().optional(),
  tickets: z.array(z.string()).optional(),
});
export type GoalActionResult = z.infer<typeof goalActionResultSchema>;
