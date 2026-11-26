import { randomUUID } from "node:crypto";
import {
  createTaskRequestSchema,
  editTaskRequestSchema,
  taskKeySchema,
  taskStatusSchema,
  type CreateTaskRequest,
  type EditTaskRequest,
  type Task,
  type TaskActionResult,
  type TaskDetail,
  type TaskList,
  type TaskProvider,
  type TaskStatus,
} from "@hippidy/contracts";
import {
  createTask,
  editTask,
  fetchPeople,
  fetchTask,
  fetchTasks,
  type ApiClientDeps,
  type ApiResult,
} from "./api-client.ts";
import type { Known } from "./areas.ts";
import { fromThisApp } from "./auth-flow.ts";
import type { WebConfig } from "./config.ts";
import { readCookie, SESSION_COOKIE } from "./cookies.ts";
import { nameOf, searchWords } from "./decisions.ts";
import { signedInPerson, type HomeDeps } from "./home.ts";
import { messageLink } from "./sessions-view.ts";
import type { Person } from "./tokens.ts";

// Tasks, from Jira or the built-in tracker (slice 3.3, decision 210): the list, one task's page
// with its threads and waits, and, for the built-in tracker, the forms that create or change
// one. Over the standard Request and Response, so it is tested without Next.js; the pages and
// route files only pass the real dependencies in.

/** The most the API gives in one list. */
export const TASKS_LIMIT = 100;

/** Where the form that creates a task posts. Not under `/tasks/`, where every segment is a key. */
export const CREATE_TASK_PATH = "/new-task";

/** Which tasks the list shows; `open` (not done) is the default. */
export const taskFilters = ["open", "done", "all"] as const;
export type TaskFilter = (typeof taskFilters)[number];

export const taskFilterLabel: Record<TaskFilter, string> = {
  open: "Open",
  done: "Done",
  all: "All",
};

/** A task's page. */
export function taskHref(key: string): string {
  return `/tasks/${encodeURIComponent(key)}`;
}

/** The list's address for a filter and words searched for. */
export function tasksHref(filter: TaskFilter, q?: string): string {
  const params = new URLSearchParams();
  if (q !== undefined) params.set("q", q);
  if (filter !== "open") params.set("status", filter);
  const search = params.toString();
  return search === "" ? "/tasks" : `/tasks?${search}`;
}

/** A task's key from its address, uppercased like the API does. Nothing when it cannot be one. */
export function taskKeyFromPath(text: string): string | undefined {
  let decoded = text;
  if (text.includes("%")) {
    try {
      decoded = decodeURIComponent(text);
    } catch {
      return undefined;
    }
  }
  const parsed = taskKeySchema.safeParse(decoded);
  return parsed.success ? parsed.data : undefined;
}

/** What an action did, as the page is told in its address. */
export const taskDone = ["created", "edited"] as const;
export type TaskDone = (typeof taskDone)[number];

/** Why an action did nothing, as the page is told in its address. */
export const taskErrors = [
  "invalid",
  "unchanged",
  "changed",
  "not_found",
  "not_builtin",
  "unknown_person",
  "signed_out",
  "unavailable",
  "failed",
] as const;
export type TaskError = (typeof taskErrors)[number];

export type TaskNotice = { kind: "done"; done: TaskDone } | { kind: "error"; error: TaskError };

/** The notice for `?done=` or `?error=`, if it is one this app sends. */
export function taskNotice(
  done: string | undefined,
  error: string | undefined,
): TaskNotice | undefined {
  const isDone = taskDone.find((value) => value === done);
  if (isDone !== undefined) return { kind: "done", done: isDone };
  const isError = taskErrors.find((value) => value === error);
  return isError === undefined ? undefined : { kind: "error", error: isError };
}

