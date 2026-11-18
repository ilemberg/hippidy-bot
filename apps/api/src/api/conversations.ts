import type {
  Deliverer,
  DeliveryTarget,
  InboundMessage,
  MessageSource,
  OutboundDelivery,
  StopRequest,
  StopResult,
} from "@hippidy/contracts";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { Logger } from "../log.ts";
import {
  attachSession,
  claimSessionStart,
  claimSyncLease,
  conversationsToReconcile,
  databaseNow,
  enqueueDelivery,
  findConversationByKey,
  findConversationByMessage,
  findOrCreateConversation,
  getConversation,
  isStillPending,
  markDeliveryFailed,
  markDeliverySent,
  markForwarded,
  markWaiting,
  pendingForwards,
  pendingMessageCount,
  recordForwardFailure,
  recordInbound,
  releaseSessionStart,
  releaseSyncLease,
  renewSyncLease,
  sessionIdOf,
  setAgentEventCursor,
  setSessionState,
  settleMessages,
  unsentDeliveries,
  type Conversation,
  type DeliveryKind,
  type SessionState,
  type Settlement,
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
/** Failed hand-overs to the agent before a message is reported as failed. */
export const MAX_FORWARD_ATTEMPTS = 5;
const SESSION_START_WAIT_MS = 300;
const SESSION_START_ATTEMPTS = 40;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Short Markdown notes posted when something ends without an answer. */
export const notes = {
  budget_reached:
    "I've reached this conversation's spending limit, so I've stopped here. Start a new thread to carry on.",
  retries_exhausted:
    "Something went wrong on my side and I couldn't finish. Please try again in a new message.",
  refusal: "I can't help with that one.",
  requires_action: "I got stuck waiting for something I can't do yet. Please try again.",
  terminated: "This conversation's session has ended. Start a new thread to carry on.",
  timeout:
    "I took too long on this one and stopped. Please try again, perhaps with a narrower ask.",
  closed_budget:
    "This thread has reached its spending limit, so I can't answer here any more. Start a new thread and mention me there.",
  closed_terminated:
    "This thread's session has ended, so I can't answer here any more. Start a new thread and mention me there.",
  undeliverable:
    "I couldn't pass your message on to the agent, even after several tries. Please try again later.",
  stopped: "Stopped. Mention me again when you want to carry on.",
  nothing_to_stop: "There's nothing running in this thread to stop.",
} as const;

export interface ReceiveResult {
  id: string;
  duplicate: boolean;
}

/**
 * Handles one inbound message: record it once, make sure the thread has an agent session, and
 * hand the message to it. Returns once the agent has the message; the answer arrives later
 * through the webhook or reconcile (decision 13). If the thread can take no more messages, the
 * message is answered with a note instead (posted by the next reconcile, after 👀 is added).
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

  if (conversation.sessionState !== "active") {
    await refuseClosed(deps, conversation, [recorded.id], log);
    return { id: recorded.id, duplicate: recorded.duplicate };
  }

  try {
    const sessionId = await ensureSession(deps, conversation, log);
    if (!(await isStillPending(deps.db, recorded.id))) {
      log.info("conversation.stopped_before_send", { inboundId: recorded.id });
      return { id: recorded.id, duplicate: recorded.duplicate };
    }
    const agentEventId = await deps.runtime.sendMessage(
      sessionId,
      formatForAgent(message.actor.id, message.text, message.actor.displayName),
    );
    await markForwarded(deps.db, recorded.id, agentEventId);
    await markWaiting(deps.db, conversation.id);
    log.info("conversation.message_forwarded", {
      conversationId: conversation.id,
      sessionId,
      inboundId: recorded.id,
    });
  } catch (error) {
    // Reconcile hands it over later, and reports it as failed after several tries.
    await recordForwardFailure(deps.db, recorded.id);
    throw error;
  }
  return { id: recorded.id, duplicate: recorded.duplicate };
}

/** The text the agent sees: who sent it (by name when known), then what they wrote. */
export function formatForAgent(actorId: string, text: string, displayName?: string): string {
  const body = text.trim() === "" ? "(no text, just a mention)" : text;
  const sender =
    displayName === undefined ? `Slack user ${actorId}` : `${displayName} (Slack user ${actorId})`;
  return `From: ${sender}\n\n${body}`;
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
    const claim = await claimSessionStart(deps.db, conversation.id);
    if (claim !== undefined) {
      let session;
      try {
        session = await deps.runtime.startSession({
          title: `${conversation.key.source} ${conversation.key.channelId} ${conversation.key.threadId}`,
          metadata: {
            conversation_id: conversation.id,
            source: conversation.key.source,
            workspace_id: conversation.key.workspaceId,
            channel_id: conversation.key.channelId,
            thread_id: conversation.key.threadId,
          },
        });
      } catch (error) {
        await releaseSessionStart(deps.db, conversation.id, claim);
        throw error;
      }
      if (await attachSession(deps.db, conversation.id, claim, session)) {
        log.info("conversation.session_started", {
          conversationId: conversation.id,
          sessionId: session.sessionId,
          agentVersion: session.agentVersion,
        });
        return session.sessionId;
      }
      log.warn("conversation.session_start_superseded", { sessionId: session.sessionId });
    }
    // Another request is starting the session for this thread: wait for it.
    const started = sessionIdOf(await getConversation(deps.db, conversation.id));
    if (started !== undefined) return started;
    await sleep(SESSION_START_WAIT_MS);
  }
  throw new Error("timed out waiting for another request to start this thread's session");
}

