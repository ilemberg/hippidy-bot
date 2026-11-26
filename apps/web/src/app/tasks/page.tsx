import type { Task } from "@hippidy/contracts";
import { cookies } from "next/headers";
import type { ApiResult } from "../../lib/api-client.ts";
import type { Known } from "../../lib/areas.ts";
import { SESSION_COOKIE } from "../../lib/cookies.ts";
import { when } from "../../lib/decisions.ts";
import { serverDeps } from "../../lib/server.ts";
import {
  assigneeOptions,
  assigneeText,
  CREATE_TASK_PATH,
  loadTasks,
  problemText,
  providerLabel,
  statusOptions,
  taskFilterLabel,
  taskFilters,
  taskHref,
  taskNoticeText,
  tasksHref,
  TASKS_LIMIT,
  type TaskNotice,
  type TasksView,
} from "../../lib/tasks.ts";
import type { Person } from "../../lib/tokens.ts";

export const dynamic = "force-dynamic";

// Tasks (slice 3.3): the team's tasks from Jira or the built-in tracker, the same way whichever
// is the home, and, for the built-in tracker, the form that creates one.

const one = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : undefined;

export default async function Tasks({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const view = await loadTasks(
    {
      sessionCookie: (await cookies()).get(SESSION_COOKIE)?.value,
      q: one(params.q),
      status: one(params.status),
      done: one(params.done),
      error: one(params.error),
    },
    serverDeps(),
  );
  return (
    <>
      <h1>
        <a href="/" className="home">
          hippidy-bot
        </a>
      </h1>
      <h2>Tasks</h2>
      <View view={view} />
    </>
  );
}

function Notice({ notice }: { notice: TaskNotice | undefined }) {
  if (notice === undefined) return null;
  return (
    <p className={notice.kind === "error" ? "notice notice-error" : "notice"} role="status">
      {taskNoticeText(notice)}
    </p>
  );
}

function View({ view }: { view: TasksView }) {
  switch (view.kind) {
    case "unconfigured":
      return <p className="muted">Sign-in is not set up yet.</p>;
    case "signed_out":
      return (
        <>
          <Notice notice={view.notice} />
          <p>
            <a className="button" href="/auth/slack">
              Sign in with Slack
            </a>{" "}
            <span className="muted">to see the team&apos;s tasks.</span>
          </p>
        </>
      );
    case "signed_in": {
      const now = new Date(view.readAt);
      const list = view.list;
      return (
        <>
          <Notice notice={view.notice} />
          {list.kind === "failed" ? (
            <p className="notice">The API did not answer ({list.reason}).</p>
          ) : (
            <>
              <p>
                Kept in: <strong>{providerLabel[list.value.provider]}</strong>
              </p>
              <p className="muted">
                {list.value.provider === "jira"
                  ? "They are created and changed in Jira."
                  : "Anyone signed in may create or change a task; every change is kept with who made it and when."}{" "}
                Open one to see the threads working on it and who is waiting on whom for it.
              </p>
              <form method="get" action="/tasks" className="search">
                <input
                  type="search"
                  name="q"
                  defaultValue={view.q ?? ""}
                  maxLength={200}
                  aria-label="Search tasks"
                  placeholder="Search tasks"
                />
                {view.filter === "open" ? null : (
                  <input type="hidden" name="status" value={view.filter} />
                )}
                <button className="button" type="submit">
                  Search
                </button>
              </form>
              <p className="filters">
                {taskFilters.map((filter) =>
                  filter === view.filter ? (
                    <strong key={filter} aria-current="page">
                      {taskFilterLabel[filter]}
                    </strong>
                  ) : (
                    <a key={filter} href={tasksHref(filter, view.q)}>
                      {taskFilterLabel[filter]}
                    </a>
                  ),
                )}
              </p>
              {!list.value.available ? (
                <p className="notice">{problemText(list.value)}</p>
              ) : list.value.tasks.length === 0 ? (
                <p className="muted">
                  {view.q !== undefined
                    ? "No tasks match."
                    : view.filter === "open"
                      ? "No open tasks."
                      : "No tasks here."}
                </p>
              ) : (
                <ul className="sessions">
                  {list.value.tasks.map((task) => (
                    <TaskItem key={task.key} task={task} now={now} />
                  ))}
                </ul>
              )}
              {view.truncated ? <p className="muted">Showing the latest {TASKS_LIMIT}.</p> : null}
              {list.value.provider === "builtin" ? (
                <NewTask people={view.people} you={view.person} />
              ) : null}
            </>
          )}
          <footer className="muted">
            <a href="/">Agents at work</a> · <a href="/decisions">Decisions</a> ·{" "}
            <a href="/areas">Areas</a> · <a href="/conflicts">Conflicts</a> ·{" "}
            <a href="/waits">Waiting on</a> · <a href="/brief">Your brief</a> ·{" "}
            <a href="/listening">Listening in channels</a> · Signed in as {view.person.name}.
          </footer>
        </>
      );
    }
  }
}

function TaskItem({ task, now }: { task: Task; now: Date }) {
  return (
    <li className="session">
      <p className="session-title">
        <a href={taskHref(task.key)}>{task.key}</a> {task.title}
      </p>
      <p className="muted">
        {task.statusName} · {assigneeText(task.assignee)} · updated{" "}
        <time dateTime={task.updatedAt} title={task.updatedAt}>
          {when(task.updatedAt, now)}
        </time>
      </p>
    </li>
  );
}

function NewTask({ people, you }: { people: ApiResult<Known[]>; you: Person }) {
  return (
    <section className="actions" id="new-task">
      <h3>New task</h3>
      <form method="post" action={CREATE_TASK_PATH} className="edit">
        <label>
          Title
          <input name="title" required maxLength={200} />
        </label>
        <label>
          Description <span className="muted">(optional)</span>
          <textarea name="description" maxLength={4000} rows={3} />
        </label>
        <label>
          Status
          <select name="status" defaultValue="todo">
            {statusOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Assignee
          <select name="assignee" defaultValue="">
            {assigneeOptions(people, null, you).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {people.kind === "failed" ? (
          <p className="muted">
            The people the bot knows could not be read ({people.reason}); you can assign it later.
          </p>
        ) : null}
        <button className="button" type="submit">
          Create task
        </button>
      </form>
    </section>
  );
}
