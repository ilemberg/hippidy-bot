import {
  DEFAULT_GOAL_CAP_CENTS,
  DEFAULT_GOAL_EVERY_MINUTES,
  DEFAULT_GOAL_LIMIT,
  MAX_GOAL_LIMIT,
} from "@hippidy/contracts";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "../../../lib/cookies.ts";
import { loadNewGoal, NEW_GOAL_PATH, type NewGoalView } from "../../../lib/goals.ts";
import { capFieldValue, jobNoticeText, type JobNotice } from "../../../lib/jobs.ts";
import { serverDeps } from "../../../lib/server.ts";

export const dynamic = "force-dynamic";

// "New goal" (slice 4.4): a goal for a thread the bot is in, with the feature's tickets in
// order. Its page is a job's: the goal's own address is `/jobs/<name>`.

const one = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : undefined;

export default async function NewGoal({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const view = await loadNewGoal(
    {
      sessionCookie: (await cookies()).get(SESSION_COOKIE)?.value,
      error: one(query.error),
      tickets: one(query.tickets),
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
        <a href="/jobs">Jobs</a>
      </p>
      <h2>New goal</h2>
      <section className="about">
        <p>
          A goal works through a feature&apos;s tickets in order. Every few minutes it checks the
          changes it started, and, while fewer than its limit are open, writes the next
          ticket&apos;s brief and posts it in the thread. Someone presses Start on each brief before
          the coding worker gets it.
        </p>
        <p className="muted">
          When a pull request merges, a built-in task is marked done; a Jira ticket is left for
          someone to close. You own the goal; anyone signed in may change it, and each change is
          kept.
        </p>
      </section>
      <View view={view} />
    </>
  );
}

function Notice({ notice }: { notice: JobNotice | undefined }) {
  if (notice === undefined) return null;
  return (
    <p className={notice.kind === "error" ? "notice notice-error" : "notice"} role="status">
      {jobNoticeText(notice)}
    </p>
  );
}

function View({ view }: { view: NewGoalView }) {
  switch (view.kind) {
    case "unconfigured":
      return <p className="muted">Sign-in is not set up yet.</p>;
    case "signed_out":
      return (
        <p>
          <a className="button" href="/auth/slack">
            Sign in with Slack
          </a>{" "}
          <span className="muted">to make a goal.</span>
        </p>
      );
    case "signed_in":
      return (
        <>
          <Notice notice={view.notice} />
          <section className="actions">
            <form method="post" action={NEW_GOAL_PATH} className="edit">
              <label>
                Thread link{" "}
                <span className="muted">
                  (in Slack: the thread&apos;s More actions, Copy link; mention the bot there first)
                </span>
                <input
                  name="link"
                  type="url"
                  placeholder="https://your-team.slack.com/archives/C123ABC/p1700000000000200"
                  required
                />
              </label>
              <label>
                Name <span className="muted">(lowercase letters, digits and hyphens)</span>
                <input
                  name="name"
                  placeholder="export"
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  maxLength={60}
                  required
                />
              </label>
              <label>
                Goal <span className="muted">(what the feature is for, in words)</span>
                <textarea name="goal" rows={3} maxLength={2000} required />
              </label>
              <label>
                Tickets, in order{" "}
                <span className="muted">(1 to 30 keys, one per line or separated by commas)</span>
                <textarea name="tickets" rows={5} placeholder={"T-4\nT-5\nT-6"} required />
              </label>
              <label>
                Limit on open changes <span className="muted">(1 to {MAX_GOAL_LIMIT})</span>
                <input
                  name="limit"
                  type="number"
                  min={1}
                  max={MAX_GOAL_LIMIT}
                  step={1}
                  defaultValue={DEFAULT_GOAL_LIMIT}
                  required
                />
              </label>
              <label>
                Cap, in dollars a month <span className="muted">($0.00 to $100.00)</span>
                <input
                  name="cap"
                  defaultValue={capFieldValue(DEFAULT_GOAL_CAP_CENTS)}
                  inputMode="decimal"
                  pattern="\$?\s*\d+(\.\d{1,2})?"
                  required
                />
              </label>
              <label>
                Interval, in minutes <span className="muted">(1 to 1,440)</span>
                <input
                  name="everyMinutes"
                  type="number"
                  min={1}
                  max={1440}
                  step={1}
                  defaultValue={DEFAULT_GOAL_EVERY_MINUTES}
                  required
                />
              </label>
              <button className="button" type="submit">
                Make the goal
              </button>
            </form>
          </section>
        </>
      );
  }
}
