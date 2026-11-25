import type { AreaDetail } from "@hippidy/contracts";
import { cookies } from "next/headers";
import type { ApiResult } from "../../../lib/api-client.ts";
import {
  areaHistoryItems,
  areaHref,
  areaNoticeText,
  loadArea,
  ownerOptions,
  ownerText,
  type AreaNotice,
  type AreaView,
  type Known,
} from "../../../lib/areas.ts";
import { SESSION_COOKIE } from "../../../lib/cookies.ts";
import { when } from "../../../lib/decisions.ts";
import { serverDeps } from "../../../lib/server.ts";
import type { Person } from "../../../lib/tokens.ts";

export const dynamic = "force-dynamic";

// One area (slice 3.1): its owner, words and paths, the form that changes it, and its history.

const one = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : undefined;

export default async function AreaPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { name } = await params;
  const query = await searchParams;
  const view = await loadArea(
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
        <a href="/areas">Areas</a>
      </p>
      <View view={view} />
    </>
  );
}

function Notice({ notice }: { notice: AreaNotice | undefined }) {
  if (notice === undefined) return null;
  return (
    <p className={notice.kind === "error" ? "notice notice-error" : "notice"} role="status">
      {areaNoticeText(notice)}
    </p>
  );
}

function View({ view }: { view: AreaView }) {
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
            <span className="muted">to see the team&apos;s areas.</span>
          </p>
        </>
      );
    case "not_found":
      return (
        <p className="notice">
          {view.name === undefined
            ? "There is no such area."
            : `There is no area named “${view.name}” yet.`}{" "}
          It can be created on the <a href="/areas#new-area">areas page</a>.
        </p>
      );
    case "failed":
      return <p className="notice">The API did not answer ({view.reason}).</p>;
    case "ok":
      return (
        <Detail
          detail={view.detail}
          people={view.people}
          fallback={view.fallbackOwner}
          notice={view.notice}
          you={view.person}
          now={new Date(view.readAt)}
        />
      );
  }
}

function List({ values }: { values: string[] }) {
  if (values.length === 0) return <span className="muted">None</span>;
  return (
    <>
      {values.map((value, i) => (
        <span key={value}>
          {i === 0 ? null : ", "}
          <code>{value}</code>
        </span>
      ))}
    </>
  );
}

function Detail({
  detail,
  people,
  fallback,
  notice,
  you,
  now,
}: {
  detail: AreaDetail;
  people: ApiResult<Known[]>;
  fallback: Known | null;
  notice: AreaNotice | undefined;
  you: Person;
  now: Date;
}) {
  const area = detail.area;
  return (
    <>
      <h2>{area.name}</h2>
      <Notice notice={notice} />
      <dl className="facts">
        <dt>Owner</dt>
        <dd>{ownerText(area.owner, fallback)}</dd>
        <dt>Description</dt>
        <dd>{area.description ?? <span className="muted">None</span>}</dd>
        <dt>Words</dt>
        <dd>
          <List values={area.words} />
        </dd>
        <dt>Paths</dt>
        <dd>
          <List values={area.paths} />
        </dd>
      </dl>
      <p className="muted">
        Decisions in this area are listed under {area.name} on the{" "}
        <a href="/decisions">decisions page</a>.
      </p>
      <section className="actions">
        <h3>Change it</h3>
        <form method="post" action={`${areaHref(area.name)}/edit`} className="edit">
          <input type="hidden" name="version" value={area.version} />
          <label>
            Name{" "}
            <span className="muted">(decisions keep the area name they were recorded with)</span>
            <input name="name" defaultValue={area.name} required maxLength={60} />
          </label>
          <label>
            Description <span className="muted">(empty clears it)</span>
            <input name="description" defaultValue={area.description ?? ""} maxLength={300} />
          </label>
          <label>
            Owner
            <select name="owner" defaultValue={area.owner?.actorId ?? ""}>
              {ownerOptions(people, area.owner, you).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {people.kind === "failed" ? (
            <p className="muted">
              The people the bot knows could not be read ({people.reason}), so only the owner now
              and you are offered.
            </p>
          ) : null}
          <label>
            Words <span className="muted">(one per line)</span>
            <textarea name="words" defaultValue={area.words.join("\n")} rows={4} />
          </label>
          <label>
            Paths <span className="muted">(one per line)</span>
            <textarea name="paths" defaultValue={area.paths.join("\n")} rows={4} />
          </label>
          <button className="button" type="submit">
            Save changes
          </button>
        </form>
      </section>
      <h3>History</h3>
      <ul className="sessions">
        {areaHistoryItems(detail).map((item) => (
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