/** The sentence a notice from an action shows. */
export function taskNoticeText(notice: TaskNotice): string {
  if (notice.kind === "done") {
    switch (notice.done) {
      case "created":
        return "Created.";
      case "edited":
        return "Saved.";
    }
  }
  switch (notice.error) {
    case "invalid":
      return "Not saved: a title is 1 to 200 characters, a description at most 4,000.";
    case "unchanged":
      return "Nothing was changed.";
    case "changed":
      return "Someone changed this task after you opened it, so nothing was saved. Read it again below, then try again.";
    case "not_found":
      return "There is no such task.";
    case "not_builtin":
      return "The team's tasks are in Jira, so they are created and changed there.";
    case "unknown_person":
      return "Not saved: assign it to someone the bot knows, chosen from the list.";
    case "signed_out":
      return "Your sign-in has ended. Sign in again, then try again.";
    case "unavailable":
      return "Sign-in is not set up yet.";
    case "failed":
      return "The API did not answer in time. Reload the page to see whether it was saved, then try again if not.";
  }
}

/** What the tasks page shows. */
export type TasksView =
  | { kind: "unconfigured" }
  | { kind: "signed_out"; notice: TaskNotice | undefined }
  | {
      kind: "signed_in";
      person: Person;
      filter: TaskFilter;
      q: string | undefined;
      list: ApiResult<TaskList>;
      /** Whom the create form offers as assignee. */
      people: ApiResult<Known[]>;
      /** Whether the API gave as many as it gives at once, so some may not be shown. */
      truncated: boolean;
      notice: TaskNotice | undefined;
      readAt: string;
    };

/** What the page of one task shows. */
export type TaskView =
  | { kind: "unconfigured" }
  | { kind: "signed_out"; notice: TaskNotice | undefined }
  | { kind: "not_found"; person: Person; key: string | undefined }
  | { kind: "failed"; person: Person; reason: string }
  | {
      kind: "ok";
      person: Person;
      detail: TaskDetail;
      people: ApiResult<Known[]>;
      notice: TaskNotice | undefined;
      readAt: string;
    };

function clientDeps(person: Person, config: WebConfig, deps: HomeDeps, now: Date): ApiClientDeps {
  const correlationId = randomUUID();
  return {
    fetch: deps.fetch,
    apiBaseUrl: config.apiBaseUrl,
    apiSecret: config.apiSecret,
    log: deps.log.child({ correlationId, actorId: person.actorId }),
    correlationId,
    now: () => now,
  };
}

const isFilter = (value: string | undefined): value is TaskFilter =>
  taskFilters.some((filter) => filter === value);

/** Reads the session cookie and, for a signed-in person, the tasks asked for and the people. */
export async function loadTasks(
  input: {
    sessionCookie: string | undefined;
    q: string | undefined;
    status: string | undefined;
    done: string | undefined;
    error: string | undefined;
  },
  deps: HomeDeps,
): Promise<TasksView> {
  const config = deps.config;
  if (config === undefined) return { kind: "unconfigured" };
  const now = deps.now?.() ?? new Date();
  const notice = taskNotice(input.done, input.error);
  const person = await signedInPerson(input.sessionCookie, config, now);
  if (person === undefined) return { kind: "signed_out", notice };
  const filter = isFilter(input.status) ? input.status : "open";
  const q = searchWords(input.q);
  const client = clientDeps(person, config, deps, now);
  const [list, people] = await Promise.all([
    fetchTasks(
      person,
      { ...(q === undefined ? {} : { q }), status: filter, limit: TASKS_LIMIT },
      client,
    ),
    fetchPeople(person, client),
  ]);
  return {
    kind: "signed_in",
    person,
    filter,
    q,
    list,
    people,
    truncated: list.kind === "ok" && list.value.tasks.length >= TASKS_LIMIT,
    notice,
    readAt: now.toISOString(),
  };
}

