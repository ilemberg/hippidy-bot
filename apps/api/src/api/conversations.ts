import type {
  Deliverer,
  DeliveryTarget,
  InboundMessage,
  MessageSource,
  OutboundDelivery,
} from "@hippidy/contracts";
import type { AgentEvent, AgentRuntime, IdleReason } from "../agent/runtime.ts";
import type { Logger } from "../log.ts";
import {
  attachSession,
  claimDelivery,
  claimSessionStart,
  conversationsToReconcile,
  databaseNow,
  findOrCreateConversation,
  finishDelivery,
  getConversation,
  markForwarded,
  markWaiting,
  pendingForwards,
  recordInbound,
  releaseSessionStart,
  sessionIdOf,
  setAgentEventCursor,
  settleConversation,
  type Conversation,
  type DeliveryKind,
  type SettledStatus,
} from "../store/conversations.ts";
import type { Db } from "../store/db.ts";

export interface ConversationDeps {
  db: Db;
  runtime: AgentRuntime;
  /** One per source; registered in compose.ts (decision 53). */
  deliverers: Partial<Record<MessageSource, Deliverer>>;
  /** Waits between checks for a session another request is starting. Replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** How long a message may wait for the agent before reconcile looks at it. */
export const RECONCILE_AFTER_SECONDS = 60;
/** After this long without an answer, the turn is stopped and reported as failed. */
export const GIVE_UP_AFTER_MINUTES = 30;
const SESSION_START_WAIT_MS = 300;
const SESSION_START_ATTEMPTS = 40;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ReceiveResult {
  id: string;
  duplicate: boolean;
}

/**
 * Handles one inbound message: record it once, make sure the thread has an agent session, and
 * hand the message to it. Returns once the agent has the message; the answer arrives later
 * through the webhook or reconcile (decision 13).
 */
export async function receiveMessage(
  deps: ConversationDeps,
  message: InboundMessage,
  log: Logger,
): Promise<ReceiveResult> {
  const { conversation: c } = message;
  const conversation = await findOrCreateConversation(deps.db, {
    source: message.source,
    workspaceId: c.workspaceId,
    channelId: c.channelId,
    threadId: c.threadId,
  });
  const recorded = await recordInbound(deps.db, conversation.id, message);
  if (recorded.duplicate && recorded.forwarded) {
    log.info("conversation.duplicate_ignored", { conversationId: conversation.id });
    return { id: recorded.id, duplicate: true };
  }

  const sessionId = await ensureSession(deps, conversation, log);
  await deps.runtime.sendMessage(sessionId, formatForAgent(message.actor.id, message.text));
  await markForwarded(deps.db, recorded.id);
  await markWaiting(deps.db, conversation.id);
  log.info("conversation.message_forwarded", {
    conversationId: conversation.id,
    sessionId,
    inboundId: recorded.id,
  });
  return { id: recorded.id, duplicate: recorded.duplicate };
}

/** The text the agent sees: who sent it, then what they wrote. */
export function formatForAgent(actorId: string, text: string): string {
  const body = text.trim() === "" ? "(no text, just a mention)" : text;
  return `From: Slack user ${actorId}\n\n${body}`;
}

async function ensureSession(
  deps: ConversationDeps,
  conversation: Conversation,
  log: Logger,
): Promise<string> {
  const existing = sessionIdOf(conversation);
  if (existing !== undefined) return existing;
  const sleep = deps.sleep ?? defaultSleep;

  for (let attempt = 0; attempt < SESSION_START_ATTEMPTS; attempt++) {
    if (await claimSessionStart(deps.db, conversation.id)) {
      try {
        const session = await deps.runtime.startSession({
          title: `${conversation.key.source} ${conversation.key.channelId} ${conversation.key.threadId}`,
          metadata: {
            conversation_id: conversation.id,
            source: conversation.key.source,
            workspace_id: conversation.key.workspaceId,
            channel_id: conversation.key.channelId,
            thread_id: conversation.key.threadId,
          },
        });
        await attachSession(deps.db, conversation.id, session);
        log.info("conversation.session_started", {
          conversationId: conversation.id,
          sessionId: session.sessionId,
          agentVersion: session.agentVersion,
        });
        return session.sessionId;
      } catch (error) {
        await releaseSessionStart(deps.db, conversation.id);
        throw error;
      }
    }
    // Another request is starting the session for this thread: wait for it.
    const started = sessionIdOf(await getConversation(deps.db, conversation.id));
    if (started !== undefined) return started;
    await sleep(SESSION_START_WAIT_MS);
  }
  throw new Error("timed out waiting for another request to start this thread's session");
}

/** Short Markdown notes posted when a turn ends without an answer. */
const failureNotes: Record<Exclude<IdleReason, "end_turn"> | "terminated" | "timeout", string> = {
  budget_reached:
    "I've reached this conversation's spending limit, so I've stopped here. Start a new thread to carry on.",
  retries_exhausted:
    "Something went wrong on my side and I couldn't finish. Please try again in a new message.",
  refusal: "I can't help with that one.",
  requires_action: "I got stuck waiting for something I can't do yet. Please try again.",
  terminated: "This conversation's session has ended. Start a new thread to carry on.",
  timeout:
    "I took too long on this one and stopped. Please try again, perhaps with a narrower ask.",
};

/**
 * Brings a conversation up to date with its agent session: posts every agent message not yet
 * delivered, in order, and settles the messages the agent has finished with. Safe to run more
 * than once at the same time (webhook and reconcile): every delivery is claimed first.
 */
export async function syncConversation(
  deps: ConversationDeps,
  conversation: Conversation,
  log: Logger,
): Promise<void> {
  const sessionId = sessionIdOf(conversation);
  if (sessionId === undefined) return;
  // Taken before the session is read: only messages handed over before it can be settled.
  const cutoff = await databaseNow(deps.db);
  const events = await deps.runtime.listEvents(sessionId);

  const cursorIndex =
    conversation.agentEventCursor === null
      ? -1
      : events.findIndex((event) => event.id === conversation.agentEventCursor);
  let handled: string | undefined;
  for (const event of events.slice(cursorIndex + 1)) {
    if (event.kind === "agent_message") {
      const ok = await deliverOnce(deps, conversation, event.id, "reply", log, {
        kind: "reply",
        target: targetOf(conversation),
        text: event.text,
      });
      if (!ok) break; // keep the cursor here so the reply is retried, in order
    }
    handled = event.id;
  }
  if (handled !== undefined) await setAgentEventCursor(deps.db, conversation.id, handled);
  if (handled !== events.at(-1)?.id && events.length > cursorIndex + 1) return; // retry later

  const state = latestState(events);
  if (state === undefined) return;
  const ending = state.kind === "terminated" ? "terminated" : state.reason;
  if (ending === "end_turn") {
    await settle(deps, conversation, "answered", cutoff, state.id, log);
  } else {
    const note = failureNotes[ending];
    await deliverOnce(deps, conversation, `failure:${state.id}`, "failure", log, {
      kind: "reply",
      target: targetOf(conversation),
      text: note,
    });
    await settle(deps, conversation, "failed", cutoff, state.id, log);
  }
}

/**
 * The session's current state as of the last status event, unless a user message came after
 * it: then the agent has more to do and nothing can be settled yet.
 */
type StateEvent = Extract<AgentEvent, { kind: "idle" | "terminated" }>;

function latestState(events: AgentEvent[]): StateEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.kind === "user_message" || event.kind === "running") return undefined;
    if (event.kind === "idle" || event.kind === "terminated") return event;
  }
  return undefined;
}

