import type {
  ContextMessage,
  Deliverer,
  DeliveryTarget,
  InboundMessage,
  MessageSource,
  OutboundDelivery,
  Role,
  StopRequest,
  StopResult,
} from "@hippidy/contracts";
import {
  actedOn,
  type AgentEvent,
  type AgentEventRecord,
  type AgentRuntime,
} from "../agent/runtime.ts";
import type { PullRequestChecks } from "../github/checks.ts";
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
import { readSenderAndProject, type SenderAndProject } from "../store/projects.ts";
import { latestActivity, latestStoredEventTime, storedEventsToActOn } from "../store/record.ts";
import { progressDue, progressText } from "./progress.ts";
import { keepEvents, keepUsage } from "./record.ts";

export interface ConversationDeps {
  db: Db;
  runtime: AgentRuntime;
  /** One per source; registered in compose.ts (decision 53). */
  deliverers: Partial<Record<MessageSource, Deliverer>>;
  /** Waits between checks for a session another request is starting. Replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Reads a pull request's CI checks, for ✅ on a change (decision 132). Without it, a turn
   * that pushed or opened a pull request cannot be called done.
   */
  checks?: PullRequestChecks;
}

/** How long a message may wait for the agent before reconcile looks at it. */
export const RECONCILE_AFTER_SECONDS = 60;
/**
 * After this long with no new event from the session, a turn is taken to be stuck: it is
 * stopped and reported as failed (decision 113). A long turn that keeps working is not.
 */
export const GIVE_UP_AFTER_MINUTES = 30;
/** Sent with each denial of a tool call that waited for approval (decision 119). */
export const DENY_MESSAGE =
  "Tool calls cannot be approved in this conversation. Carry on without this one, or explain what you need in your answer.";
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
  // Not reached since decision 119 (a waiting call is denied and the turn carries on); kept so
  // every way a turn can stop has a note.
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
  no_pull_request:
    "I pushed a branch but didn't open a pull request, so this isn't done. Reply here if you want me to carry on.",
  nothing_to_stop: "There's nothing running in this thread to stop.",
} as const;

