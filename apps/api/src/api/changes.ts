import { namePullRequestAreas } from "./areas.ts";
import type { StartBriefRequest, StartBriefResult } from "@hippidy/contracts";
import { actedOn, type AgentEvent } from "../agent/runtime.ts";
import type { Logger } from "../log.ts";
import {
  attachWorker,
  changesToReconcile,
  changesWithUnsentBriefs,
  claimChangeLease,
  claimWorkerStart,
  clearChangeWaiting,
  getChange,
  giveUpBrief,
  markBriefSent,
  markChangeWaiting,
  pendingChangeMessageCount,
  recordHandOverFailure,
  releaseChangeLease,
  releaseWorkerStart,
  renewChangeLease,
  setChangeCursor,
  setChangeSessionState,
  startBrief,
  unsentBriefs,
  workerSessionIdOf,
  type BriefToSend,
  type Change,
} from "../store/changes.ts";
import { databaseNow, getConversation, type Conversation } from "../store/conversations.ts";
import { latestActivity, recordUsage } from "../store/record.ts";
import {
  DENY_MESSAGE,
  endsTurn,
  flushSoon,
  GIVE_UP_AFTER_MINUTES,
  latestTime,
  notes,
  pullRequestVerdict,
  queue,
  readSessionEvents,
  RECONCILE_AFTER_SECONDS,
  settleAndQueue,
  targetOf,
  type ConversationDeps,
} from "./conversations.ts";
import { progressDue, progressText } from "./progress.ts";

// A change's coding worker (slice 2.1, decisions 181 and 184): a session of its own beside the
// thread's, told only its briefs. Its loop is the thread's loop in small: hand over what is
// started, post the last message of each turn, judge a turn that pushed by its pull request's
// CI, settle the messages that led to its briefs, give up on a turn gone quiet.

export const changeTexts = {
  started: (name: string) => `Started by ${name}. The coding worker has the brief now.`,
  stopped:
    "That change was stopped, so this brief can't be started. Mention me if it's still wanted.",
} as const;

/** The brief as the worker reads it: who asked, then the brief, in plain sections. */
export function formatBriefForWorker(change: Change, brief: BriefToSend): string {
  const who =
    change.requestedBy.name === null
      ? `${change.requestedBy.source} user ${change.requestedBy.actorId}`
      : `${oneLine(change.requestedBy.name)} (${change.requestedBy.source} user ${change.requestedBy.actorId})`;
  const lead = brief.followUp
    ? `An updated brief for the same change, asked for by ${who}.`
    : `Change asked for by ${who} in ${change.requestedBy.source === "slack" ? "Slack" : "the app"}.`;
  const links =
    brief.links.length === 0 ? "" : `\n\nLinks:\n${brief.links.map((l) => `- ${l}`).join("\n")}`;
  return (
    `${lead}\n\n# ${oneLine(brief.title)}\n\nWhat:\n${brief.what}\n\nWhy:\n${brief.why}` +
    `\n\nDone when:\n${brief.doneWhen}${links}`
  );
}

const oneLine = (text: string) => text.replace(/\r\n|[\r\n\u2028\u2029\u0085]/g, " ");

/**
 * Brings a change up to date with its worker: hands over the briefs that are started, reads the
 * worker's events, and settles what it has finished. One sync of a change at a time; the
 * thread's deliveries are sent after the change is let go.
 */
export async function syncChange(
  deps: ConversationDeps,
  change: Change,
  log: Logger,
): Promise<void> {
  const changeLog = log.child({ changeId: change.id });
  const lease = await claimChangeLease(deps.db, change.id);
  if (lease === undefined) {
    changeLog.info("change.sync_skipped", { reason: "busy" });
    return;
  }
  let sessionId: string | undefined;
  let conversation: Conversation | undefined;
  try {
    conversation = await getConversation(deps.db, change.conversationId);
    await handOverBriefs(deps, conversation, await getChange(deps.db, change.id), changeLog);
    const current = await getChange(deps.db, change.id);
    const lastEventAt = await readWorker(deps, conversation, current, changeLog);
    if (!(await renewChangeLease(deps.db, lease))) {
      changeLog.warn("change.sync_lease_lost", {});
      return;
    }
    await giveUpIfStuck(
      deps,
      conversation,
      await getChange(deps.db, change.id),
      lastEventAt,
      changeLog,
    );
    sessionId = workerSessionIdOf(current);
  } finally {
    await releaseChangeLease(deps.db, lease);
  }
  await flushSoon(deps, conversation.id, changeLog);
  if (sessionId !== undefined) {
    try {
      await recordUsage(deps.db, change.id, await deps.runtime.readUsage(sessionId), "changes");
    } catch (error) {
      changeLog.warn("record.usage_failed", { sessionId, error });
    }
  }
}