const statusKind: Record<SettledStatus, DeliveryKind> = {
  answered: "reply",
  failed: "failure",
  stopped: "stopped",
};

async function settle(
  deps: ConversationDeps,
  conversation: Conversation,
  status: SettledStatus,
  cutoff: Date,
  eventId: string,
  log: Logger,
): Promise<void> {
  const messageIds = await settleConversation(deps.db, conversation.id, status, {
    forwardedBefore: cutoff,
  });
  if (messageIds.length === 0) return;
  log.info("conversation.settled", { conversationId: conversation.id, status, messageIds });
  await deliverOnce(
    deps,
    conversation,
    `status:${eventId}:${messageIds.join(",")}`,
    statusKind[status],
    log,
    { kind: "status", target: targetOf(conversation), messageIds, status },
  );
}

/** Sends a delivery unless it was already sent. Returns false if it failed this time. */
async function deliverOnce(
  deps: ConversationDeps,
  conversation: Conversation,
  key: string,
  kind: DeliveryKind,
  log: Logger,
  delivery: OutboundDelivery,
): Promise<boolean> {
  const claim = await claimDelivery(deps.db, conversation.id, key, kind);
  if (claim === undefined) return true; // sent already, or someone else is sending it
  const deliverer = deps.deliverers[conversation.key.source];
  try {
    if (deliverer === undefined) {
      throw new Error(`no deliverer registered for source "${conversation.key.source}"`);
    }
    await deliverer.deliver(delivery, conversation.agentSessionId ?? conversation.id);
    await finishDelivery(deps.db, claim);
    log.info("conversation.delivered", { conversationId: conversation.id, key, kind });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishDelivery(deps.db, claim, message);
    log.error("conversation.delivery_failed", {
      conversationId: conversation.id,
      key,
      attempt: claim.attempt,
      error,
    });
    return false;
  }
}