/** Notes for a change whose pull request is not done (decision 132). */
export const changeNotes = {
  failed: (url: string, names: readonly string[]) =>
    `CI failed on ${url} (${names.join(", ")}), so this isn't done yet. Reply here if you want me to fix it.`,
  pending: (url: string) =>
    `CI was still running on ${url} when I stopped, so I can't call this done yet. Check it there.`,
  not_checked: (url: string) =>
    `I couldn't check CI on ${url}, so I can't call this done. Check it there.`,
};

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
    // Outside any sync lease: receiving a message never holds one.
    const about = await senderAndProject(deps, conversation.id, message.actor.id, log);
    const agentEventId = await deps.runtime.sendMessage(
      sessionId,
      formatForAgent(
        message.actor.id,
        message.text,
        message.actor.displayName,
        message.context,
        about,
      ),
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

/** The line that introduces what was said in the conversation since the agent's last reply. */
export const CONTEXT_LEAD = "Said in the thread since your last reply:";

/** A role as the agent reads it in the `From:` line. */
export const roleInWords: Record<Role, string> = {
  engineering_manager: "engineering manager",
  product_manager: "product manager",
  tech_lead: "tech lead",
  engineer: "engineer",
  qa: "QA",
  designer: "designer",
};

/** Text on one line: every kind of line break becomes a space, so it cannot start a line. */
const oneLine = (text: string) => text.replace(/\r\n|[\r\n\u2028\u2029\u0085]/g, " ");

/**
 * The text the agent sees: what was said in the thread since its last reply, when the source
 * sent any (decision 140), then who sent this message (by name when known, with their role
 * when they hold one), the thread's project and stage when it has one, and what they wrote
 * (slice 5A, part D). Without context, role or project it is exactly the sender and the
 * message.
 */
export function formatForAgent(
  actorId: string,
  text: string,
  displayName?: string,
  context: readonly ContextMessage[] = [],
  about: Partial<SenderAndProject> = {},
): string {
  const body = text.trim() === "" ? "(no text, just a mention)" : text;
  const name =
    displayName === undefined ? `Slack user ${actorId}` : `${displayName} (Slack user ${actorId})`;
  const sender = about.role === undefined ? name : `${name}, ${roleInWords[about.role]}`;
  const project =
    about.project === undefined
      ? ""
      : `\nProject: ${oneLine(about.project.name)} (stage: ${about.project.stage})`;
  const message = `From: ${sender}${project}\n\n${body}`;
  if (context.length === 0) return message;
  const lines = context.map((said) => {
    const time = new Date(said.sentAt).toISOString().slice(11, 16);
    // Lines after the first are indented, so a message of several lines stays one item.
    // Every kind of line break counts, so no message can start a line of its own and pose as
    // the lead line or a `From:` line.
    const words = said.text.replace(/\r\n|[\r\n\u2028\u2029\u0085]/g, "\n  ");
    return `- ${said.actorName ?? said.actorId} (${time} UTC): ${words}`;
  });
  return `${CONTEXT_LEAD}\n${lines.join("\n")}\n\n${message}`;
}

/**
 * The sender's role and the thread's project, for the lines the agent reads. Optional: if the
 * lookup fails, it is logged and the message goes without them, as before part D.
 */
async function senderAndProject(
  deps: ConversationDeps,
  conversationId: string,
  actorId: string,
  log: Logger,
): Promise<SenderAndProject> {
  try {
    return await readSenderAndProject(deps.db, conversationId, actorId);
  } catch (error) {
    log.warn("conversation.sender_lookup_failed", { conversationId, error });
    return { role: undefined, project: undefined };
  }
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
 * Brings a conversation up to date with its agent session: queues every new agent message for
 * delivery, settles the messages the agent has finished with, then sends whatever is queued,
 * in order. Only one sync of a conversation runs at a time; a sync that finds another running
 * leaves the work to it (reconcile picks up anything left over).
 *
 * Along the way it keeps the record: every event the session lists, and its usage so far.
 */
export async function syncConversation(
  deps: ConversationDeps,
  conversation: Conversation,
  log: Logger,
): Promise<void> {
  const lease = await claimSyncLease(deps.db, conversation.id);
  if (lease === undefined) {
    log.info("conversation.sync_skipped", { conversationId: conversation.id, reason: "busy" });
    return;
  }
  let sessionId: string | undefined;
  try {
    const current = await getConversation(deps.db, conversation.id);
    await forwardPending(deps, current, log);
    const forwarded = await getConversation(deps.db, conversation.id);
    const lastEventAt = await readAgent(deps, forwarded, log);
    // A sync slow enough to lose its lease stops here: another sync has the conversation now.
    if (!(await renewSyncLease(deps.db, lease))) {
      log.warn("conversation.sync_lease_lost", { conversationId: conversation.id });
      return;
    }
    await giveUpIfStuck(deps, await getConversation(deps.db, conversation.id), lastEventAt, log);
    await flushDeliveries(deps, conversation.id, log);
    sessionId = sessionIdOf(forwarded);
  } finally {
    await releaseSyncLease(deps.db, lease);
  }
  // After the conversation is free again: a slow usage read must not hold up the next sync,
  // a stop, or this answer. Late or overlapping readings are safe (usage only grows).
  if (sessionId !== undefined) await keepUsage(deps, conversation.id, sessionId, log);
}

/**
 * Queues the last message of each turn that has ended, answers tool calls waiting for
 * approval, and settles what the agent has finished with. Returns when the session's latest
 * event happened, if it has any.
 */
async function readAgent(
  deps: ConversationDeps,
  conversation: Conversation,
  log: Logger,
): Promise<Date | undefined> {
  const sessionId = sessionIdOf(conversation);
  if (sessionId === undefined) return undefined;
  // Taken before the session is read: only messages handed over before it can be settled
  // by the fallback rule for messages without a recorded agent event id.
  const cutoff = await databaseNow(deps.db);
  const records = await readSessionEvents(deps, conversation.id, sessionId, log);
  const events = actedOn(records);
  const lastEventAt = latestTime(records);

  const cursorIndex =
    conversation.agentEventCursor === null
      ? -1
      : events.findIndex((event) => event.id === conversation.agentEventCursor);
  // Decision 114: nothing the agent writes is posted while its turn runs. When a turn ends,
  // its last message is posted; the rest stay in the record.
  let turnStart = -1;
  for (const [index, event] of events.entries()) {
    if (!endsTurn(event)) continue;
    if (index > cursorIndex) {
      const last = events
        .slice(turnStart + 1, index)
        .findLast((candidate) => candidate.kind === "agent_message");
      if (last?.kind === "agent_message") {
        await enqueueDelivery(deps.db, conversation.id, last.id, "reply", {
          kind: "reply",
          target: targetOf(conversation),
          text: last.text,
        });
      }
    }
    turnStart = index;
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
  if (state === undefined || (state.kind !== "idle" && state.kind !== "terminated")) {
    return lastEventAt;
  }
  if (state.kind === "idle" && state.reason === "requires_action") {
    // The turn is not over: a tool call waits for approval, which the loop cannot give.
    await denyWaitingCalls(deps, sessionId, events, state.blockedOn ?? [], log);
    return lastEventAt;
  }

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
    return lastEventAt;
  }

  const { status, note } =
    ending === "end_turn"
      ? await judgeTurn(deps, conversation.id, events, stateIndex, log)
      : { status: "failed" as const, note: notes[ending] };
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
  return lastEventAt;
}

/**
 * The session's events, oldest first (decision 95). Only those since the latest one in the
 * record are asked of the runtime, and stored; the earlier ones the loop acts on are read back
 * from the record. If storing fails, the next sync starts further back and catches up, so the
 * loop never depends on the record having been written.
 */
async function readSessionEvents(
  deps: ConversationDeps,
  conversationId: string,
  sessionId: string,
  log: Logger,
): Promise<AgentEventRecord[]> {
  const since = await latestStoredEventTime(deps.db, conversationId, sessionId);
  const fresh = await deps.runtime.listEvents(
    sessionId,
    since === undefined ? undefined : { since: since.toISOString() },
  );
  // Everything the session lists goes into the record; the loop acts on the few it knows.
  await keepEvents(deps.db, conversationId, sessionId, fresh, log);
  if (since === undefined) return fresh;
  const stored = (await storedEventsToActOn(deps.db, conversationId, sessionId)).flatMap(
    (payload) => {
      const record = deps.runtime.readStoredEvent(payload);
      return record === undefined ? [] : [record];
    },
  );
  return mergeEvents(stored, fresh);
}

/**
 * One list from the record and a fresh listing: each event once, as most recently reported,
 * in processing order with queued messages last. Ties keep their order (stored first).
 */
export function mergeEvents(
  stored: readonly AgentEventRecord[],
  fresh: readonly AgentEventRecord[],
): AgentEventRecord[] {
  const latest = new Map<string, AgentEventRecord>();
  for (const record of [...stored, ...fresh]) latest.set(record.id, record);
  const order = new Map([...stored, ...fresh].map((record, index) => [record.id, index]));
  const time = (record: AgentEventRecord) =>
    record.processedAt === null ? Number.POSITIVE_INFINITY : Date.parse(record.processedAt);
  return [...latest.values()].sort(
    (a, b) => time(a) - time(b) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );
}

/**
 * Whether a turn that ended normally did what it was asked (decision 132). A turn that pushed
 * or opened a pull request is done only when that pull request's CI checks have all passed;
 * any other turn is done when it ends. GitHub is asked only while messages wait for a status.
 */
async function judgeTurn(
  deps: ConversationDeps,
  conversationId: string,
  events: readonly AgentEvent[],
  endIndex: number,
  log: Logger,
): Promise<{ status: SettledStatus; note: string | undefined }> {
  const done: { status: SettledStatus; note: string | undefined } = {
    status: "answered",
    note: undefined,
  };
  const before = events.slice(0, endIndex);
  const turn = before.slice(before.findLastIndex(endsTurn) + 1);
  if (!turn.some((event) => event.kind === "pushed" || event.kind === "pull_request")) return done;
  if ((await pendingMessageCount(deps.db, conversationId)) === 0) return done;

  const pullRequest = before.findLast((event) => event.kind === "pull_request");
  if (pullRequest?.kind !== "pull_request") {
    return { status: "failed", note: notes.no_pull_request };
  }
  const verdict =
    deps.checks === undefined
      ? { kind: "not_checked" as const, reason: "no GitHub token" }
      : await deps.checks.verdict(pullRequest.url);
  log.info("conversation.checks_read", { conversationId, url: pullRequest.url, verdict });
  switch (verdict.kind) {
    case "passed":
      return done;
    case "failed":
      return { status: "failed", note: changeNotes.failed(pullRequest.url, verdict.names) };
    case "pending":
      return { status: "failed", note: changeNotes.pending(pullRequest.url) };
    case "not_checked":
      return { status: "failed", note: changeNotes.not_checked(pullRequest.url) };
  }
}

/** Whether an event ends a turn. Waiting for a tool call's approval does not (decision 119). */
function endsTurn(event: AgentEvent): boolean {
  return (
    event.kind === "terminated" || (event.kind === "idle" && event.reason !== "requires_action")
  );
}

/** When the latest of the events was processed, by the runtime's clock. */
function latestTime(records: readonly AgentEventRecord[]): Date | undefined {
  let latest: number | undefined;
  for (const record of records) {
    if (record.processedAt === null) continue;
    const time = Date.parse(record.processedAt);
    if (!Number.isNaN(time) && (latest === undefined || time > latest)) latest = time;
  }
  return latest === undefined ? undefined : new Date(latest);
}

/** Denies each blocked tool call not answered yet, so the session carries on (decision 119). */
async function denyWaitingCalls(
  deps: ConversationDeps,
  sessionId: string,
  events: readonly AgentEvent[],
  blockedOn: readonly string[],
  log: Logger,
): Promise<void> {
  const answered = new Set(
    events.flatMap((event) => (event.kind === "tool_confirmation" ? [event.toolUseId] : [])),
  );
  const waiting = blockedOn.filter((id) => !answered.has(id));
  if (waiting.length === 0) return;
  await deps.runtime.denyToolCalls(sessionId, waiting, DENY_MESSAGE);
  log.warn("conversation.tool_calls_denied", { sessionId, toolUseIds: waiting });
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
 * delivery that keeps failing is abandoned and logged as an error, and the rest go on.
 */
async function flushDeliveries(
  deps: ConversationDeps,
  conversationId: string,
  log: Logger,
): Promise<void> {
  for (const delivery of await unsentDeliveries(deps.db, conversationId)) {
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
    try {
      const sessionId = await ensureSession(deps, conversation, log);
      // Without the thread's context: it is not stored (the session's events record what was
      // sent), so a message handed over late goes as it would have before decision 140. The
      // role and project are read again: this runs under the sync lease, but it is one query
      // of primary-key lookups, next to the agent call the lease already covers.
      const about = await senderAndProject(deps, conversation.id, message.actorId, log);
      const agentEventId = await deps.runtime.sendMessage(
        sessionId,
        formatForAgent(message.actorId, message.text, message.actorName, [], about),
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

/**
 * Stops a turn that has gone quiet: nothing new from the session for GIVE_UP_AFTER_MINUTES
 * since the message was handed over or since its latest event, whichever is later.
 */
async function giveUpIfStuck(
  deps: ConversationDeps,
  conversation: Conversation,
  lastEventAt: Date | undefined,
  log: Logger,
): Promise<void> {
  if (conversation.status !== "waiting" || conversation.waitingSince === null) return;
  const quietSince = Math.max(conversation.waitingSince.getTime(), lastEventAt?.getTime() ?? 0);
  const now = (await databaseNow(deps.db)).getTime();
  const quietMs = now - quietSince;
  if (quietMs < GIVE_UP_AFTER_MINUTES * 60_000) return;
  const waitedMs = now - conversation.waitingSince.getTime();

  const sessionId = sessionIdOf(conversation);
  if (sessionId !== undefined) await deps.runtime.interrupt(sessionId);
  await settleAndQueue(deps, conversation, "failed", { kind: "all_forwarded" }, log, {
    key: `timeout:${conversation.waitingSince.toISOString()}`,
    note: notes.timeout,
  });
  log.warn("reconcile.gave_up", {
    waitedMinutes: Math.round(waitedMs / 60_000),
    quietMinutes: Math.round(quietMs / 60_000),
  });
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
    const lease = await claimSyncLease(deps.db, conversationId);
    if (lease !== undefined) {
      try {
        await flushDeliveries(deps, conversationId, log);
      } finally {
        await releaseSyncLease(deps.db, lease);
      }
      return;
    }
    await sleep(300);
  }
  log.info("conversation.flush_deferred", { conversationId });
}

/**
 * Posts a progress note when a turn has run long (decisions 103, 106): the latest one due on
 * the schedule, once, built from the record. Called by reconcile outside the sync lease.
 */
export async function postProgress(
  deps: ConversationDeps,
  conversation: Conversation,
  log: Logger,
): Promise<void> {
  const sessionId = sessionIdOf(conversation);
  if (conversation.status !== "waiting" || conversation.waitingSince === null) return;
  if (sessionId === undefined) return;
  const waitingSince = conversation.waitingSince;
  const elapsedMinutes = ((await databaseNow(deps.db)).getTime() - waitingSince.getTime()) / 60_000;
  const due = progressDue(elapsedMinutes);
  if (due === undefined) return;
  const activity = await latestActivity(deps.db, conversation.id, sessionId, waitingSince);
  await queue(
    deps,
    conversation,
    `progress:${waitingSince.toISOString()}:${String(due.number)}`,
    "note",
    { kind: "reply", target: targetOf(conversation), text: progressText(due.atMinutes, activity) },
  );
  await flushSoon(deps, conversation.id, log);
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
      // After the sync has let go of the conversation: a note must not hold up a stop or the
      // next webhook (decision 106).
      await postProgress(deps, await getConversation(deps.db, conversation.id), conversationLog);
    } catch (error) {
      failed++;
      conversationLog.error("reconcile.conversation_failed", { error });
    }
  }
  return { checked: conversations.length, failed };
}
