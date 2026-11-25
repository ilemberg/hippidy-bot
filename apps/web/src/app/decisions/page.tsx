import type { Decision } from "@hippidy/contracts";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "../../lib/cookies.ts";
import {
  DECISIONS_LIMIT,
  loadDecisions,
  nameOf,
  statusFilterLabel,
  statusFilters,
  statusLabel,
  when,
  type DecisionsView,
  type StatusFilter,
} from "../../lib/decisions.ts";
import { serverDeps } from "../../lib/server.ts";

export const dynamic = "force-dynamic";

// The wiki (slice 2.6): every decision on record, by area, searchable.

const one = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : undefined;

export default async function Decisions({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const view = await loadDecisions(
    {
      sessionCookie: (await cookies()).get(SESSION_COOKIE)?.value,
      q: one(params.q),
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
      <h2>Decisions</h2>
      <View view={view} />
    </>
  );
}

function listLink(q: string | undefined, filter: StatusFilter): string {
  const params = new URLSearchParams();
  if (q !== undefined) params.set("q", q);
  if (filter !== "open") params.set("status", filter);
  const search = params.toString();
  return search === "" ? "/decisions" : `/decisions?${search}`;
}

function View({ view }: { view: DecisionsView }) {
  switch (view.kind) {
    case "unconfigured":
      return <p className="muted">Sign-in is not set up yet.</p>;
    case "signed_out":
      return (
        <p>
          <a className="button" href="/auth/slack">
            Sign in with Slack
          </a>{" "}
          <span className="muted">to see the team&apos;s decisions.</span>
        </p>
      );
    case "signed_in": {
      const now = new Date(view.readAt);
      return (
        <>
          <p className="muted">
            What the team has decided, by area. Open one to see its history; a proposal can be
            confirmed, changed or rejected there by the people who wrote in its thread.
          </p>
          <form method="get" action="/decisions" className="search">
            <input
              type="search"
              name="q"
              defaultValue={view.q ?? ""}
              maxLength={200}
              aria-label="Search decisions"
              placeholder="Search decisions"
            />
            {view.filter === "open" ? null : (
              <input type="hidden" name="status" value={view.filter} />
            )}
            <button className="button" type="submit">
              Search
            </button>
          </form>
          <p className="filters">
            {statusFilters.map((filter) =>
              filter === view.filter ? (
                <strong key={filter} aria-current="page">
                  {statusFilterLabel[filter]}
                </strong>
              ) : (
                <a key={filter} href={listLink(view.q, filter)}>
                  {statusFilterLabel[filter]}
                </a>
              ),
            )}
          </p>
          {view.q === undefined ? null : (
            <p className="muted">
              Matching &ldquo;{view.q}&rdquo;. <a href={listLink(undefined, view.filter)}>Clear</a>
            </p>
          )}
          {view.groups.kind === "failed" ? (
            <p className="notice">The API did not answer ({view.groups.reason}).</p>
          ) : view.groups.value.length === 0 ? (
            <p className="muted">No decisions here.</p>
          ) : (
            view.groups.value.map((group) => (
              <section key={group.area ?? ""}>
                <h3>{group.label}</h3>
                <ul className="sessions">
                  {group.decisions.map((decision) => (
                    <DecisionItem key={decision.id} decision={decision} now={now} />
                  ))}
                </ul>
              </section>
            ))
          )}
          {view.truncated ? (
            <p className="muted">
              Showing at most {DECISIONS_LIMIT} of each status. Search to find others.
            </p>
          ) : null}
          <footer className="muted">
            <a href="/">Agents at work</a> · <a href="/areas">Areas</a> ·{" "}
            <a href="/conflicts">Conflicts</a> · <a href="/listening">Listening in channels</a> ·
            Signed in as {view.person.name}.
          </footer>
        </>
      );
    }
  }
}

function DecisionItem({ decision, now }: { decision: Decision; now: Date }) {
  return (
    <li className="session">
      <div className="session-head">
        <span className={`state status-${decision.status}`}>{statusLabel[decision.status]}</span>
        <span className="muted">Decision {decision.number}</span>
      </div>
      <p className="session-title">
        <a href={`/decisions/${decision.number}`}>{decision.statement}</a>
      </p>
      <p className="muted">
        Decided by {nameOf(decision.decidedBy)},{" "}
        <time dateTime={decision.decidedAt}>{when(decision.decidedAt, now)}</time>
      </p>
    </li>
  );
}
