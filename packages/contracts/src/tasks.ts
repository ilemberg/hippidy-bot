import { z } from "zod";

// Tasks behind a provider, and the waiting-on list (slice 3.3, decision 210).

const timestamp = z.iso.datetime({ offset: true });
const noNull = (value: string) => !value.includes("\u0000");
const noNullMessage = { message: "Must not contain a null character" };
const person = z.strictObject({ actorId: z.string(), name: z.string().nullable() });

export const taskProviderSchema = z.enum(["builtin", "jira"]);
export type TaskProvider = z.infer<typeof taskProviderSchema>;

export const taskStatusSchema = z.enum(["todo", "doing", "done"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** A task's key: `T-12` for the built-in tracker, `SCRUM-8` for Jira. */
export const taskKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{0,19}-[1-9][0-9]{0,8}$/, "a task key, like T-12 or SCRUM-8");

/** A thread linked to a task. */
export const taskThreadSchema = z.strictObject({
  conversationId: z.guid(),
  channelId: z.string(),
  threadId: z.string(),
  linkedAt: timestamp,
});

/** One task, the same whichever provider it comes from. */
export const taskSchema = z.strictObject({
  key: z.string(),
  title: z.string(),
  status: taskStatusSchema,
  /** The provider's own name for the status ("In Progress"). */
  statusName: z.string(),
  /** Who it is assigned to: a person the record knows (built-in), or a name (Jira). */
  assignee: z
    .strictObject({ actorId: z.string().nullable(), name: z.string().nullable() })
    .nullable(),
  /** Where to open it: the Jira issue, or null for a built-in task (its page is ours). */
  url: z.string().nullable(),
  updatedAt: timestamp,
});
export type Task = z.infer<typeof taskSchema>;

/** Query of `GET /v1/tasks`. */
export const listTasksQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(200).optional(),
  /** `open`: not done (the default); or one status; or all. */
  status: z.enum(["open", "todo", "doing", "done", "all"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

/**
 * Response of `GET /v1/tasks`. `available` false: the provider is not configured or did not
 * answer, and `problem` says which; `tasks` is then empty.
 */
export const taskListSchema = z.strictObject({
  provider: taskProviderSchema,
  available: z.boolean(),
  problem: z.enum(["not_configured", "unreachable"]).nullable(),
  tasks: z.array(taskSchema),
});
export type TaskList = z.infer<typeof taskListSchema>;

/** One change to a built-in task. */
export const taskEventSchema = z.strictObject({
  kind: z.enum(["created", "edited"]),
  actor: person,
  at: timestamp,
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()),
});
export type TaskEvent = z.infer<typeof taskEventSchema>;

/** Response of `GET /v1/tasks/:key`: a task, its threads and waits, and, built-in, more. */
export const taskDetailSchema = z.strictObject({
  provider: taskProviderSchema,
  task: taskSchema,
  /** A built-in task's description, id, version and history; null for Jira. */
  builtin: z
    .strictObject({
      id: z.guid(),
      description: z.string().nullable(),
      version: z.number().int().positive(),
      createdBy: person,
      createdAt: timestamp,
      history: z.array(taskEventSchema),
    })
    .nullable(),
  threads: z.array(taskThreadSchema),
  waits: z.array(z.lazy(() => waitSchema)),
});
export type TaskDetail = z.infer<typeof taskDetailSchema>;

const description = z.string().trim().max(4000).nullable().optional();

/** Body of `POST /v1/tasks` from a signed-in person (built-in tracker only). */
export const createTaskRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).refine(noNull, noNullMessage),
  description,
  status: taskStatusSchema.optional(),
  assigneeActorId: z.string().trim().min(1).max(40).nullable().optional(),
});
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

/** Body of `PATCH /v1/tasks/:id`: what changes, on the version seen. */
export const editTaskRequestSchema = z.strictObject({
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(200).refine(noNull, noNullMessage).optional(),
  description,
  status: taskStatusSchema.optional(),
  assigneeActorId: z.string().trim().min(1).max(40).nullable().optional(),
});
export type EditTaskRequest = z.infer<typeof editTaskRequestSchema>;

/**
 * What creating or editing a built-in task did. `changed`: edited since the version named.
 * `not_builtin`: the tasks come from Jira, so they are changed there. `unknown_person`: the
 * assignee is not someone the record knows.
 */
export const taskActionResultSchema = z.strictObject({
  status: z.enum([
    "created",
    "edited",
    "unchanged",
    "changed",
    "not_found",
    "not_builtin",
    "unknown_person",
  ]),
  task: taskSchema.optional(),
});
export type TaskActionResult = z.infer<typeof taskActionResultSchema>;

/** Someone waiting on someone else, for something. */
export const waitSchema = z.strictObject({
  id: z.guid(),
  number: z.number().int().positive(),
  waiter: person,
  waitingOn: person,
  what: z.string(),
  taskKey: z.string().nullable(),
  since: timestamp,
  /** Where it was said: a thread the bot is in, or null when recorded in the web app. */
  conversationId: z.guid().nullable(),
  channelId: z.string().nullable(),
  threadId: z.string().nullable(),
  recordedBy: person,
  status: z.enum(["open", "ended"]),
  endedBy: person.nullable(),
  endedAt: timestamp.nullable(),
});
export type Wait = z.infer<typeof waitSchema>;

/** Query of `GET /v1/waits`: open ones by default; those a person is part of. */
export const listWaitsQuerySchema = z.strictObject({
  status: z.enum(["open", "ended", "all"]).optional(),
  person: z.string().trim().min(1).max(40).optional(),
  task: taskKeySchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ListWaitsQuery = z.infer<typeof listWaitsQuerySchema>;

export const waitListSchema = z.strictObject({ waits: z.array(waitSchema) });
export type WaitList = z.infer<typeof waitListSchema>;

/** Body of `POST /v1/waits` from a signed-in person: their own wait. */
export const createWaitRequestSchema = z.strictObject({
  waitingOnActorId: z.string().trim().min(1).max(40),
  what: z.string().trim().min(1).max(300).refine(noNull, noNullMessage),
  taskKey: taskKeySchema.optional(),
});
export type CreateWaitRequest = z.infer<typeof createWaitRequestSchema>;

/** What recording or ending a wait did. */
export const waitActionResultSchema = z.strictObject({
  status: z.enum([
    "recorded",
    "ended",
    "already_ended",
    "not_allowed",
    "not_found",
    "unknown_person",
  ]),
  wait: waitSchema.optional(),
});
export type WaitActionResult = z.infer<typeof waitActionResultSchema>;
