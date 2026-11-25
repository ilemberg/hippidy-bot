import type { Conflict, Decision, DecisionDetail } from "@hippidy/contracts";
import { cookies } from "next/headers";
import type { ApiResult } from "../../../lib/api-client.ts";
import { areaHref } from "../../../lib/areas.ts";
import { conflictHref, decidersText } from "../../../lib/conflicts.ts";
import { SESSION_COOKIE } from "../../../lib/cookies.ts";
import {
  historyItems,
  loadDecision,
  nameOf,
  noticeText,
  notAllowedText,
  notProposedText,
  statusLabel,
  when,
  whereDecided,
  WITHDRAW_TEXT,
  type ActionNotice,
  type DecisionView,
} from "../../../lib/decisions.ts";
import { serverDeps } from "../../../lib/server.ts";

export const dynamic = "force-dynamic";

// One decision (slice 2.6): what it says, where and by whom it was decided, its open conflicts
// (slice 3.2), its history, and the forms the signed-in person may use on it.

const one = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : undefined;

export default async function DecisionPage({
  params,
  searchParams,
}: {
  params: Promise<{ number: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { number } = await params;
  const query = await searchParams;
  const view = await loadDecision(
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
        <a href="/decisions">Decisions</a>
      </p>
      <View view={view} />
    </>
  );
}

function Notice({ notice, decision }: { notice: ActionNotice | undefined; decision?: Decision }) {
  if (notice === undefined) return null;
  return (
    <p className={notice.kind === "error" ? "notice notice-error" : "notice"} role="status">
      {noticeText(notice, decision)}
    </p>
  );
}

function View({ view }: { view: DecisionView }) {
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
            <span className="muted">to see the team&apos;s decisions.</span>
          </p>
        </>
      );
    case "not_found":
      return <p className="notice">There is no such decision.</p>;
    case "failed":
      return <p className="notice">The API did not answer ({view.reason}).</p>;
    case "ok":
      return (
        <Detail
          detail={view.detail}
          conflicts={view.conflicts}
          notice={view.notice}
          now={new Date(view.readAt)}
        />
      );
  }
}

