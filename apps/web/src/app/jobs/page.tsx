import type { Job } from "@hippidy/contracts";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "../../lib/cookies.ts";
import { when } from "../../lib/decisions.ts";
import {
  budgetText,
  everyText,
  jobHref,
  jobKindLabel,
  jobStateLabel,
  loadJobs,
  spendText,
  type JobsView,
} from "../../lib/jobs.ts";
import { NEW_GOAL_PAGE } from "../../lib/goals.ts";
import { serverDeps } from "../../lib/server.ts";

export const dynamic = "force-dynamic";

// Standing jobs (slices 4.1 and 4.2): what the bot is responsible for, each with its schedule,
// state and this month's spend against its cap.

export default async function Jobs() {
  const view = await loadJobs(
    { sessionCookie: (await cookies()).get(SESSION_COOKIE)?.value },
    serverDeps(),
  );
  return (
    <>
      <h1>
        <a href="/" className="home">
          hippidy-bot
        </a>
      </h1>
      <h2>Jobs</h2>
      <section className="about">
        <p>
          A job is something the bot does on its own, on a schedule: capture reads quiet threads for
          decisions, briefs sends each person their morning brief, the checker reviews pull
          requests, and a goal works through a feature&apos;s tickets in its thread. Each wake is
          kept, with what it said or why it stayed silent, and what it cost.
        </p>
        <p className="muted">
          Each job has a monthly cap; at its cap it stops itself until the month turns or someone
          raises the cap. Anyone signed in may pause or resume a job and change its cap, interval
          and goal; every change is kept with who made it and when.
        </p>
      </section>
      <View view={view} />
    </>
  );
}

function View({ view }: { view: JobsView }) {
  switch (view.kind) {
    case "unconfigured":
      return <p className="muted">Sign-in is not set up yet.</p>;
    case "signed_out":
      return (
        <p>
          <a className="button" href="/auth/slack">
            Sign in with Slack
          </a>{" "}
          <span className="muted">to see the bot&apos;s jobs.</span>
        </p>
      );
    case "signed_in": {
      const now = new Date(view.readAt);
      return (
        <>
          {view.list.kind === "failed" ? (
            <p className="notice">The API did not answer ({view.list.reason}).</p>
          ) : view.list.value.jobs.length === 0 ? (
            <p className="muted">No jobs yet.</p>
          ) : (
            <>
              <ul className="sessions">
                {view.list.value.jobs.map((job) => (
                  <JobItem key={job.id} job={job} now={now} />
                ))}
              </ul>
              <p className="muted">{budgetText(view.list.value.jobs)}</p>
            </>
          )}
          <p>
            <a className="button" href={NEW_GOAL_PAGE}>
              New goal
            </a>{" "}
            <span className="muted">for a feature&apos;s tickets, in a thread the bot is in.</span>
          </p>
          <footer className="muted">
            <a href="/">Agents at work</a> · <a href="/decisions">Decisions</a> ·{" "}
            <a href="/areas">Areas</a> · <a href="/conflicts">Conflicts</a> ·{" "}
            <a href="/tasks">Tasks</a> · <a href="/waits">Waiting on</a> ·{" "}
            <a href="/brief">Your brief</a> · <a href="/listening">Listening in channels</a> ·
            Signed in as {view.person.name}.
          </footer>
        </>
      );
    }
  }
}

function JobItem({ job, now }: { job: Job; now: Date }) {
  return (
    <li className="session">
      <p className="session-head">
        <a className="session-title" href={jobHref(job.name)}>
          {job.name}
        </a>
        <span className="muted">{jobKindLabel[job.kind]}</span>
        <span className={`state job-${job.state}`}>{jobStateLabel[job.state]}</span>
      </p>
      <p className="muted">
        Wakes {everyText(job.everyMinutes)} · {spendText(job)} this month ·{" "}
        {job.lastWakeAt === null ? (
          "not woken yet"
        ) : (
          <>
            last woke{" "}
            <time dateTime={job.lastWakeAt} title={job.lastWakeAt}>
              {when(job.lastWakeAt, now)}
            </time>
          </>
        )}
      </p>
      {job.goal === null ? null : <p>{job.goal}</p>}
    </li>
  );
}