/** Starts the change's worker if it has none. Called by the holder of the change's lease. */
async function ensureWorker(deps: ConversationDeps, change: Change, log: Logger): Promise<string> {
  const existing = workerSessionIdOf(change);
  if (existing !== undefined) return existing;
  const claim = await claimWorkerStart(deps.db, change.id);
  if (claim === undefined) throw new Error("another request is starting this change's worker");
  let session;
  try {
    session = await deps.runtime.startSession({
      // The coding worker is slice 4's agent (decision 181).
      agentKind: "engineer",
      title: `change ${change.id}`,
      metadata: { conversation_id: change.conversationId, change_id: change.id },
    });
  } catch (error) {
    await releaseWorkerStart(deps.db, change.id, claim);
    throw error;
  }
  if (!(await attachWorker(deps.db, change.id, claim, session))) {
    throw new Error("this change's worker start was taken over");
  }
  log.info("change.worker_started", {
    sessionId: session.sessionId,
    agentVersion: session.agentVersion,
  });
  return session.sessionId;
}

/** Failed hand-overs of one brief before it is given up and answered with a note. */
export const MAX_HAND_OVER_ATTEMPTS = 5;

/**
 * Hands the change's started briefs to its worker, in order, each only once it has been posted
 * in the thread (rule 3). A worker that can take no more (budget reached, session ended) gets
 * nothing, and a brief that cannot be posted or handed over after several tries is given up;
 * either way the messages that led to it are answered with a note. The change's status is read
 * again before each send and after it, so a stop that lands meanwhile still stops the worker.
 */
async function handOverBriefs(
  deps: ConversationDeps,
  conversation: Conversation,
  change: Change,
  log: Logger,
): Promise<void> {
  for (const brief of await unsentBriefs(deps.db, change.id)) {
    const current = await getChange(deps.db, change.id);
    if (current.status !== "started") return;
    if (current.sessionState !== "active" || brief.posted === "abandoned") {
      await giveUp(deps, conversation, brief.id, log, {
        note:
          brief.posted === "abandoned"
            ? notes.undeliverable
            : current.sessionState === "terminated"
              ? notes.closed_terminated
              : notes.closed_budget,
      });
      continue;
    }
    // Not posted yet: it waits, and so do the briefs after it.
    if (brief.posted !== "sent") return;
    let sessionId: string;
    try {
      sessionId = await ensureWorker(deps, current, log);
      const eventId = await deps.runtime.sendMessage(
        sessionId,
        formatBriefForWorker(current, brief),
      );
      // Without an event id the brief is still sent once; its messages are then settled when
      // the worker is idle with nothing left to do (the `untracked_briefs` settlement).
      await markBriefSent(deps.db, brief.id, eventId ?? `untracked:${brief.id}`);
      await markChangeWaiting(deps.db, change.id);
      log.info("change.brief_handed_over", { briefId: brief.id, sessionId });
    } catch (error) {
      const attempts = await recordHandOverFailure(deps.db, brief.id);
      log.error("change.hand_over_failed", { briefId: brief.id, attempts, error });
      if (attempts >= MAX_HAND_OVER_ATTEMPTS) {
        await giveUp(deps, conversation, brief.id, log, { note: notes.undeliverable });
        continue;
      }
      return; // keep the order: later briefs wait for this one
    }
    // A stop that landed while this brief was on its way: the worker must not act on it.
    if ((await getChange(deps.db, change.id)).status === "stopped") {
      await deps.runtime.interrupt(sessionId);
      log.warn("change.stopped_during_hand_over", { briefId: brief.id, sessionId });
      return;
    }
  }
}

