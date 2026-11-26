import type { JobDetail } from "@hippidy/contracts";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "../../../lib/cookies.ts";
import { nameOf, when } from "../../../lib/decisions.ts";
import {
  capFieldValue,
  centsText,
  everyText,
  jobHistoryItems,
  jobHref,
  jobKindLabel,
  jobNoticeText,
  jobStateLabel,
  loadJob,
  spendText,
  stateOptions,
  wakeRows,
  type JobNotice,
  type JobView,
} from "../../../lib/jobs.ts";
import { serverDeps } from "../../../lib/server.ts";

export const dynamic = "force-dynamic";

// One job (slices 4.1 and 4.2): its schedule, state and spend, the form that pauses, resumes or
// changes it, its latest wakes, and the changes people made to it.

const one = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : undefined;

export default async function JobPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { name } = await params;
  const query = await searchParams;
  const view = await loadJob(
    {
      sessionCookie: (await cookies()).get(SESSION_COOKIE)?.value,
      name,
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
        <a href="/jobs">Jobs</a>
      </p>
      <View view={view} />
    </>
  );
}

function Notice({ notice }: { notice: JobNotice | undefined }) {
  if (notice === undefined) return null;
  return (
    <p className={notice.kind === "error" ? "notice notice-error" : "notice"} role="status">
      {jobNoticeText(notice)}
    </p>
  );
}

function View({ view }: { view: JobView }) {
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
            <span className="muted">to see the bot&apos;s jobs.</span>
          </p>
        </>
      );
    case "not_found":
      return (
        <p className="notice">
          {view.name === undefined
            ? "There is no such job."
            : `There is no job named “${view.name}”.`}{" "}
          The bot&apos;s jobs are on the <a href="/jobs">jobs page</a>.
        </p>
      );
    case "failed":
      return <p className="notice">The API did not answer ({view.reason}).</p>;
    case "ok":
      return <Detail detail={view.detail} notice={view.notice} now={new Date(view.readAt)} />;
  }
}

function Detail({
  detail,
  notice,
  now,
}: {
  detail: JobDetail;
  notice: JobNotice | undefined;
  now: Date;
}) {
  const job = detail.job;
  const history = jobHistoryItems(detail);
  const wakes = wakeRows(detail.wakes);
  return (
    <>
      <h2>{job.name}</h2>
      <Notice notice={notice} />
      <dl className="facts">
        <dt>Kind</dt>
        <dd>{jobKindLabel[job.kind]}</dd>
        <dt>State</dt>
        <dd className={`job-${job.state}`}>{jobStateLabel[job.state]}</dd>
        <dt>Wakes</dt>
        <dd>{everyText(job.everyMinutes)}</dd>
        <dt>This month</dt>
        <dd>{spendText(job)}</dd>
        <dt>Last wake</dt>
        <dd>
          {job.lastWakeAt === null ? (
            <span className="muted">Not woken yet</span>
          ) : (
            <time dateTime={job.lastWakeAt} title={job.lastWakeAt}>
              {when(job.lastWakeAt, now)}
            </time>
          )}
        </dd>
        <dt>Goal</dt>
        <dd>{job.goal ?? <span className="muted">None</span>}</dd>
        <dt>Owner</dt>
        <dd>{job.owner === null ? <span className="muted">None</span> : nameOf(job.owner)}</dd>
      </dl>
      {job.state === "capped" ? (
        <p className="notice">
          It reached its cap of {centsText(job.capCents)} this month and stopped itself. Raise its
          cap above this month&apos;s spend to resume it.
        </p>
      ) : null}
      <section className="actions">
        <h3>Change it</h3>
        <form method="post" action={`${jobHref(job.name)}/edit`} className="edit">
          <input type="hidden" name="version" value={job.version} />
          <label>
            State
            <select name="state" defaultValue={job.state}>
              {stateOptions(job.state).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Cap, in dollars a month <span className="muted">($0.00 to $100.00)</span>
            <input
              name="cap"
              defaultValue={capFieldValue(job.capCents)}
              inputMode="decimal"
              pattern="\$?\s*\d+(\.\d{1,2})?"
              required
            />
          </label>
          <label>
            Interval, in minutes <span className="muted">(1 to 1,440)</span>
            <input
              name="everyMinutes"
              type="number"
              min={1}
              max={1440}
              step={1}
              defaultValue={job.everyMinutes}
              required
            />
          </label>
          <label>
            Goal <span className="muted">(what it is for, in words; empty clears it)</span>
            <textarea name="goal" defaultValue={job.goal ?? ""} rows={3} maxLength={2000} />
          </label>
          <button className="button" type="submit">
            Save changes
          </button>
        </form>
      </section>
      <h3>Latest wakes</h3>
      {wakes.length === 0 ? (
        <p className="muted">It has not woken yet.</p>
      ) : (
        <div className="table">
          <table className="wakes">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Outcome</th>
                <th scope="col">What it said, or why not</th>
                <th scope="col">Cost</th>
              </tr>
            </thead>
            <tbody>
              {wakes.map((wake) => (
                <tr key={wake.key}>
                  <td>
                    <time dateTime={wake.at} title={wake.at}>
                      {when(wake.at, now)}
                    </time>
                  </td>
                  <td className={`outcome-${wake.outcome}`}>{wake.label}</td>
                  <td>{wake.text === "" ? <span className="muted">Nothing</span> : wake.text}</td>
                  <td className="cost">{wake.cost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>History</h3>
      {history.length === 0 ? (
        <p className="muted">No one has changed it yet.</p>
      ) : (
        <ul className="sessions">
          {history.map((item) => (
            <li key={item.key} className="session">
              {item.lines.map((line) => (
                <p key={line} className="change">
                  {line}
                </p>
              ))}
              <p className="muted">
                <time dateTime={item.at} title={item.at}>
                  {when(item.at, now)}
                </time>
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