/**
 * The right to sync one conversation, held by one sync at a time. It runs out
 * SYNC_LEASE_SECONDS after it was last extended, and another sync may then take the
 * conversation over (decision 92).
 */
interface HeldLease {
  /**
   * Extends the lease for another full term. False once it ran out and another sync took the
   * conversation over: that sync now does the work, and this one must send nothing more.
   * Called before every step that cannot be taken back (a message to the agent, a delivery).
   */
  extend(): Promise<boolean>;
  /** Gives the lease back, if it is still ours; never frees a lease taken over since. */
  release(): Promise<void>;
}

/** Takes a conversation's sync lease; undefined if another sync holds it. */
async function takeSyncLease(
  deps: ConversationDeps,
  conversationId: string,
  log: Logger,
): Promise<HeldLease | undefined> {
  let lease = await claimSyncLease(deps.db, conversationId);
  if (lease === undefined) return undefined;
  return {
    extend: async () => {
      if (lease === undefined) return false;
      lease = await renewSyncLease(deps.db, lease);
      if (lease === undefined) log.warn("conversation.sync_lease_lost", { conversationId });
      return lease !== undefined;
    },
    release: async () => {
      if (lease !== undefined) await releaseSyncLease(deps.db, lease);
    },
  };
}

/**
 * Brings a conversation up to date with its agent session: queues every new agent message for
 * delivery, settles the messages the agent has finished with, then sends whatever is queued,
 * in order. Only one sync of a conversation runs at a time; a sync that finds another running
 * leaves the work to it (reconcile picks up anything left over). So does a sync that took so
 * long that another has taken the conversation over.
 */
export async function syncConversation(
  deps: ConversationDeps,
  conversation: Conversation,
  log: Logger,
): Promise<void> {
  const lease = await takeSyncLease(deps, conversation.id, log);
  if (lease === undefined) {
    log.info("conversation.sync_skipped", { conversationId: conversation.id, reason: "busy" });
    return;
  }
  try {
    const current = await getConversation(deps.db, conversation.id);
    await forwardPending(deps, current, log, lease);
    // Handing messages over can take long: go on only if the conversation is still ours.
    if (!(await lease.extend())) return;
    await readAgent(deps, await getConversation(deps.db, conversation.id), log);
    await giveUpIfTooLong(deps, await getConversation(deps.db, conversation.id), log);
    await flushDeliveries(deps, conversation.id, log, lease);
  } finally {
    await lease.release();
  }
}

