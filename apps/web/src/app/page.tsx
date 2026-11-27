import type { Job, JobList, MyBrief, Scorecard, SessionActivity } from "@hippidy/contracts";
import { cookies } from "next/headers";
import type { ApiResult } from "../lib/api-client.ts";
import type { SignInNotice } from "../lib/auth-flow.ts";
import { BRIEF_PATH } from "../lib/briefs.ts";
import { SESSION_COOKIE } from "../lib/cookies.ts";
import { when } from "../lib/decisions.ts";
import {
  differenceText,
  loadHome,
  scorecardHref,
  scorecardLabel,
  SESSIONS_SHOWN,
  weeksText,
  type HomeView,
} from "../lib/home.ts";
import { budgetText, jobHref, jobStateLabel, spendText, wakeOutcomeLabel } from "../lib/jobs.ts";
import { serverDeps } from "../lib/server.ts";
import { agentLabel, ago, costText, stateLabel, threadLink } from "../lib/sessions-view.ts";
import { BriefSections } from "./brief/sections.tsx";

export const dynamic = "force-dynamic";

// The dashboard home (slice 4.5, decision 223): your brief, the jobs, the team's scorecard and
// the agents at work, each read on its own so one the API does not answer leaves the rest.

const noticeText: Record<SignInNotice, string> = {
  unavailable: "Sign-in is not set up yet.",
  cancelled: "Sign-in was cancelled in Slack.",
  failed: "Sign-in did not work. Try again.",
  not_in_workspace: "Only members of the team's Slack workspace can sign in.",
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const signin = (await searchParams).signin;
  const view = await loadHome(
    {
      sessionCookie: (await cookies()).get(SESSION_COOKIE)?.value,
      signin: typeof signin === "string" ? signin : undefined,
    },
    serverDeps(),
  );
  return (
    <>
      <h1>hippidy-bot</h1>
      <View view={view} />
    </>
  );
}

function View({ view }: { view: HomeView }) {
  switch (view.kind) {
    case "unconfigured":
      return <p className="muted">{noticeText.unavailable}</p>;
    case "signed_out":
      return (
        <>
          {view.notice === undefined ? null : <p className="notice">{noticeText[view.notice]}</p>}
          <p>Sign in with the Slack account you use to talk to the bot.</p>
          <a className="button" href="/auth/slack">
            Sign in with Slack
          </a>
        </>
      );
    case "signed_in": {
      const readAt = new Date(view.readAt);
      return (
        <>
          <div className="bar">
            <p className="muted">
              As of <time dateTime={view.readAt}>{readAt.toUTCString()}</time>.
            </p>
            {/* The page is rendered on each request, so reloading it is the refresh. */}
            <a className="button" href="/">
              Refresh
            </a>
          </div>
          <BriefPart brief={view.brief} webBaseUrl={view.webBaseUrl} />
          <JobsPart jobs={view.jobs} now={readAt} />
          <ScorecardPart scorecard={view.scorecard} />
          <section className="part">
            <h2>Agents at work</h2>
            <p className="muted">The latest {SESSIONS_SHOWN}, working ones first.</p>
            {view.sessions.kind === "failed" ? (
              <Failed reason={view.sessions.reason} />
            ) : view.sessions.value.length === 0 ? (
              <p className="muted">No agent has worked yet.</p>
            ) : (
              <ul className="sessions">
                {view.sessions.value.map((session) => (
                  <SessionItem
                    key={`${session.kind}:${session.changeId ?? session.conversationId}`}
                    session={session}
                    now={readAt}
                  />
                ))}
              </ul>
            )}
          </section>
          <footer className="muted">
            <a href="/decisions">Decisions</a> · <a href="/areas">Areas</a> ·{" "}
            <a href="/conflicts">Conflicts</a> · <a href="/tasks">Tasks</a> ·{" "}
            <a href="/waits">Waiting on</a> · <a href="/brief">Your brief</a> ·{" "}
            <a href="/jobs">Jobs</a> · <a href="/listening">Listening in channels</a> · Signed in as{" "}
            {view.person.name}.{" "}
            <form method="post" action="/auth/signout" className="inline">
              <button className="link" type="submit">
                Sign out
              </button>
            </form>
          </footer>
        </>
      );
    }
  }
}

/** A part whose route did not answer; the rest of the page still shows. */
function Failed({ reason }: { reason: string }) {
  return <p className="notice">The API did not answer ({reason}).</p>;
}

