import type { Wait } from "@hippidy/contracts";
import { cookies } from "next/headers";
import type { ApiResult } from "../../lib/api-client.ts";
import type { Known } from "../../lib/areas.ts";
import { SESSION_COOKIE } from "../../lib/cookies.ts";
import { nameOf, when } from "../../lib/decisions.ts";
import { serverDeps } from "../../lib/server.ts";
import { taskHref } from "../../lib/tasks.ts";
import type { Person } from "../../lib/tokens.ts";
import {
  CREATE_WAIT_PATH,
  endWaitPath,
  groupByWaitingOn,
  loadWaits,
  sinceText,
  waitFilterLabel,
  waitFilters,
  waitingOnOptions,
  waitNoticeText,
  waitsHref,
  waitThread,
  WAITS_LIMIT,
  youArePart,
  type WaitNotice,
  type WaitsView,
} from "../../lib/waits.ts";

export const dynamic = "force-dynamic";

// The waiting-on list (slice 3.3): who is waiting on whom, for what and since when, grouped by
// the person waited on; the form with which you record your own wait, and the button that ends
// one you are part of.

const one = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : undefined;

export default async function Waits({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const view = await loadWaits(
    {
      sessionCookie: (await cookies()).get(SESSION_COOKIE)?.value,
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
      <h2>Waiting on</h2>
      <View view={view} />
    </>
  );
}

function Notice({ notice }: { notice: WaitNotice | undefined }) {
  if (notice === undefined) return null;
  return (
    <p className={notice.kind === "error" ? "notice notice-error" : "notice"} role="status">
      {waitNoticeText(notice)}
    </p>
  );
}

function View({ view }: { view: WaitsView }) {
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
            <span className="muted">to see who is waiting on whom.</span>
          </p>
        </>
      );
    case "signed_in": {
      const now = new Date(view.readAt);
      return (
        <>
          <Notice notice={view.notice} />
          <p className="muted">
            Who is waiting on whom, for what and since when. The bot records a wait when someone
            says so in a thread; you can record your own below. Either person, or whoever recorded
            it, ends it.
          </p>
          <p className="filters">
            {waitFilters.map((filter) =>
              filter === view.filter ? (
                <strong key={filter} aria-current="page">
                  {waitFilterLabel[filter]}
                </strong>
              ) : (
                <a key={filter} href={waitsHref(filter)}>
                  {waitFilterLabel[filter]}
                </a>
              ),
            )}
          </p>
          {view.list.kind === "failed" ? (
            <p className="notice">The API did not answer ({view.list.reason}).</p>
          ) : view.list.value.length === 0 ? (
            <p className="muted">
              {view.filter === "open" ? "Nobody is waiting on anyone." : "No ended waits."}
            </p>
          ) : (
            groupByWaitingOn(view.list.value).map((group) => (
              <section key={group.key}>
                <h3>Waiting on {group.label}</h3>
                <ul className="sessions">
                  {group.waits.map((wait) => (
                    <WaitItem key={wait.id} wait={wait} you={view.person} now={now} />
                  ))}
                </ul>
              </section>
            ))
          )}
          {view.truncated ? <p className="muted">Showing the latest {WAITS_LIMIT}.</p> : null}
          {view.filter === "open" ? <NewWait people={view.people} you={view.person} /> : null}
          <footer className="muted">
            <a href="/">Agents at work</a> · <a href="/decisions">Decisions</a> ·{" "}
            <a href="/areas">Areas</a> · <a href="/conflicts">Conflicts</a> ·{" "}
            <a href="/tasks">Tasks</a> · <a href="/brief">Your brief</a> · <a href="/jobs">Jobs</a>{" "}
            · <a href="/listening">Listening in channels</a> · Signed in as {view.person.name}.
          </footer>
        </>
      );
    }
  }
}

function WaitItem({ wait, you, now }: { wait: Wait; you: Person; now: Date }) {
  const thread = waitThread(wait);
  return (
    <li className="session">
      <p>
        <strong>{nameOf(wait.waiter)}</strong>: {wait.what}
      </p>
      <p className="muted">
        <time dateTime={wait.since} title={wait.since}>
          {sinceText(wait.since, wait.endedAt === null ? now : new Date(wait.endedAt))}
        </time>
        {wait.taskKey === null ? null : (
          <>
            {" "}
            · <a href={taskHref(wait.taskKey)}>{wait.taskKey}</a>
          </>
        )}
        {thread?.kind === "link" ? (
          <>
            {" "}
            ·{" "}
            <a href={thread.href} rel="noreferrer">
              {thread.text}
            </a>
          </>
        ) : null}
        {wait.recordedBy.actorId === wait.waiter.actorId ? null : (
          <> · recorded by {nameOf(wait.recordedBy)}</>
        )}
      </p>
      {wait.status === "ended" ? (
        <p className="muted">
          Ended
          {wait.endedBy === null ? null : <> by {nameOf(wait.endedBy)}</>}
          {wait.endedAt === null ? null : (
            <>
              ,{" "}
              <time dateTime={wait.endedAt} title={wait.endedAt}>
                {when(wait.endedAt, now)}
              </time>
            </>
          )}
        </p>
      ) : youArePart(wait, you) ? (
        <form method="post" action={endWaitPath(wait.id)} className="inline">
          <button className="link" type="submit">
            End
          </button>
        </form>
      ) : null}
    </li>
  );
}

function NewWait({ people, you }: { people: ApiResult<Known[]>; you: Person }) {
  const options = waitingOnOptions(people, you);
  return (
    <section className="actions" id="new-wait">
      <h3>I&apos;m waiting on…</h3>
      {people.kind === "failed" ? (
        <p className="muted">
          The people the bot knows could not be read ({people.reason}). Reload the page to try
          again.
        </p>
      ) : options.length === 0 ? (
        <p className="muted">The bot knows nobody else yet.</p>
      ) : (
        <form method="post" action={CREATE_WAIT_PATH} className="edit">
          <label>
            Whom
            <select name="waiting_on" required defaultValue="">
              <option value="" disabled>
                Choose someone
              </option>
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            For what <span className="muted">(at most 300 characters)</span>
            <input name="what" required maxLength={300} placeholder="review the ranking" />
          </label>
          <label>
            Task <span className="muted">(its key, optional)</span>
            <input name="task" maxLength={30} placeholder="T-12" />
          </label>
          <button className="button" type="submit">
            Record
          </button>
        </form>
      )}
    </section>
  );
}