/** Reads the session cookie and, for a signed-in person, one task with its threads and waits. */
export async function loadTask(
  input: {
    sessionCookie: string | undefined;
    key: string;
    done: string | undefined;
    error: string | undefined;
  },
  deps: HomeDeps,
): Promise<TaskView> {
  const config = deps.config;
  if (config === undefined) return { kind: "unconfigured" };
  const now = deps.now?.() ?? new Date();
  const notice = taskNotice(input.done, input.error);
  const person = await signedInPerson(input.sessionCookie, config, now);
  if (person === undefined) return { kind: "signed_out", notice };
  const key = taskKeyFromPath(input.key);
  if (key === undefined) return { kind: "not_found", person, key: undefined };
  const client = clientDeps(person, config, deps, now);
  const [lookup, people] = await Promise.all([
    fetchTask(person, key, client),
    fetchPeople(person, client),
  ]);
  switch (lookup.kind) {
    case "not_found":
      return { kind: "not_found", person, key };
    case "failed":
      return { kind: "failed", person, reason: lookup.reason };
    case "ok":
      return {
        kind: "ok",
        person,
        detail: lookup.value,
        people,
        notice,
        readAt: now.toISOString(),
      };
  }
}

const field = (form: FormData, name: string): string | undefined => {
  const value = form.get(name);
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : undefined;
};

