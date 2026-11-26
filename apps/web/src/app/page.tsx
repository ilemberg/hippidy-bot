import type { SessionActivity } from "@hippidy/contracts";
import { cookies } from "next/headers";
import type { SignInNotice } from "../lib/auth-flow.ts";
import { SESSION_COOKIE } from "../lib/cookies.ts";
import { loadHome, SESSIONS_SHOWN, type HomeView } from "../lib/home.ts";
import { serverDeps } from "../lib/server.ts";
import { agentLabel, ago, costText, stateLabel, threadLink } from "../lib/sessions-view.ts";

export const dynamic = "force-dynamic";

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
            <h2>Agents at work</h2>
            {/* The page is rendered on each request, so reloading it is the refresh. */}
            <a className="button" href="/">
              Refresh
            </a>
          </div>
          <p className="muted">
            The latest {SESSIONS_SHOWN}, working ones first. As of{" "}
            <time dateTime={view.readAt}>{readAt.toUTCString()}</time>.
          </p>
          {view.sessions.kind === "failed" ? (
            <p className="notice">The API did not answer ({view.sessions.reason}).</p>
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
          <footer className="muted">
            <a href="/decisions">Decisions</a> · <a href="/areas">Areas</a> ·{" "}
            <a href="/conflicts">Conflicts</a> · <a href="/tasks">Tasks</a> ·{" "}
            <a href="/waits">Waiting on</a> · <a href="/listening">Listening in channels</a> ·
            Signed in as {view.person.name}.{" "}
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
