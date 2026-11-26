import type { Conflict } from "@hippidy/contracts";
import { cookies } from "next/headers";
import { areaHref } from "../../lib/areas.ts";
import {
  CONFLICTS_LIMIT,
  conflictFilterLabel,
  conflictFilters,
  conflictHref,
  conflictsHref,
  decidersText,
  kindLabel,
  loadConflicts,
  outcomeLabel,
  type ConflictsView,
} from "../../lib/conflicts.ts";
import { SESSION_COOKIE } from "../../lib/cookies.ts";
import { when } from "../../lib/decisions.ts";
import { serverDeps } from "../../lib/server.ts";

export const dynamic = "force-dynamic";

// Conflicts (slice 3.2): the open ones first, and the settled ones on request.

const one = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : undefined;

export default async function Conflicts({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const view = await loadConflicts(
    {
      sessionCookie: (await cookies()).get(SESSION_COOKIE)?.value,
      status: one(params.status),
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
      <h2>Conflicts</h2>
      <View view={view} />
    </>
  );
}

function View({ view }: { view: ConflictsView }) {
  switch (view.kind) {
    case "unconfigured":
      return <p className="muted">Sign-in is not set up yet.</p>;
    case "signed_out":
      return (
        <p>
          <a className="button" href="/auth/slack">
            Sign in with Slack
          </a>{" "}
          <span className="muted">to see the team&apos;s conflicts.</span>
        </p>
      );
    case "signed_in": {
      const now = new Date(view.readAt);
      return (
        <>
          <p className="muted">
            Where people want different things, or a proposal would replace someone else&apos;s
            decision. Until it is settled, what was decided stands. Each is settled by the people it
            names: the owner of its area, or whoever made the decision it would replace.
          </p>
          <p className="filters">
            {conflictFilters.map((filter) =>
              filter === view.filter ? (
                <strong key={filter} aria-current="page">
                  {conflictFilterLabel[filter]}
                </strong>
              ) : (
                <a key={filter} href={conflictsHref(filter)}>
                  {conflictFilterLabel[filter]}
                </a>
              ),
            )}
          </p>
          {view.list.kind === "failed" ? (
            <p className="notice">The API did not answer ({view.list.reason}).</p>
          ) : view.list.value.length === 0 ? (
            <p className="muted">
              {view.filter === "open" ? "No open conflicts." : "No conflicts here."}
            </p>
          ) : (
            <ul className="sessions">
              {view.list.value.map((conflict) => (
                <ConflictItem key={conflict.id} conflict={conflict} now={now} />
              ))}
            </ul>
          )}
          {view.truncated ? <p className="muted">Showing the latest {CONFLICTS_LIMIT}.</p> : null}
          <footer className="muted">
            <a href="/">Agents at work</a> · <a href="/decisions">Decisions</a> ·{" "}
            <a href="/areas">Areas</a> · <a href="/tasks">Tasks</a> ·{" "}
            <a href="/waits">Waiting on</a> · <a href="/brief">Your brief</a> ·{" "}
            <a href="/listening">Listening in channels</a> · Signed in as {view.person.name}.
          </footer>
        </>
      );
    }
  }
}

function ConflictItem({ conflict, now }: { conflict: Conflict; now: Date }) {
  return (
    <li className="session">
      <p className="session-title">
        <a href={conflictHref(conflict.number)}>Conflict {conflict.number}</a>{" "}
        {conflict.status === "settled" ? <span className="muted">(settled)</span> : null}
      </p>
      <p>{conflict.summary}</p>
      <p className="muted">
        {kindLabel[conflict.kind]}
        {conflict.area === null ? null : (
          <>
            {" "}
            · in <a href={areaHref(conflict.area.toLowerCase())}>{conflict.area}</a>
          </>
        )}{" "}
        · decides: {decidersText(conflict.deciders)} ·{" "}
        <time dateTime={conflict.createdAt} title={conflict.createdAt}>
          {when(conflict.createdAt, now)}
        </time>
      </p>
      {conflict.outcome === null ? null : <p className="muted">{outcomeLabel[conflict.outcome]}</p>}
    </li>
  );
}