/** Queues the agent's new messages and settles what the agent has finished with. */
async function readAgent(
  deps: ConversationDeps,
  conversation: Conversation,
  log: Logger,
): Promise<void> {
  const sessionId = sessionIdOf(conversation);
  if (sessionId === undefined) return;
  // Taken before the session is read: only messages handed over before it can be settled
  // by the fallback rule for messages without a recorded agent event id.
  const cutoff = await databaseNow(deps.db);
  const events = await deps.runtime.listEvents(sessionId);

  const cursorIndex =
    conversation.agentEventCursor === null
      ? -1
      : events.findIndex((event) => event.id === conversation.agentEventCursor);
  for (const event of events.slice(cursorIndex + 1)) {
    if (event.kind === "agent_message") {
      await enqueueDelivery(deps.db, conversation.id, event.id, "reply", {
        kind: "reply",
        target: targetOf(conversation),
        text: event.text,
      });
    }
  }
  const lastProcessed = [...events]
    .reverse()
    .find((event) => event.kind !== "user_message" || event.processed);
  if (lastProcessed !== undefined) {
    await setAgentEventCursor(deps.db, conversation.id, lastProcessed.id);
  }

  const stateIndex = events.findLastIndex(
    (event) => event.kind === "idle" || event.kind === "terminated",
  );
  const state = events[stateIndex];
  if (state === undefined || (state.kind !== "idle" && state.kind !== "terminated")) return;

  const processedBefore = events
    .slice(0, stateIndex)
    .flatMap((event) => (event.kind === "user_message" && event.processed ? [event.id] : []));
  const anyQueued = events.some((event) => event.kind === "user_message" && !event.processed);
  const ending = state.kind === "terminated" ? "terminated" : state.reason;

  if (ending === "budget_reached" || ending === "terminated") {
    // The session takes no more messages: everything handed to it is finished, unanswered.
    const sessionState: SessionState = ending === "terminated" ? "terminated" : "budget_reached";
    if (conversation.sessionState !== sessionState) {
      await setSessionState(deps.db, conversation.id, sessionState);
    }
    await settleAndQueue(deps, conversation, "failed", { kind: "all_forwarded" }, log, {
      key: state.id,
      note: notes[ending],
    });
    return;
  }

  const status: SettledStatus = ending === "end_turn" ? "answered" : "failed";
  const note = ending === "end_turn" ? undefined : notes[ending];
  await settleAndQueue(
    deps,
    conversation,
    status,
    { kind: "agent_events", ids: processedBefore },
    log,
    {
      key: state.id,
      note,
    },
  );
  if (!anyQueued) {
    // Messages sent without an event id (the runtime did not report one): settled once the
    // session has nothing queued and is idle after they were handed over.
    await settleAndQueue(
      deps,
      conversation,
      status,
      { kind: "forwarded_without_event", cutoff },
      log,
      { key: `${state.id}:untracked`, note },
    );
  }
}

/**
 * Settles the selected messages and queues what tells the user: an optional note in the
 * thread, then the status of each settled message.
 */
async function settleAndQueue(
  deps: ConversationDeps,
  conversation: Conversation,
  status: SettledStatus,
  settlement: Settlement,
  log: Logger,
  options: { key: string; note: string | undefined },
): Promise<void> {
  if (settlement.kind === "agent_events" && settlement.ids.length === 0) return;
  const messageIds = await settleMessages(deps.db, conversation.id, status, settlement);
  if (messageIds.length === 0) return;
  log.info("conversation.settled", { conversationId: conversation.id, status, messageIds });
  const target = targetOf(conversation);
  if (options.note !== undefined) {
    await queue(deps, conversation, `note:${options.key}`, "note", {
      kind: "reply",
      target,
      text: options.note,
    });
  }
  await queue(deps, conversation, `status:${options.key}:${messageIds.join(",")}`, "status", {
    kind: "status",
    target,
    messageIds,
    status,
  });
}

function queue(
  deps: ConversationDeps,
  conversation: Conversation,
  key: string,
  kind: DeliveryKind,
  delivery: OutboundDelivery,
): Promise<void> {
  return enqueueDelivery(deps.db, conversation.id, key, kind, delivery);
}

