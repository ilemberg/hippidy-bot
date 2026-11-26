import type { TaskDetail } from "@hippidy/contracts";
import { cookies } from "next/headers";
import type { ApiResult } from "../../../lib/api-client.ts";
import type { Known } from "../../../lib/areas.ts";
import { SESSION_COOKIE } from "../../../lib/cookies.ts";
import { nameOf, when } from "../../../lib/decisions.ts";
import { serverDeps } from "../../../lib/server.ts";
import {
  assigneeOptions,
  assigneeText,
  loadTask,
  providerLabel,
  statusOptions,
  taskHistoryItems,
  taskHref,
  taskNoticeText,
  taskThreadHref,
  type TaskNotice,
  type TaskView,
} from "../../../lib/tasks.ts";
import type { Person } from "../../../lib/tokens.ts";
import { sinceText, waitThread } from "../../../lib/waits.ts";

export const dynamic = "force-dynamic";

// One task (slice 3.3): its status and assignee, the threads working on it and its open waits;
// for a built-in task also its description, the form that changes it, and its history.

const one = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : undefined;

export default async function TaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { key } = await params;
  const query = await searchParams;
  const view = await loadTask(
    {
      sessionCookie: (await cookies()).get(SESSION_COOKIE)?.value,
      key,
      done: one(query.done),
      error: one(query.error),
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
      <p className="muted">
        <a href="/tasks">Tasks</a> · <a href="/waits">Waiting on</a>
      </p>
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

function View({ view }: { view: TaskView }) {
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
    case "not_found":
      return (
        <p className="notice">
          {view.key === undefined ? "There is no such task." : `There is no task ${view.key}.`}
        </p>
      );
    case "failed":
      return <p className="notice">The API did not answer ({view.reason}).</p>;
    case "ok":
      return (
        <Detail
          detail={view.detail}
          people={view.people}
          notice={view.notice}
          you={view.person}
          now={new Date(view.readAt)}
        />
      );
  }
}

function Detail({
  detail,
  people,
  notice,
  you,
  now,
}: {
  detail: TaskDetail;
  people: ApiResult<Known[]>;
  notice: TaskNotice | undefined;
  you: Person;
  now: Date;
}) {
  const task = detail.task;
  const builtin = detail.builtin;
  return (
    <>
      <h2>
        {task.key} {task.title}
      </h2>
      <Notice notice={notice} />
      <dl className="facts">
        <dt>Status</dt>
        <dd>{task.statusName}</dd>
        <dt>Assignee</dt>
        <dd>{assigneeText(task.assignee)}</dd>
        <dt>Kept in</dt>
        <dd>
          {task.url === null ? (
            providerLabel[detail.provider]
          ) : (
            <a href={task.url} rel="noreferrer">
              {providerLabel[detail.provider]}
            </a>
          )}
        </dd>
        <dt>Updated</dt>
        <dd>
          <time dateTime={task.updatedAt} title={task.updatedAt}>
            {when(task.updatedAt, now)}
          </time>
        </dd>
        {builtin === null ? null : (
          <>
            <dt>Created</dt>
            <dd>
              by {nameOf(builtin.createdBy)},{" "}
              <time dateTime={builtin.createdAt} title={builtin.createdAt}>
                {when(builtin.createdAt, now)}
              </time>
            </dd>
            <dt>Description</dt>
            <dd>{builtin.description ?? <span className="muted">None</span>}</dd>
          </>
        )}
      </dl>
      <h3>Threads working on it</h3>
      {detail.threads.length === 0 ? (
        <p className="muted">No thread is linked to it yet.</p>
      ) : (
        <ul className="sessions">
          {detail.threads.map((thread) => {
            const href = taskThreadHref(thread);
            return (
              <li key={thread.conversationId} className="session">
                <p>
                  {href === undefined ? (
                    "A thread"
                  ) : (
                    <a href={href} rel="noreferrer">
                      A thread in Slack
                    </a>
                  )}
                  , linked{" "}
                  <time dateTime={thread.linkedAt} title={thread.linkedAt}>
                    {when(thread.linkedAt, now)}
                  </time>
                </p>
              </li>
            );
          })}
        </ul>
      )}
      <Waits detail={detail} now={now} />
      {builtin === null ? null : (
        <>
          <section className="actions">
            <h3>Change it</h3>
            <form method="post" action={`${taskHref(task.key)}/edit`} className="edit">
              <input type="hidden" name="version" value={builtin.version} />
              <label>
                Title
                <input name="title" defaultValue={task.title} required maxLength={200} />
              </label>
              <label>
                Description <span className="muted">(empty clears it)</span>
                <textarea
                  name="description"
                  defaultValue={builtin.description ?? ""}
                  maxLength={4000}
                  rows={4}
                />
              </label>
              <label>
                Status
                <select name="status" defaultValue={task.status}>
                  {statusOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Assignee
                <select name="assignee" defaultValue={task.assignee?.actorId ?? ""}>
                  {assigneeOptions(people, task.assignee, you).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {people.kind === "failed" ? (
                <p className="muted">
                  The people the bot knows could not be read ({people.reason}), so only the assignee
                  now and you are offered.
                </p>
              ) : null}
              <button className="button" type="submit">
                Save changes
              </button>
            </form>
          </section>
          <h3>History</h3>
          <ul className="sessions">
            {taskHistoryItems(detail).map((item) => (
              <li key={item.key} className="session">
                <p>
                  {item.text},{" "}
                  <time dateTime={item.at} title={item.at}>
                    {when(item.at, now)}
                  </time>
                </p>
                {item.changes.map((change) => (
                  <p key={change.field} className="change">
                    <span className="muted">{change.field}:</span> <del>{change.before}</del>{" "}
                    <span className="muted">became</span> <ins>{change.after}</ins>
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function Waits({ detail, now }: { detail: TaskDetail; now: Date }) {
  const open = detail.waits.filter((wait) => wait.status === "open");
  return (
    <>
      <h3>Waiting on someone</h3>
      {open.length === 0 ? (
        <p className="muted">Nobody is waiting on anyone for it.</p>
      ) : (
        <ul className="sessions">
          {open.map((wait) => {
            const thread = waitThread(wait);
            return (
              <li key={wait.id} className="session">
                <p>
                  <strong>{nameOf(wait.waiter)}</strong> is waiting on{" "}
                  <strong>{nameOf(wait.waitingOn)}</strong>: {wait.what}
                </p>
                <p className="muted">
                  <time dateTime={wait.since} title={wait.since}>
                    {sinceText(wait.since, now)}
                  </time>
                  {thread?.kind === "link" ? (
                    <>
                      {" "}
                      ·{" "}
                      <a href={thread.href} rel="noreferrer">
                        {thread.text}
                      </a>
                    </>
                  ) : null}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted">
        Waits are recorded and ended on the <a href="/waits">waiting-on page</a>, or by the bot in a
        thread.
      </p>
    </>
  );
}
