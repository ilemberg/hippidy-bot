import type { BriefLine, MyBrief } from "@hippidy/contracts";
import { cookies } from "next/headers";
import {
  briefLink,
  briefNoticeText,
  lastSentText,
  loadBrief,
  moreText,
  SWITCH_BRIEFS_PATH,
  timeZoneText,
  type BriefNotice,
  type BriefView,
} from "../../lib/briefs.ts";
import { SESSION_COOKIE } from "../../lib/cookies.ts";
import { serverDeps } from "../../lib/server.ts";
import type { Person } from "../../lib/tokens.ts";

export const dynamic = "force-dynamic";

// Your brief (slice 3.4): whether the bot sends you a daily brief, in which time zone, when it
// last did, and what it would say now; the button that stops or starts them.

const one = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : undefined;

export default async function Brief({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const view = await loadBrief(
    {
      sessionCookie: (await cookies()).get(SESSION_COOKIE)?.value,
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
      <h2>Your brief</h2>
      <View view={view} />
    </>
  );
}

function Notice({ notice }: { notice: BriefNotice | undefined }) {
  if (notice === undefined) return null;
  return (
    <p className={notice.kind === "error" ? "notice notice-error" : "notice"} role="status">
      {briefNoticeText(notice)}
    </p>
  );
}

function View({ view }: { view: BriefView }) {
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
            <span className="muted">to see what your brief would say.</span>
          </p>
        </>
      );
    case "signed_in":
      return (
        <>
          <Notice notice={view.notice} />
          <p className="muted">
            The bot sends you a direct message on weekday mornings, around 9:00 your time, but only
            when something is new for you. Writing &ldquo;stop briefs&rdquo; to the bot in Slack
            also stops them, and &ldquo;start briefs&rdquo; starts them again.
          </p>
          {view.brief.kind === "failed" ? (
            <p className="notice">The API did not answer ({view.brief.reason}).</p>
          ) : (
            <BriefContent brief={view.brief.value} webBaseUrl={view.webBaseUrl} now={view.readAt} />
          )}
          <Footer person={view.person} />
        </>
      );
  }
}

function BriefContent({
  brief,
  webBaseUrl,
  now,
}: {
  brief: MyBrief;
  webBaseUrl: string;
  now: string;
}) {
  return (
    <>
      <dl className="facts">
        <dt>Briefs</dt>
        <dd>{brief.on ? "On" : "Off"}</dd>
        <dt>Time zone</dt>
        <dd>{timeZoneText(brief.timeZone)}</dd>
        <dt>Last sent</dt>
        <dd>
          {brief.lastSentAt === null ? (
            lastSentText(null, new Date(now))
          ) : (
            <time dateTime={brief.lastSentAt} title={brief.lastSentAt}>
              {lastSentText(brief.lastSentAt, new Date(now))}
            </time>
          )}
        </dd>
      </dl>
      <form method="post" action={SWITCH_BRIEFS_PATH} className="actions">
        <input type="hidden" name="on" value={brief.on ? "off" : "on"} />
        <button className={brief.on ? "button button-danger" : "button"} type="submit">
          {brief.on ? "Stop my briefs" : "Start my briefs"}
        </button>
      </form>
      <h3>What your brief would say now</h3>
      <p className="muted">
        What is new since{" "}
        <time dateTime={brief.brief.since} title={brief.brief.since}>
          {brief.brief.since.slice(0, 10)}
        </time>
        {brief.on ? null : ", though none is sent while your briefs are off"}.
      </p>
      {brief.brief.sections.length === 0 ? (
        <p className="muted">Nothing new: no brief would be sent.</p>
      ) : (
        brief.brief.sections.map((section) => {
          const more = moreText(section.more);
          return (
            <section key={section.kind}>
              <h4>{section.title}</h4>
              <ul>
                {section.lines.map((line, i) => (
                  <li key={i}>
                    <Line line={line} webBaseUrl={webBaseUrl} />
                  </li>
                ))}
              </ul>
              {more === undefined ? null : <p className="muted">{more}</p>}
            </section>
          );
        })
      )}
    </>
  );
}

function Line({ line, webBaseUrl }: { line: BriefLine; webBaseUrl: string }) {
  const link = briefLink(line, webBaseUrl);
  switch (link.kind) {
    case "text":
      return <>{line.text}</>;
    case "app":
      return <a href={link.href}>{line.text}</a>;
    case "slack":
      return (
        <a href={link.href} target="_blank" rel="noreferrer">
          {line.text}
        </a>
      );
  }
}

function Footer({ person }: { person: Person }) {
  return (
    <footer className="muted">
      <a href="/">Agents at work</a> · <a href="/decisions">Decisions</a> ·{" "}
      <a href="/areas">Areas</a> · <a href="/conflicts">Conflicts</a> · <a href="/tasks">Tasks</a> ·{" "}
      <a href="/waits">Waiting on</a> · <a href="/jobs">Jobs</a> ·{" "}
      <a href="/listening">Listening in channels</a> · Signed in as {person.name}.
    </footer>
  );
}
