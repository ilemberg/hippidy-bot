import { cookies } from "next/headers";
import type { SignInNotice } from "../lib/auth-flow.ts";
import { SESSION_COOKIE } from "../lib/cookies.ts";
import { loadHome, type HomeView } from "../lib/home.ts";
import { serverDeps } from "../lib/server.ts";

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
    case "signed_in":
      return (
        <>
          <p>Signed in as {view.person.name}</p>
          <h2>What the API says</h2>
          {view.me.kind === "ok" ? (
            <pre>{JSON.stringify(view.me.me, null, 2)}</pre>
          ) : (
            <p className="notice">The API did not answer ({view.me.reason}).</p>
          )}
          <form method="post" action="/auth/signout">
            <button className="button" type="submit">
              Sign out
            </button>
          </form>
        </>
      );
  }
}
