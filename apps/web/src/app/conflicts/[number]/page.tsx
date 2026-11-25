import type { Conflict, ConflictDetail } from "@hippidy/contracts";
import { cookies } from "next/headers";
import { areaHref } from "../../../lib/areas.ts";
import {
  conflictHref,
  conflictThread,
  decidersText,
  kindAbout,
  kindLabel,
  loadConflict,
  outcomeLabel,
  refusalText,
  settleAbout,
  settleNoticeText,
  type ConflictView,
  type SettleNotice,
} from "../../../lib/conflicts.ts";
import { SESSION_COOKIE } from "../../../lib/cookies.ts";
import { nameOf, statusLabel, when } from "../../../lib/decisions.ts";
import { serverDeps } from "../../../lib/server.ts";

export const dynamic = "force-dynamic";

// One conflict (slice 3.2): what it is about, who wants what, the decisions it bears on, who
// decides, how it was settled, and the form that settles it for one of its deciders.

const one = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : undefined;

export default async function ConflictPage({
  params,
  searchParams,
}: {
  params: Promise<{ number: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { number } = await params;
  const query = await searchParams;
  const view = await loadConflict(
    {
      sessionCookie: (await cookies()).get(SESSION_COOKIE)?.value,
      number,
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
        <a href="/conflicts">Conflicts</a>
      </p>
      <View view={view} />
    </>
  );
}

function Notice({ notice, conflict }: { notice: SettleNotice | undefined; conflict?: Conflict }) {
  if (notice === undefined) return null;
  return (
    <p className={notice.kind === "error" ? "notice notice-error" : "notice"} role="status">
      {settleNoticeText(notice, conflict)}
    </p>
  );
}

function View({ view }: { view: ConflictView }) {
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
            <span className="muted">to see the team&apos;s conflicts.</span>
          </p>
        </>
      );
    case "not_found":
      return <p className="notice">There is no such conflict.</p>;
    case "failed":
      return <p className="notice">The API did not answer ({view.reason}).</p>;
    case "ok":
      return <Detail detail={view.detail} notice={view.notice} now={new Date(view.readAt)} />;
  }
}

type DecisionRef = Conflict["decisions"][number];

function DecisionLink({ decision }: { decision: DecisionRef }) {
  return (
    <>
      <a href={`/decisions/${decision.number}`}>Decision {decision.number}</a>: {decision.statement}{" "}
      <span className="muted">
        ({statusLabel[decision.status].toLowerCase()}, decided by {nameOf(decision.decidedBy)})
      </span>
    </>
  );
}

function Detail({
  detail,
  notice,
  now,
}: {
  detail: ConflictDetail;
  notice: SettleNotice | undefined;
  now: Date;
}) {
  const conflict = detail.conflict;
  const thread = conflictThread(conflict);
  return (
    <>
      <h2>Conflict {conflict.number}</h2>
      <Notice notice={notice} conflict={conflict} />
      <p className="statement">{conflict.summary}</p>
      <dl className="facts">
        <dt>Status</dt>
        <dd>
          {conflict.status === "open" ? (
            <span className="state status-proposed">Open</span>
          ) : (
            <span className="state status-superseded">Settled</span>
          )}
        </dd>
        <dt>Kind</dt>
        <dd>
          {kindLabel[conflict.kind]}. <span className="muted">{kindAbout[conflict.kind]}</span>
        </dd>
        <dt>Area</dt>
        <dd>
          {conflict.area === null ? (
            <span className="muted">No area</span>
          ) : (
            <a href={areaHref(conflict.area.toLowerCase())}>{conflict.area}</a>
          )}
        </dd>
        <dt>Decides</dt>
        <dd>{decidersText(conflict.deciders)}</dd>
        <dt>Raised</dt>
        <dd>
          <time dateTime={conflict.createdAt} title={conflict.createdAt}>
            {when(conflict.createdAt, now)}
          </time>
        </dd>
        {thread === undefined ? null : (
          <>
            <dt>Where</dt>
            <dd>
              {thread.kind === "link" ? (
                <a href={thread.href} rel="noreferrer">
                  {thread.text}
                </a>
              ) : (
                thread.text
              )}
            </dd>
          </>
        )}
      </dl>
      {conflict.positions.length === 0 ? null : (
        <>
          <h3>Who wants what</h3>
          <ul className="sessions">
            {conflict.positions.map((position) => (
              <li key={`${position.actorId}:${position.says}`} className="session">
                <p>
                  <strong>{nameOf(position)}</strong>: {position.says}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
      {conflict.decisions.length === 0 ? null : (
        <>
          <h3>Decisions it bears on</h3>
          <ul className="sessions">
            {conflict.decisions.map((decision) => (
              <li key={decision.number} className="session">
                <p>
                  <DecisionLink decision={decision} />
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
      {conflict.proposal === null ? null : (
        <>
          <h3>The proposal</h3>
          <p>
            <DecisionLink decision={conflict.proposal} />
          </p>
          {conflict.status === "open" ? (
            <p className="muted">
              It is settled by confirming or rejecting this proposal, on{" "}
              <a href={`/decisions/${conflict.proposal.number}`}>its page</a>: confirming it changes
              the decision, rejecting it keeps what was decided.
            </p>
          ) : null}
        </>
      )}
      <Settled conflict={conflict} now={now} />
      <Settle detail={detail} />
    </>
  );
}

function Settled({ conflict, now }: { conflict: Conflict; now: Date }) {
  if (conflict.status !== "settled") return null;
  return (
    <section className="actions">
      <h3>Settled</h3>
      <dl className="facts">
        {conflict.outcome === null ? null : (
          <>
            <dt>Outcome</dt>
            <dd>{outcomeLabel[conflict.outcome]}</dd>
          </>
        )}
        {conflict.note === null ? null : (
          <>
            <dt>Note</dt>
            <dd>{conflict.note}</dd>
          </>
        )}
        {conflict.settledBy === null ? null : (
          <>
            <dt>By</dt>
            <dd>{nameOf(conflict.settledBy)}</dd>
          </>
        )}
        {conflict.settledAt === null ? null : (
          <>
            <dt>When</dt>
            <dd>
              <time dateTime={conflict.settledAt} title={conflict.settledAt}>
                {when(conflict.settledAt, now)}
              </time>
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}

function Settle({ detail }: { detail: ConflictDetail }) {
  const conflict = detail.conflict;
  if (conflict.status === "settled") return null;
  if (!detail.youMay.settle) {
    return <p className="notice">{refusalText(detail.youMay.reason, conflict)}</p>;
  }
  return (
    <section className="actions">
      <h3>Settle it</h3>
      <p className="muted">{settleAbout(conflict)}</p>
      <form method="post" action={`${conflictHref(conflict.number)}/settle`} className="edit">
        <fieldset>
          <legend>Outcome</legend>
          <label>
            <input type="radio" name="outcome" value="kept" required /> Kept: what was decided
            stands
          </label>
          <label>
            <input type="radio" name="outcome" value="changed" /> Changed: the decision changes
          </label>
          <label>
            <input type="radio" name="outcome" value="dismissed" /> Dismissed: not a conflict after
            all
          </label>
        </fieldset>
        <label>
          Note <span className="muted">(optional, at most 500 characters)</span>
          <textarea name="note" maxLength={500} rows={3} />
        </label>
        <button className="button" type="submit">
          Settle
        </button>
      </form>
    </section>
  );
}