function targetOf(conversation: Conversation): DeliveryTarget {
  return { ...conversation.key };
}

export interface ReconcileResult {
  checked: number;
  failed: number;
}

/**
 * The safety net (decision 54): Anthropic's webhooks give up after three attempts, so this
 * runs about every minute and repairs whatever they missed. It hands over messages that never
 * reached the agent, posts replies that were never delivered, retries failed deliveries, and
 * stops turns that have run far too long.
 */
export async function reconcile(deps: ConversationDeps, log: Logger): Promise<ReconcileResult> {
  const conversations = await conversationsToReconcile(deps.db, {
    waitingForSeconds: RECONCILE_AFTER_SECONDS,
    limit: 20,
  });
  let failed = 0;
  for (const found of conversations) {
    const conversationLog = log.child({ conversationId: found.id });
    try {
      await forwardPending(deps, found, conversationLog);
      const conversation = await getConversation(deps.db, found.id);
      await syncConversation(deps, conversation, conversationLog);
      await giveUpIfTooLong(deps, await getConversation(deps.db, found.id), conversationLog);
    } catch (error) {
      failed++;
      conversationLog.error("reconcile.conversation_failed", { error });
    }
  }
  return { checked: conversations.length, failed };
}

async function forwardPending(
  deps: ConversationDeps,
  conversation: Conversation,
  log: Logger,
): Promise<void> {
  const pending = await pendingForwards(deps.db, conversation.id, RECONCILE_AFTER_SECONDS);
  if (pending.length === 0) return;
  const sessionId = await ensureSession(deps, conversation, log);
  for (const message of pending) {
    await deps.runtime.sendMessage(sessionId, formatForAgent(message.actorId, message.text));
    await markForwarded(deps.db, message.id);
    log.info("reconcile.message_forwarded", { inboundId: message.id, sessionId });
  }
  await markWaiting(deps.db, conversation.id);
}

async function giveUpIfTooLong(
  deps: ConversationDeps,
  conversation: Conversation,
  log: Logger,
): Promise<void> {
  if (conversation.status !== "waiting" || conversation.waitingSince === null) return;
  const waitedMs = (await databaseNow(deps.db)).getTime() - conversation.waitingSince.getTime();
  if (waitedMs < GIVE_UP_AFTER_MINUTES * 60_000) return;

  const sessionId = sessionIdOf(conversation);
  if (sessionId !== undefined) await deps.runtime.interrupt(sessionId);
  const key = `timeout:${conversation.waitingSince.toISOString()}`;
  await deliverOnce(deps, conversation, key, "failure", log, {
    kind: "reply",
    target: targetOf(conversation),
    text: failureNotes.timeout,
  });
  await settle(deps, conversation, "failed", await databaseNow(deps.db), key, log);
  log.warn("reconcile.gave_up", { waitedMinutes: Math.round(waitedMs / 60_000) });
}