/** Answers messages in a thread whose session can take no more, with a note and ❌. */
async function refuseClosed(
  deps: ConversationDeps,
  conversation: Conversation,
  inboundIds: string[],
  log: Logger,
): Promise<void> {
  const note =
    conversation.sessionState === "terminated" ? notes.closed_terminated : notes.closed_budget;
  await settleAndQueue(deps, conversation, "failed", { kind: "inbound", ids: inboundIds }, log, {
    key: `closed:${inboundIds.join(",")}`,
    note,
  });
  log.info("conversation.closed_thread", { conversationId: conversation.id, inboundIds });
}

/**
 * Sends the conversation's queued deliveries in order. Stops at the first failure so replies
 * never arrive out of order; the failed one is retried by the next sync or reconcile. A
 * delivery that keeps failing is abandoned and logged as an error, and the rest go on. Stops
 * too if the lease is lost: the sync that took over sends the rest.
 */
async function flushDeliveries(
  deps: ConversationDeps,
  conversationId: string,
  log: Logger,
  lease: HeldLease,
): Promise<void> {
  for (const delivery of await unsentDeliveries(deps.db, conversationId)) {
    if (!(await lease.extend())) return;
    const deliverer = deps.deliverers[delivery.payload.target.source];
    try {
      if (deliverer === undefined) {
        throw new Error(`no deliverer registered for source "${delivery.payload.target.source}"`);
      }
      await deliverer.deliver(delivery.payload, conversationId);
      await markDeliverySent(deps.db, delivery.id);
      log.info("conversation.delivered", { conversationId, key: delivery.key });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const abandoned = await markDeliveryFailed(deps.db, delivery.id, message);
      if (abandoned) {
        log.error("conversation.delivery_abandoned", { conversationId, key: delivery.key, error });
        continue;
      }
      log.error("conversation.delivery_failed", {
        conversationId,
        key: delivery.key,
        attempt: delivery.attempts + 1,
        error,
      });
      return;
    }
  }
}

function targetOf(conversation: Conversation): DeliveryTarget {
  return { ...conversation.key };
}

/** Hands over messages that never reached the agent; reports them failed after several tries. */
async function forwardPending(
  deps: ConversationDeps,
  conversation: Conversation,
  log: Logger,
  lease: HeldLease,
): Promise<void> {
  const pending = await pendingForwards(deps.db, conversation.id, RECONCILE_AFTER_SECONDS);
  if (pending.length === 0) return;
  if (conversation.sessionState !== "active") {
    await refuseClosed(
      deps,
      conversation,
      pending.map((message) => message.id),
      log,
    );
    return;
  }
  for (const message of pending) {
    if (!(await lease.extend())) return;
    try {
      const sessionId = await ensureSession(deps, conversation, log);
      const agentEventId = await deps.runtime.sendMessage(
        sessionId,
        formatForAgent(message.actorId, message.text, message.actorName),
      );
      await markForwarded(deps.db, message.id, agentEventId);
      await markWaiting(deps.db, conversation.id);
      log.info("reconcile.message_forwarded", { inboundId: message.id, sessionId });
    } catch (error) {
      const attempts = await recordForwardFailure(deps.db, message.id);
      log.error("reconcile.forward_failed", { inboundId: message.id, attempts, error });
      if (attempts >= MAX_FORWARD_ATTEMPTS) {
        await settleAndQueue(
          deps,
          conversation,
          "failed",
          { kind: "inbound", ids: [message.id] },
          log,
          {
            key: `undeliverable:${message.id}`,
            note: notes.undeliverable,
          },
        );
      }
      return; // keep the order: later messages wait for this one
    }
  }
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
  await settleAndQueue(deps, conversation, "failed", { kind: "all_forwarded" }, log, {
    key: `timeout:${conversation.waitingSince.toISOString()}`,
    note: notes.timeout,
  });
  log.warn("reconcile.gave_up", { waitedMinutes: Math.round(waitedMs / 60_000) });
}

/**
 * Stops the agent in a conversation (decision 60): interrupts the session if it is working,
 * marks every pending message stopped (🛑), and says so in the thread. The stop message
 * itself, when there is one, is marked stopped too. Sends the result straight away; the
 * source adds no 👀 to a stop.
 */