/** The version the form was shown, which an edit sends. */
export function versionOf(form: FormData): number | undefined {
  const value = Number(field(form, "version"));
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** What the create form asks for, from its fields. */
export type FormTaskCreate = { kind: "create"; task: CreateTaskRequest } | { kind: "invalid" };

/** The create body from the form's fields: an empty description, status or assignee is none. */
export function taskCreateFromForm(form: FormData): FormTaskCreate {
  const description = field(form, "description");
  const status = field(form, "status");
  const assignee = field(form, "assignee");
  const parsed = createTaskRequestSchema.safeParse({
    title: field(form, "title") ?? "",
    ...(description === undefined || description === "" ? {} : { description }),
    ...(status === undefined || status === "" ? {} : { status }),
    ...(assignee === undefined || assignee === "" ? {} : { assigneeActorId: assignee }),
  });
  return parsed.success ? { kind: "create", task: parsed.data } : { kind: "invalid" };
}

/** What the edit form asks for, from its fields. */
export type FormTaskEdit =
  { kind: "edit"; edit: EditTaskRequest } | { kind: "unchanged" } | { kind: "invalid" };

/**
 * The edit body from the form's fields: only what differs from the task now, with the version
 * the form showed, so a change made meanwhile by someone else is not overwritten. An empty title
 * leaves it as it is; an empty description or assignee clears it; a missing field is left out.
 */
export function taskEditFromForm(
  form: FormData,
  current: { task: Task; description: string | null },
): FormTaskEdit {
  const version = versionOf(form);
  if (version === undefined) return { kind: "invalid" };
  const edit: EditTaskRequest = { version };
  const title = field(form, "title");
  if (title !== undefined && title !== "" && title !== current.task.title) edit.title = title;
  const description = field(form, "description");
  const newDescription = description === "" ? null : description;
  if (newDescription !== undefined && newDescription !== current.description) {
    edit.description = newDescription;
  }
  const status = field(form, "status");
  if (status !== undefined && status !== "" && status !== current.task.status) {
    const parsed = taskStatusSchema.safeParse(status);
    if (!parsed.success) return { kind: "invalid" };
    edit.status = parsed.data;
  }
  const assignee = field(form, "assignee");
  const newAssignee = assignee === "" ? null : assignee;
  if (newAssignee !== undefined && newAssignee !== (current.task.assignee?.actorId ?? null)) {
    edit.assigneeActorId = newAssignee;
  }
  if (Object.keys(edit).length === 1) return { kind: "unchanged" };
  const parsed = editTaskRequestSchema.safeParse(edit);
  return parsed.success ? { kind: "edit", edit: parsed.data } : { kind: "invalid" };
}

/** The forms the tasks pages post to. */
export type TaskAction = "create" | "edit";

function outcomeOf(result: ApiResult<TaskActionResult>, action: TaskAction): TaskNotice {
  if (result.kind === "failed") return { kind: "error", error: "failed" };
  const status = result.value.status;
  switch (status) {
    case "created":
      return action === "create"
        ? { kind: "done", done: status }
        : { kind: "error", error: "failed" };
    case "edited":
      return action === "edit"
        ? { kind: "done", done: status }
        : { kind: "error", error: "failed" };
    case "unchanged":
    case "changed":
    case "not_found":
    case "not_builtin":
    case "unknown_person":
      return { kind: "error", error: status };
  }
}

/**
 * `POST /new-task` or `POST /tasks/<key>/edit`: a form creates a built-in task or changes one.
 * Only from this app's own pages, and only for a signed-in person, as whom the API is called: who
 * acts is never read from the form. Answers with the task's page, or the list when there is none.
 */
export async function handleTaskAction(
  request: Request,
  action: TaskAction,
  keyText: string | undefined,
  deps: HomeDeps,
): Promise<Response> {
  const log = deps.log.child({ correlationId: randomUUID() });
  const pathKey = keyText === undefined ? undefined : taskKeyFromPath(keyText);
  if (action === "edit" && pathKey === undefined) {
    return new Response("Not found.", { status: 404 });
  }
  if (!fromThisApp(request, deps.config)) {
    log.warn("task.action_refused", { reason: "cross_origin", action, key: pathKey });
    return new Response("Changes to tasks must come from this app.", { status: 403 });
  }
  const config = deps.config;
  const to = (path: string, notice: TaskNotice): Response => {
    const url = new URL(path, config?.webBaseUrl ?? request.url);
    if (notice.kind === "done") url.searchParams.set("done", notice.done);
    else url.searchParams.set("error", notice.error);
    return new Response(null, {
      status: 303,
      headers: { location: url.toString(), "cache-control": "no-store" },
    });
  };
  // Back where the form was: the task's page for an edit, the list for a new task.
  const back = (notice: TaskNotice): Response =>
    to(pathKey === undefined ? "/tasks" : taskHref(pathKey), notice);
  if (config === undefined) return back({ kind: "error", error: "unavailable" });
  const now = deps.now?.() ?? new Date();
  const person = await signedInPerson(
    readCookie(request.headers.get("cookie"), SESSION_COOKIE),
    config,
    now,
  );
  if (person === undefined) {
    log.warn("task.action_refused", { reason: "signed_out", action, key: pathKey });
    return back({ kind: "error", error: "signed_out" });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back({ kind: "error", error: "invalid" });
  }
  const client = clientDeps(person, config, deps, now);

  let result: ApiResult<TaskActionResult>;
  if (action === "create") {
    const create = taskCreateFromForm(form);
    if (create.kind === "invalid") return back({ kind: "error", error: "invalid" });
    result = await createTask(person, create.task, client);
  } else {
    if (pathKey === undefined || versionOf(form) === undefined) {
      return back({ kind: "error", error: "invalid" });
    }
    const lookup = await fetchTask(person, pathKey, client);
    if (lookup.kind === "not_found") return back({ kind: "error", error: "not_found" });
    if (lookup.kind === "failed") return back({ kind: "error", error: "failed" });
    const builtin = lookup.value.builtin;
    if (builtin === null) return back({ kind: "error", error: "not_builtin" });
    const edit = taskEditFromForm(form, {
      task: lookup.value.task,
      description: builtin.description,
    });
    if (edit.kind !== "edit") return back({ kind: "error", error: edit.kind });
    result = await editTask(person, builtin.id, edit.edit, client);
  }
  const notice = outcomeOf(result, action);
  client.log.info("task.action", {
    action,
    key: pathKey,
    outcome: notice.kind === "done" ? notice.done : notice.error,
  });
  const task = result.kind === "ok" ? result.value.task : undefined;
  return notice.kind === "done" && task !== undefined
    ? to(taskHref(task.key), notice)
    : back(notice);
}

// How the pages word a task, kept here so it is tested without Next.js.

/** Where the team's tasks are kept, by name. */
export const providerLabel: Record<TaskProvider, string> = {
  builtin: "Built-in tracker",
  jira: "Jira",
};

/** The statuses a built-in task can have, as its forms offer them. */
export const statusOptions: { value: TaskStatus; label: string }[] = [
  { value: "todo", label: "To do" },
  { value: "doing", label: "Doing" },
  { value: "done", label: "Done" },
];

const statusText = (status: unknown): string =>
  statusOptions.find((option) => option.value === status)?.label ?? String(status);

/** Why the list is empty when the provider gave nothing, in plain words. */
export function problemText(list: TaskList): string {
  const name = providerLabel[list.provider];
  switch (list.problem) {
    case "not_configured":
      return list.provider === "jira"
        ? "Jira is not set up for the API yet, so its tasks cannot be shown."
        : `The ${name.toLowerCase()} is not set up yet.`;
    case "unreachable":
      return list.provider === "jira"
        ? "Jira did not answer. Reload the page to try again."
        : `The ${name.toLowerCase()} could not be read. Reload the page to try again.`;
    case null:
      return "The tasks could not be read. Reload the page to try again.";
  }
}

/** Who a task is assigned to, or "Nobody". */
export function assigneeText(assignee: Task["assignee"]): string {
  return assignee === null ? "Nobody" : nameOf(assignee);
}

/**
 * The assignees a form offers: nobody, the assignee now, the person signed in, and the people
 * the record knows, each once.
 */
export function assigneeOptions(
  people: ApiResult<Known[]>,
  current: Task["assignee"],
  you: Person,
): { value: string; label: string }[] {
  const all: { actorId: string | null; name: string | null }[] = [
    ...(current === null ? [] : [current]),
    { actorId: you.actorId, name: you.name },
    ...(people.kind === "ok" ? people.value : []),
  ];
  const seen = new Set<string>();
  const options = [{ value: "", label: "Nobody" }];
  for (const p of all) {
    if (p.actorId === null || seen.has(p.actorId)) continue;
    seen.add(p.actorId);
    options.push({ value: p.actorId, label: nameOf(p) });
  }
  return options;
}

/** A link to a thread working on a task. Threads carry no source; every channel so far is Slack's. */
export function taskThreadHref(thread: TaskDetail["threads"][number]): string | undefined {
  return messageLink("slack", thread.channelId, null, thread.threadId);
}

/** One line of a built-in task's history, oldest first. */
export interface TaskHistoryItem {
  key: string;
  text: string;
  at: string;
  changes: { field: string; before: string; after: string }[];
}

type Fields = Record<string, unknown>;

const isNamed = (value: unknown): value is { actorId?: unknown; name?: unknown } =>
  typeof value === "object" && value !== null;

/** The assignee as the history keeps it: a person, or their id and name side by side. */
function assigneeOf(fields: Fields): string {
  const value = fields.assignee;
  if (isNamed(value)) {
    const name = typeof value.name === "string" ? value.name : null;
    const actorId = typeof value.actorId === "string" ? value.actorId : null;
    return name ?? actorId ?? "Nobody";
  }
  if (typeof value === "string") return value;
  const name = fields.assigneeName;
  const actorId = fields.assigneeActorId;
  if (typeof name === "string") return name;
  if (typeof actorId === "string") return actorId;
  return "Nobody";
}

const textOf = (value: unknown): string =>
  typeof value === "string" && value !== "" ? value : "(none)";

const historyFields: [string, (fields: Fields) => string][] = [
  ["Title", (f) => textOf(f.title)],
  ["Description", (f) => textOf(f.description)],
  ["Status", (f) => (f.status === undefined ? "(none)" : statusText(f.status))],
  ["Assignee", assigneeOf],
];

/** The history to show: who created it, then who changed what. */
export function taskHistoryItems(detail: TaskDetail): TaskHistoryItem[] {
  return (detail.builtin?.history ?? []).map((event, index) => {
    const before = event.before;
    return {
      key: `${index}:${event.kind}`,
      text: `${event.kind === "created" ? "Created" : "Edited"} by ${nameOf(event.actor)}`,
      at: event.at,
      changes:
        event.kind === "edited" && before !== null
          ? historyFields
              .map(([label, text]) => ({
                field: label,
                before: text(before),
                after: text(event.after),
              }))
              .filter((change) => change.before !== change.after)
          : [],
    };
  });
}