/** Gives a brief up and answers the messages that led to it with ❌ and a note. */
async function giveUp(
  deps: ConversationDeps,
  conversation: Conversation,
  briefId: string,
  log: Logger,
  options: { note: string },
): Promise<void> {
  await giveUpBrief(deps.db, briefId);
  await settleAndQueue(deps, conversation, "failed", { kind: "brief", briefId }, log, {
    key: `brief:${briefId}:given_up`,
    note: options.note,
  });
  log.warn("change.brief_given_up", { briefId });
}

/**
 * Reads the worker's events: queues the last message of each turn that has ended, denies any
 * tool call that waits (the worker has no tool the API answers), and settles the messages that
 * led to the briefs it has finished with. Returns when its latest event happened.
 */
async function readWorker(
  deps: ConversationDeps,
  conversation: Conversation,
  change: Change,
  log: Logger,
): Promise<Date | undefined> {
  const sessionId = workerSessionIdOf(change);
  if (sessionId === undefined) return undefined;
  const records = await readSessionEvents(deps, conversation.id, sessionId, log);
  const events = actedOn(records);
  const lastEventAt = latestTime(records);

  const cursorIndex =
    change.agentEventCursor === null
      ? -1
      : events.findIndex((event) => event.id === change.agentEventCursor);
  let turnStart = -1;
  for (const [index, event] of events.entries()) {
    if (!endsTurn(event)) continue;
    if (index > cursorIndex) {
      const last = events
        .slice(turnStart + 1, index)
        .findLast((candidate) => candidate.kind === "agent_message");
      if (last?.kind === "agent_message") {
        await queue(deps, conversation, last.id, "reply", {
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
  if (lastProcessed !== undefined) await setChangeCursor(deps.db, change.id, lastProcessed.id);

  const stateIndex = events.findLastIndex(
    (event) => event.kind === "idle" || event.kind === "terminated",
  );
  const state = events[stateIndex];
  if (state === undefined || (state.kind !== "idle" && state.kind !== "terminated")) {
    return lastEventAt;
  }
  if (state.kind === "idle" && state.reason === "requires_action") {
    await denyWaitingCalls(deps, sessionId, events, state.blockedOn ?? [], log);
    return lastEventAt;
  }

  const ending = state.kind === "terminated" ? "terminated" : state.reason;
  if (ending === "budget_reached" || ending === "terminated") {
    await setChangeSessionState(
      deps.db,
      change.id,
      ending === "terminated" ? "terminated" : "budget_reached",
    );
    await clearChangeWaiting(deps.db, change.id);
    await settleAndQueue(
      deps,
      conversation,
      "failed",
      { kind: "change", changeId: change.id },
      log,
      {
        key: state.id,
        note: notes[ending],
      },
    );
    return lastEventAt;
  }

  const processedBefore = events
    .slice(0, stateIndex)
    .flatMap((event) => (event.kind === "user_message" && event.processed ? [event.id] : []));
  // A brief queued, or taken up after this turn ended: the worker is not done, so nothing it
  // was handed later is settled by this turn's verdict, and it still has work.
  const busy = events.slice(stateIndex + 1).some((event) => event.kind === "user_message");
  const anyQueued =
    busy || events.some((event) => event.kind === "user_message" && !event.processed);
  const { status, note } =
    ending === "end_turn"
      ? await judgeWorkerTurn(deps, conversation, change, events, stateIndex, log)
      : { status: "failed" as const, note: notes[ending] };
  if (processedBefore.length > 0) {
    await settleAndQueue(
      deps,
      conversation,
      status,
      { kind: "briefs", workerEventIds: processedBefore },
      log,
      { key: state.id, note },
    );
  }
  if (!anyQueued) {
    // Briefs sent without an event id: settled once the worker is idle with nothing queued.
    // The note goes with the first settlement only.
    await settleAndQueue(
      deps,
      conversation,
      status,
      { kind: "untracked_briefs", changeId: change.id },
      log,
      { key: `${state.id}:untracked`, note: processedBefore.length > 0 ? undefined : note },
    );
    if ((await unsentBriefs(deps.db, change.id)).length === 0) {
      await clearChangeWaiting(deps.db, change.id);
    }
  }
  return lastEventAt;
}

/**
 * The worker's turn, judged as a coding turn always was (decision 132): done when it ends,
 * unless it pushed or touched a pull request, which must then have passed CI. GitHub is asked
 * only while messages wait for the change.
 */
async function judgeWorkerTurn(
  deps: ConversationDeps,
  conversation: Conversation,
  change: Change,
  events: readonly AgentEvent[],
  endIndex: number,
  log: Logger,
): Promise<{ status: "answered" | "failed"; note: string | undefined }> {
  const before = events.slice(0, endIndex);
  const turn = before.slice(before.findLastIndex(endsTurn) + 1);
  // The change's latest pull request, for naming the areas its files touch after the sync
  // (slice 3.1). Only kept here; GitHub is asked outside the lease.
  const pullRequest = before.findLast((event) => event.kind === "pull_request");
  if (pullRequest?.kind === "pull_request") {
    await deps.db.query(
      `update changes set pull_request_url = $2
       where id = $1 and pull_request_url is distinct from $2`,
      [change.id, pullRequest.url],
    );
  }
  if (!turn.some((event) => event.kind === "pushed" || event.kind === "pull_request")) {
    return { status: "answered", note: undefined };
  }
  if ((await pendingChangeMessageCount(deps.db, change.id)) === 0) {
    return { status: "answered", note: undefined };
  }
  const verdict = await pullRequestVerdict(deps, conversation.id, before, log);
  return { status: verdict.status === "answered" ? "answered" : "failed", note: verdict.note };
}

/** Denies every tool call the worker waits on that has no answer yet (decision 119). */
async function denyWaitingCalls(
  deps: ConversationDeps,
  sessionId: string,
  events: readonly AgentEvent[],
  blockedOn: readonly string[],
  log: Logger,
): Promise<void> {
  const answered = new Set(
    events.flatMap((event) => {
      if (event.kind === "tool_confirmation") return [event.toolUseId];
      if (event.kind === "custom_tool_result") return [event.customToolUseId];
      return [];
    }),
  );
  const waiting = blockedOn.filter((id) => !answered.has(id));
  if (waiting.length === 0) return;
  // A custom tool call too: the worker is never given a tool the API answers, so a call to one
  // (start_change, say) is refused rather than answered.
  const custom = waiting.filter((id) =>
    events.some((event) => event.kind === "custom_tool_use" && event.id === id),
  );
  for (const id of custom) {
    await deps.runtime.answerCustomTool(sessionId, id, {
      text: "This tool is not available to the coding worker.",
      isError: true,
    });
  }
  const others = waiting.filter((id) => !custom.includes(id));
  if (others.length > 0) await deps.runtime.denyToolCalls(sessionId, others, DENY_MESSAGE);
  log.warn("change.tool_calls_denied", { sessionId, toolUseIds: waiting });
}

/** Stops a worker's turn that has gone quiet for GIVE_UP_AFTER_MINUTES (decision 113). */
async function giveUpIfStuck(
  deps: ConversationDeps,
  conversation: Conversation,
  change: Change,
  lastEventAt: Date | undefined,
  log: Logger,
): Promise<void> {
  if (change.waitingSince === null) return;
  const quietSince = Math.max(change.waitingSince.getTime(), lastEventAt?.getTime() ?? 0);
  const now = (await databaseNow(deps.db)).getTime();
  if (now - quietSince < GIVE_UP_AFTER_MINUTES * 60_000) return;
  const sessionId = workerSessionIdOf(change);
  if (sessionId !== undefined) await deps.runtime.interrupt(sessionId);
  await settleAndQueue(
    deps,
    conversation,
    "failed",
    { kind: "handed_over", changeId: change.id },
    log,
    {
      key: `change:${change.id}:timeout:${change.waitingSince.toISOString()}`,
      note: notes.timeout,
    },
  );
  await clearChangeWaiting(deps.db, change.id);
  log.warn("change.gave_up", { quietMinutes: Math.round((now - quietSince) / 60_000) });
}

/** Progress notes for a worker's long turn, as for a thread's own session (103, 106). */
async function postProgress(deps: ConversationDeps, change: Change, log: Logger): Promise<void> {
  const sessionId = workerSessionIdOf(change);
  if (sessionId === undefined || change.waitingSince === null) return;
  const waitingSince = change.waitingSince;
  const elapsedMinutes = ((await databaseNow(deps.db)).getTime() - waitingSince.getTime()) / 60_000;
  const due = progressDue(elapsedMinutes);
  if (due === undefined) return;
  const conversation = await getConversation(deps.db, change.conversationId);
  const activity = await latestActivity(deps.db, conversation.id, sessionId, waitingSince);
  await queue(
    deps,
    conversation,
    `progress:${change.id}:${waitingSince.toISOString()}:${String(due.number)}`,
    "note",
    { kind: "reply", target: targetOf(conversation), text: progressText(due.atMinutes, activity) },
  );
  await flushSoon(deps, conversation.id, log);
}

/** Hands a thread's newly started briefs to their workers. Logs, never throws. */
export async function syncChangesWithUnsentBriefs(
  deps: ConversationDeps,
  conversationId: string,
  log: Logger,
): Promise<void> {
  try {
    for (const change of await changesWithUnsentBriefs(deps.db, conversationId)) {
      await syncChange(deps, change, log).catch((error: unknown) => {
        log.error("change.sync_failed", { changeId: change.id, error });
      });
    }
  } catch (error) {
    log.error("change.sync_failed", { conversationId, error });
  }
}

/** The reconcile job's part for workers: briefs not handed over, turns waiting, notes due. */
export async function reconcileChanges(
  deps: ConversationDeps,
  log: Logger,
): Promise<{ checked: number; failed: number }> {
  const changes = await changesToReconcile(deps.db, {
    waitingForSeconds: RECONCILE_AFTER_SECONDS,
    limit: 20,
  });
  let failed = 0;
  for (const change of changes) {
    const changeLog = log.child({ changeId: change.id, conversationId: change.conversationId });
    try {
      await syncChange(deps, change, changeLog);
      await postProgress(deps, await getChange(deps.db, change.id), changeLog);
      // After the lease: the areas its pull request's files touch (slice 3.1).
      await namePullRequestAreas(deps, change.id, changeLog);
    } catch (error) {
      failed++;
      changeLog.error("reconcile.change_failed", { error });
    }
  }
  return { checked: changes.length, failed };
}

/**
 * A person starts a brief the start rule held back (`POST /v1/briefs/:id/start`). The thread is
 * told who started it, and the worker gets the brief straight away.
 */
export async function startBriefByPerson(
  deps: ConversationDeps,
  briefId: string,
  request: StartBriefRequest,
  log: Logger,
): Promise<StartBriefResult> {
  const result = await startBrief(deps.db, briefId, {
    source: request.source,
    workspaceId: request.workspaceId,
    actorId: request.actor.id,
    name: request.actor.displayName ?? null,
  });
  log.info("change.brief_start", { briefId, status: result.status });
  if (result.conversationId === undefined || result.changeId === undefined) {
    return { status: result.status };
  }
  const conversation = await getConversation(deps.db, result.conversationId);
  if (result.status === "started") {
    await queue(deps, conversation, `started:${briefId}`, "note", {
      kind: "reply",
      target: targetOf(conversation),
      text: changeTexts.started(
        request.actor.displayName ?? `${request.source} user ${request.actor.id}`,
      ),
    });
    await syncChange(deps, await getChange(deps.db, result.changeId), log).catch(
      (error: unknown) => {
        // Reconcile hands it over.
        log.error("change.sync_failed", { changeId: result.changeId, error });
      },
    );
  } else if (result.status === "stopped") {
    await queue(deps, conversation, `start_stopped:${briefId}`, "note", {
      kind: "reply",
      target: targetOf(conversation),
      text: changeTexts.stopped,
    });
  }
  await flushSoon(deps, conversation.id, log);
  return { status: result.status };
}