export async function stopConversation(
  deps: ConversationDeps,
  request: StopRequest,
  log: Logger,
): Promise<StopResult> {
  const viaMessage = request.stopMessage !== undefined;
  let conversation =
    request.threadId !== undefined
      ? await findConversationByKey(deps.db, {
          source: request.source,
          workspaceId: request.workspaceId,
          channelId: request.channelId,
          threadId: request.threadId,
        })
      : request.messageId !== undefined
        ? await findConversationByMessage(deps.db, {
            source: request.source,
            workspaceId: request.workspaceId,
            channelId: request.channelId,
            messageId: request.messageId,
          })
        : undefined;
  if (conversation === undefined) {
    // A stop message starting a thread still deserves an answer; a reaction on a message the
    // API never saw (another bot's, say) is ignored.
    if (!viaMessage || request.threadId === undefined) {
      log.info("conversation.stop_unknown", { channelId: request.channelId });
      return { status: "unknown_conversation" };
    }
    conversation = await findOrCreateConversation(deps.db, {
      source: request.source,
      workspaceId: request.workspaceId,
      channelId: request.channelId,
      threadId: request.threadId,
    });
  }

  // Taken before the stop message is recorded: is anything waiting for the agent?
  const working = (await pendingMessageCount(deps.db, conversation.id)) > 0;
  const key = `stop:${request.sourceEventId}`;

  // The stop message is settled first, so it can never be handed to the agent as a question,
  // even if what follows fails.
  if (request.stopMessage !== undefined) {
    const recorded = await recordInbound(deps.db, conversation.id, {
      source: request.source,
      sourceEventId: request.sourceEventId,
      conversation: {
        workspaceId: request.workspaceId,
        channelId: request.channelId,
        threadId: conversation.key.threadId,
        messageId: request.stopMessage.messageId,
      },
      actor: request.actor,
      text: "stop",
      sentAt: request.stopMessage.sentAt,
    });
    await settleAndQueue(
      deps,
      conversation,
      "stopped",
      { kind: "inbound", ids: [recorded.id] },
      log,
      {
        key: `${key}:message`,
        note: undefined,
      },
    );
  }

  if (working) {
    const sessionId = sessionIdOf(conversation);
    if (sessionId !== undefined) await deps.runtime.interrupt(sessionId);
    // Every pending message, including any not yet handed over (those are never sent now).
    await settleAndQueue(deps, conversation, "stopped", { kind: "all_pending" }, log, {
      key,
      note: notes.stopped,
    });
  } else if (viaMessage) {
    await queue(deps, conversation, `note:${key}`, "note", {
      kind: "reply",
      target: targetOf(conversation),
      text: notes.nothing_to_stop,
    });
  }
  // A 🛑 on a finished thread does nothing: no note for every stray reaction.

  await flushSoon(deps, conversation.id, log);
  log.info("conversation.stopped", { conversationId: conversation.id, working });
  return { status: working ? "stopped" : "nothing_to_stop" };
}

/**
 * Sends queued deliveries now, waiting briefly if a sync holds the conversation; if it is
 * still busy after that, the running sync or the next reconcile sends them.
 */
async function flushSoon(deps: ConversationDeps, conversationId: string, log: Logger) {
  const sleep = deps.sleep ?? defaultSleep;
  for (let attempt = 0; attempt < 10; attempt++) {
    const lease = await takeSyncLease(deps, conversationId, log);
    if (lease !== undefined) {
      try {
        await flushDeliveries(deps, conversationId, log, lease);
      } finally {
        await lease.release();
      }
      return;
    }
    await sleep(300);
  }
  log.info("conversation.flush_deferred", { conversationId });
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
  for (const conversation of conversations) {
    const conversationLog = log.child({ conversationId: conversation.id });
    try {
      await syncConversation(deps, conversation, conversationLog);
    } catch (error) {
      failed++;
      conversationLog.error("reconcile.conversation_failed", { error });
    }
  }
  return { checked: conversations.length, failed };
}
