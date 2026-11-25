import type { ActivityState, SessionActivity } from "@hippidy/contracts";

// How the monitoring page words a session (slice 2.4), kept out of the page so it is tested
// without Next.js.

export const stateLabel: Record<ActivityState, string> = {
  working: "Working",
  waiting_for_start: "Waiting for Start",
  idle: "Idle",
  failed: "Failed",
  stopped: "Stopped",
};

export const agentLabel: Record<SessionActivity["agent"], string> = {
  teammate: "Teammate",
  engineer: "Engineer",
  product: "Product",
  worker: "Coding worker",
};

/** Money in minor units as "$0.42", or the amount and its currency code when it is not USD. */
export function formatMoney(minor: number, currency: string | null): string {
  const amount = (minor / 100).toFixed(2);
  return currency === null || currency === "USD" ? `$${amount}` : `${amount} ${currency}`;
}

/** "$0.42 of $5.00", "$0.42", or "No cost yet". */
export function costText(cost: SessionActivity["cost"]): string {
  if (cost.spentMinor === null) return "No cost yet";
  const spent = formatMoney(cost.spentMinor, cost.currency);
  return cost.budgetMinor === null
    ? spent
    : `${spent} of ${formatMoney(cost.budgetMinor, cost.currency)}`;
}

/**
 * A link to the session's Slack thread. `slack.com/archives` sends a signed-in person to the
 * message in their workspace; the thread id is the root message's ts without its dot.
 */
export function threadLink(thread: SessionActivity["thread"]): string | undefined {
  if (thread.source !== "slack") return undefined;
  const channel = encodeURIComponent(thread.channelId);
  return `https://slack.com/archives/${channel}/p${thread.threadId.replace(".", "")}`;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function ago(at: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - new Date(at).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** A link to one message, in its thread when it is a reply. */
export function messageLink(
  source: SessionActivity["thread"]["source"],
  channelId: string,
  threadId: string | null,
  messageId: string,
): string | undefined {
  if (source !== "slack") return undefined;
  const channel = encodeURIComponent(channelId);
  const link = `https://slack.com/archives/${channel}/p${messageId.replace(".", "")}`;
  return threadId === null || threadId === messageId
    ? link
    : `${link}?thread_ts=${encodeURIComponent(threadId)}&cid=${channel}`;
}

/** A link to a channel. */
export function channelLink(channelId: string): string {
  return `https://slack.com/archives/${encodeURIComponent(channelId)}`;
}
