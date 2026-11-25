import type { Area } from "@hippidy/contracts";
import { cookies } from "next/headers";
import {
  areaHref,
  areaNoticeText,
  CREATE_AREA_PATH,
  inShort,
  loadAreas,
  ownerOptions,
  ownerText,
  type AreaNotice,
  type AreasView,
  type Known,
} from "../../lib/areas.ts";
import type { ApiResult } from "../../lib/api-client.ts";
import { SESSION_COOKIE } from "../../lib/cookies.ts";
import { serverDeps } from "../../lib/server.ts";
import type { Person } from "../../lib/tokens.ts";

export const dynamic = "force-dynamic";

// Areas and their owners (slice 3.1): every area, and the form that creates one.

const one = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : undefined;

export default async function Areas({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const view = await loadAreas(
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
      <h2>Areas</h2>
      <section className="about">
        <p>
          An area is a part of the product with one owner. Briefs, pull requests and decisions that
          touch it name its owner in their thread, and the owner may confirm proposals in it.
        </p>
        <p className="muted">
          Its words mark it in text, and its name always counts as one. Its paths are patterns over
          the repository, like a CODEOWNERS file (<code>apps/api/src/store/**</code>). Anyone signed
          in may create or change an area; every change is kept with who made it and when.
        </p>
      </section>
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

function View({ view }: { view: AreasView }) {
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
    case "signed_in": {
      const fallback = view.list.kind === "ok" ? view.list.value.fallbackOwner : null;
      return (
        <>
          <Notice notice={view.notice} />
          {view.list.kind === "failed" ? (
            <p className="notice">The API did not answer ({view.list.reason}).</p>
          ) : view.list.value.areas.length === 0 ? (
            <p className="muted">No areas yet.</p>
          ) : (
            <ul className="sessions">
              {view.list.value.areas.map((area) => (
                <AreaItem key={area.id} area={area} fallback={fallback} />
              ))}
            </ul>
          )}
          <NewArea people={view.people} you={view.person} />
          <footer className="muted">
            <a href="/">Agents at work</a> · <a href="/decisions">Decisions</a> ·{" "}
            <a href="/conflicts">Conflicts</a> · <a href="/listening">Listening in channels</a> ·
            Signed in as {view.person.name}.
          </footer>
        </>
      );
    }
  }
}

function AreaItem({ area, fallback }: { area: Area; fallback: Known | null }) {
  return (
    <li className="session">
      <p className="session-title">
        <a href={areaHref(area.name)}>{area.name}</a>
      </p>
      <p className="muted">Owner: {ownerText(area.owner, fallback)}</p>
      {area.description === null ? null : <p>{area.description}</p>}
      {area.words.length === 0 ? null : <p className="muted">Words: {inShort(area.words)}</p>}
      {area.paths.length === 0 ? null : <p className="muted">Paths: {inShort(area.paths)}</p>}
    </li>
  );
}

function NewArea({ people, you }: { people: ApiResult<Known[]>; you: Person }) {
  return (
    <section className="actions" id="new-area">
      <h3>New area</h3>
      <form method="post" action={CREATE_AREA_PATH} className="edit">
        <label>
          Name <span className="muted">(lowercase, like the area decisions carry)</span>
          <input name="name" required maxLength={60} />
        </label>
        <label>
          Description <span className="muted">(a sentence, optional)</span>
          <input name="description" maxLength={300} />
        </label>
        <label>
          Owner
          <select name="owner" defaultValue="">
            {ownerOptions(people, null, you).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {people.kind === "failed" ? (
          <p className="muted">
            The people the bot knows could not be read ({people.reason}); you can choose an owner
            later.
          </p>
        ) : null}
        <label>
          Words <span className="muted">(one per line, optional)</span>
          <textarea name="words" rows={3} />
        </label>
        <label>
          Paths <span className="muted">(one per line, optional)</span>
          <textarea name="paths" rows={3} placeholder="apps/api/src/store/**" />
        </label>
        <button className="button" type="submit">
          Create area
        </button>
      </form>
    </section>
  );
}