function BriefPart({ brief, webBaseUrl }: { brief: ApiResult<MyBrief>; webBaseUrl: string }) {
  return (
    <section className="part">
      <div className="bar">
        <h2>Your brief</h2>
        <a href={BRIEF_PATH}>Settings</a>
      </div>
      {brief.kind === "failed" ? (
        <Failed reason={brief.reason} />
      ) : (
        <>
          <p className="muted">
            What is new for you since{" "}
            <time dateTime={brief.value.brief.since} title={brief.value.brief.since}>
              {brief.value.brief.since.slice(0, 10)}
            </time>
            {brief.value.on ? "" : ". Your briefs are off, so none is sent"}.
          </p>
          <BriefSections brief={brief.value.brief} webBaseUrl={webBaseUrl} heading="h3" />
        </>
      )}
    </section>
  );
}

function JobsPart({ jobs, now }: { jobs: ApiResult<JobList>; now: Date }) {
  return (
    <section className="part">
      <div className="bar">
        <h2>Jobs</h2>
        <a href="/jobs">All jobs</a>
      </div>
      {jobs.kind === "failed" ? (
        <Failed reason={jobs.reason} />
      ) : jobs.value.jobs.length === 0 ? (
        <p className="muted">No jobs yet.</p>
      ) : (
        <>
          <ul className="sessions">
            {jobs.value.jobs.map((job) => (
              <JobItem key={job.id} job={job} now={now} />
            ))}
          </ul>
          <p className="muted">{budgetText(jobs.value.jobs)}</p>
        </>
      )}
    </section>
  );
}

function JobItem({ job, now }: { job: Job; now: Date }) {
  return (
    <li className="session">
      <p className="session-head">
        <a className="session-title" href={jobHref(job.name)}>
          {job.name}
        </a>
        <span className={`state job-${job.state}`}>{jobStateLabel[job.state]}</span>
        <a href={jobHref(job.name)}>{spendText(job)}</a>
        <span className="muted">this month</span>
      </p>
      <p className="muted">
        {job.lastWakeAt === null ? (
          "Not woken yet"
        ) : (
          <>
            Last woke{" "}
            <time dateTime={job.lastWakeAt} title={job.lastWakeAt}>
              {when(job.lastWakeAt, now)}
            </time>
            {job.lastWakeOutcome === null ? null : (
              <>
                :{" "}
                <span className={`outcome-${job.lastWakeOutcome}`}>
                  {wakeOutcomeLabel[job.lastWakeOutcome].toLowerCase()}
                </span>
              </>
            )}
          </>
        )}
      </p>
    </li>
  );
}

function ScorecardPart({ scorecard }: { scorecard: ApiResult<Scorecard> }) {
  return (
    <section className="part">
      <h2>The team this week</h2>
      {scorecard.kind === "failed" ? (
        <Failed reason={scorecard.reason} />
      ) : (
        <>
          <p className="muted">{weeksText(scorecard.value)}</p>
          <div className="table">
            <table className="wakes">
              <thead>
                <tr>
                  <th scope="col">From the records</th>
                  <th scope="col">This week</th>
                  <th scope="col">Last week</th>
                  <th scope="col">Difference</th>
                </tr>
              </thead>
              <tbody>
                {scorecard.value.counts.map((count) => {
                  const href = scorecardHref[count.kind];
                  const label = scorecardLabel[count.kind];
                  return (
                    <tr key={count.kind}>
                      <td>{href === undefined ? label : <a href={href}>{label}</a>}</td>
                      <td>
                        {href === undefined ? count.thisWeek : <a href={href}>{count.thisWeek}</a>}
                      </td>
                      <td>{count.lastWeek}</td>
                      <td>{differenceText(count.thisWeek, count.lastWeek)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function SessionItem({ session, now }: { session: SessionActivity; now: Date }) {
  const link = threadLink(session.thread);
  const asked = session.askedBy?.name ?? session.askedBy?.actorId;
  return (
    <li className="session">
      <div className="session-head">
        <span className={`state state-${session.state}`}>{stateLabel[session.state]}</span>
        <span className="muted">{agentLabel[session.agent]}</span>
        <span className="muted">{costText(session.cost)}</span>
      </div>
      <p className="session-title">
        {link === undefined ? (
          session.title
        ) : (
          <a href={link} rel="noreferrer">
            {session.title}
          </a>
        )}
      </p>
      <p className="muted">
        {asked === undefined ? "Asked by someone unknown" : `Asked by ${asked}`}
        {session.project === null ? "" : ` · ${session.project.name}`} · started{" "}
        {ago(session.startedAt, now)}
      </p>
      {session.latestActivity === null ? null : (
        <p className="latest">
          <span className="muted">{ago(session.latestActivity.at, now)}:</span>{" "}
          {session.latestActivity.text}
        </p>
      )}
    </li>
  );
}