function Detail({
  detail,
  conflicts,
  notice,
  now,
}: {
  detail: DecisionDetail;
  conflicts: ApiResult<Conflict[]>;
  notice: ActionNotice | undefined;
  now: Date;
}) {
  const decision = detail.decision;
  const where = whereDecided(decision);
  return (
    <>
      <h2>Decision {decision.number}</h2>
      <Notice notice={notice} decision={decision} />
      <p className="statement">{decision.statement}</p>
      <dl className="facts">
        <dt>Status</dt>
        <dd>
          <span className={`state status-${decision.status}`}>{statusLabel[decision.status]}</span>
        </dd>
        <dt>Reason</dt>
        <dd>{decision.reason ?? <span className="muted">None given</span>}</dd>
        <dt>Area</dt>
        <dd>
          {decision.area === null ? (
            <span className="muted">No area</span>
          ) : (
            <a href={areaHref(decision.area.toLowerCase())}>{decision.area}</a>
          )}
        </dd>
        <dt>Decided</dt>
        <dd>
          By {nameOf(decision.decidedBy)},{" "}
          <time dateTime={decision.decidedAt} title={decision.decidedAt}>
            {when(decision.decidedAt, now)}
          </time>
        </dd>
        {decision.confirmedBy === null || decision.confirmedAt === null ? null : (
          <>
            <dt>Confirmed</dt>
            <dd>
              By {nameOf(decision.confirmedBy)},{" "}
              <time dateTime={decision.confirmedAt} title={decision.confirmedAt}>
                {when(decision.confirmedAt, now)}
              </time>
            </dd>
          </>
        )}
        {decision.rejectedBy === null || decision.rejectedAt === null ? null : (
          <>
            <dt>Rejected</dt>
            <dd>
              By {nameOf(decision.rejectedBy)},{" "}
              <time dateTime={decision.rejectedAt} title={decision.rejectedAt}>
                {when(decision.rejectedAt, now)}
              </time>
            </dd>
          </>
        )}
        {where === undefined ? null : (
          <>
            <dt>Where</dt>
            <dd>
              {where.kind === "link" ? (
                <a href={where.href} rel="noreferrer">
                  {where.text}
                </a>
              ) : (
                where.text
              )}
            </dd>
          </>
        )}
        {decision.supersedes === null ? null : (
          <>
            <dt>Replaces</dt>
            <dd>
              <a href={`/decisions/${decision.supersedes}`}>Decision {decision.supersedes}</a>
            </dd>
          </>
        )}
      </dl>
      <Conflicts conflicts={conflicts} now={now} />
      <Actions detail={detail} />
      <h3>History</h3>
      <ul className="sessions">
        {historyItems(detail).map((item) => (
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
  );
}

function Actions({ detail }: { detail: DecisionDetail }) {
  const decision = detail.decision;
  if (decision.status !== "proposed") {
    const text = notProposedText(decision);
    return text === undefined ? null : <p className="muted">{text}</p>;
  }
  const base = `/decisions/${decision.number}`;
  if (!detail.youMay.act) {
    const refusal = <p className="notice">{notAllowedText(detail.youMay.reason, decision)}</p>;
    if (detail.youMay.withdraw !== true) return refusal;
    // Not a decider of a guarded proposal, but may withdraw it (decision 208).
    return (
      <section className="actions">
        <h3>This is a proposal</h3>
        {refusal}
        <p className="muted">{WITHDRAW_TEXT}</p>
        <form method="post" action={`${base}/reject`}>
          <input type="hidden" name="wordingVersion" value={decision.wordingVersion} />
          <button className="button button-danger" type="submit">
            Withdraw
          </button>
        </form>
      </section>
    );
  }
  return (
    <section className="actions">
      <h3>This is a proposal</h3>
      <p className="muted">Confirm it to put it on record, or reject it. Either is noted.</p>
      <div className="buttons">
        <form method="post" action={`${base}/confirm`}>
          <input type="hidden" name="wordingVersion" value={decision.wordingVersion} />
          <button className="button" type="submit">
            Confirm
          </button>
        </form>
        <form method="post" action={`${base}/reject`}>
          <input type="hidden" name="wordingVersion" value={decision.wordingVersion} />
          <button className="button button-danger" type="submit">
            Reject
          </button>
        </form>
      </div>
      <h3>Change its wording</h3>
      <form method="post" action={`${base}/edit`} className="edit">
        <input type="hidden" name="wordingVersion" value={decision.wordingVersion} />
        <label>
          Statement
          <textarea name="statement" defaultValue={decision.statement} maxLength={500} rows={3} />
        </label>
        <label>
          Reason <span className="muted">(empty clears it)</span>
          <textarea name="reason" defaultValue={decision.reason ?? ""} maxLength={2000} rows={4} />
        </label>
        <label>
          Area <span className="muted">(empty clears it)</span>
          <input name="area" defaultValue={decision.area ?? ""} maxLength={100} />
        </label>
        <p className="muted">Saving does not confirm it.</p>
        <button className="button" type="submit">
          Save changes
        </button>
      </form>
    </section>
  );
}

function Conflicts({ conflicts, now }: { conflicts: ApiResult<Conflict[]>; now: Date }) {
  if (conflicts.kind === "failed") {
    return <p className="muted">Its open conflicts could not be read ({conflicts.reason}).</p>;
  }
  if (conflicts.value.length === 0) return null;
  return (
    <section className="actions">
      <h3>Open conflicts</h3>
      <ul className="sessions">
        {conflicts.value.map((conflict) => (
          <li key={conflict.id} className="session">
            <p className="session-title">
              <a href={conflictHref(conflict.number)}>Conflict {conflict.number}</a>
            </p>
            <p>{conflict.summary}</p>
            <p className="muted">
              Decides: {decidersText(conflict.deciders)} · raised{" "}
              <time dateTime={conflict.createdAt} title={conflict.createdAt}>
                {when(conflict.createdAt, now)}
              </time>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
