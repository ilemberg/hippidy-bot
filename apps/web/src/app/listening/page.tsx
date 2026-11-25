import type { Decision, ListeningChannel } from "@hippidy/contracts";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "../../lib/cookies.ts";
import { loadListening, type ListeningView } from "../../lib/listening.ts";
import { serverDeps } from "../../lib/server.ts";
import { ago, channelLink, messageLink } from "../../lib/sessions-view.ts";

export const dynamic = "force-dynamic";

// The page about listening (slice 2.5, G9): where the bot listens, what it reads and keeps,
// how to switch it off or have something deleted, and what it proposed.

export default async function Listening() {
  const view = await loadListening(
    { sessionCookie: (await cookies()).get(SESSION_COOKIE)?.value },
    serverDeps(),
  );
  return (
    <>
      <h1>
        <a href="/" className="home">
          hippidy-bot
        </a>
      </h1>
      <h2>Listening in channels</h2>
      <About />
      <View view={view} />
    </>
  );
}

function About() {
  return (
    <section className="about">
      <p>
        In a channel where someone said <code>@hippidy listen</code>, the bot reads every message,
        not only those that mention it. It never replies to a message that does not mention it.
      </p>
      <p>
        <strong>What it keeps:</strong> each message&apos;s text, who wrote it, when, and the link
        to it. Nothing else. Each message is deleted 30 days after it was written. Deleting a
        message in Slack deletes the bot&apos;s copy too.
      </p>
      <p>
        <strong>What it does with it:</strong> when a thread has been quiet for half an hour, a
        small model reads it once and may note decisions from it as proposals, each with a link to
        the message. Only the people who wrote in that thread confirm a proposal; the bot never
        records one on its own.
      </p>
      <p>
        <strong>Switching it off:</strong> say <code>@hippidy stop listening</code> in the channel.
        To have something deleted sooner, delete the message in Slack, or ask the owner.
      </p>
    </section>
  );
}

function View({ view }: { view: ListeningView }) {
  switch (view.kind) {
    case "unconfigured":
      return <p className="muted">Sign-in is not set up yet.</p>;
    case "signed_out":
      return (
        <p>
          <a className="button" href="/auth/slack">
            Sign in with Slack
          </a>{" "}
          <span className="muted">to see where the bot listens.</span>
        </p>
      );
    case "signed_in": {
      const now = new Date(view.readAt);
      return (
        <>
          <h3>Channels</h3>
          {view.listening.kind === "failed" ? (
            <p className="notice">The API did not answer ({view.listening.reason}).</p>
          ) : view.listening.value.channels.length === 0 ? (
            <p className="muted">The bot listens in no channel.</p>
          ) : (
            <ul className="sessions">
              {view.listening.value.channels.map((channel) => (
                <ChannelItem key={channel.channelId} channel={channel} now={now} />
              ))}
            </ul>
          )}
          <h3>Proposed from listening</h3>
          {view.proposals.kind === "failed" ? (
            <p className="notice">The API did not answer ({view.proposals.reason}).</p>
          ) : view.proposals.value.length === 0 ? (
            <p className="muted">No proposals waiting.</p>
          ) : (
            <ul className="sessions">
              {view.proposals.value.map((decision) => (
                <ProposalItem key={decision.id} decision={decision} now={now} />
              ))}
            </ul>
          )}
          <p className="muted">
            Open a proposal to confirm, change or reject it. Only the people who wrote in its thread
            can. All decisions are under <a href="/decisions">Decisions</a>.
          </p>
        </>
      );
    }
  }
}

function ChannelItem({ channel, now }: { channel: ListeningChannel; now: Date }) {
  const who = channel.changedBy.name ?? channel.changedBy.actorId;
  return (
    <li className="session">
      <p className="session-title">
        <a href={channelLink(channel.channelId)} rel="noreferrer">
          {channel.channelId}
        </a>
      </p>
      <p className="muted">
        {channel.listening
          ? `Listening since ${ago(channel.startedAt, now)}, switched on by ${who}`
          : `Not listening: switched off ${ago(channel.changedAt, now)} by ${who}`}
      </p>
    </li>
  );
}

function ProposalItem({ decision, now }: { decision: Decision; now: Date }) {
  const link =
    decision.channelId === null || decision.messageId === null
      ? undefined
      : messageLink("slack", decision.channelId, decision.threadId, decision.messageId);
  const who = decision.decidedBy.name ?? decision.decidedBy.actorId ?? "someone";
  return (
    <li className="session">
      <p className="session-title">
        <a href={`/decisions/${decision.number}`}>{decision.statement}</a>
      </p>
      {decision.reason === null ? null : <p>{decision.reason}</p>}
      <p className="muted">
        Decided by {who}, {ago(decision.decidedAt, now)}
        {decision.area === null ? "" : ` · ${decision.area}`} · proposal {decision.number}
        {link === undefined ? null : (
          <>
            {" · "}
            <a href={link} rel="noreferrer">
              the message
            </a>
          </>
        )}
      </p>
    </li>
  );
}
