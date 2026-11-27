import type {
  createGoalRequestSchema,
  EditGoalRequest,
  Job,
  OutboundDelivery,
  StartChangeInput,
} from "@hippidy/contracts";
import type { z } from "zod";
import type { BriefWriter, BriefWriteResult } from "../agent/brief-writer.ts";
import { callCostMicros } from "../agent/usage.ts";
import { pullNumberOf, type PullRequests, type PullRequestState } from "../github/pulls.ts";
import type { Logger } from "../log.ts";
import type { AreaActor, Place } from "../store/areas.ts";
import { createBrief } from "../store/changes.ts";
import { getConversation, type Conversation } from "../store/conversations.ts";
import type { Db } from "../store/db.ts";
import {
  briefByKey,
  claimAllSettled,
  createGoal,
  editGoal,
  findGoal,
  goalTicketKeys,
  markTicketBriefed,
  recordBriefFailure,
  settlePendingTicket,
  settleTicket,
  type CheckedTicket,
  type GoalWrite,
  type StoredGoal,
  type StoredTicket,
  type ThreadLine,
} from "../store/goals.ts";
import { BUILTIN_JOBS } from "../store/jobs.ts";
import { findBuiltinTask, markTaskDone } from "../store/tasks.ts";
import type { TaskSource } from "../tasks/provider.ts";
import { briefForThread } from "./agent-tools.ts";
import { flushSoon, targetOf, type ConversationDeps } from "./conversations.ts";
import type { WakeResult } from "./jobs.ts";

// A feature goal (slice 4.4, decision 221): a job a person makes for one thread, with its
// tickets in order. Each wake settles the changes it started (a stopped change, a merged or
// closed pull request), then, under its limit, writes the next ticket's brief with one model
// call and posts it in the thread for a person to start. At most one brief per wake. It never
// changes its own goal, tickets or limit (G16), and never writes to Jira (3.3).

/** What compose builds for goals: GitHub, read with the checks token, and the brief writer. */
export interface GoalServices {
  pulls: PullRequests | undefined;
  writer: BriefWriter | undefined;
}

/** What a goal's wake needs; reconcile adds the tracker, the loop and the web app's origin. */
export interface GoalDeps extends GoalServices {
  /** Where tasks come from: the tracker the tickets are in. */
  tasks: TaskSource | undefined;
  /** To post the thread's lines now; without it, a later flush posts them. */
  conversations?: ConversationDeps | undefined;
  /** The web app's origin, for a built-in task's link in its brief. */
  webBaseUrl?: string | undefined;
}

/** Names a goal cannot take: the built-in jobs', and the new-goal page's address. */
export const RESERVED_GOAL_NAMES: ReadonlySet<string> = new Set([
  ...BUILTIN_JOBS.map((job) => job.name),
  "new-goal",
]);

/** Most tracker lookups one wake makes while looking for the next ticket to brief. */
export const MAX_LOOKUPS_PER_WAKE = 5;
/** Tickets looked up at once when a person adds them. */
const LOOKUPS_AT_ONCE = 6;

/** The brief key of a goal's ticket: one brief per ticket, whatever happens (2.1's key). */
export function goalBriefKey(jobId: string, key: string): string {
  return `goal:${jobId}:${key}`;
}

/** Why a person must press Start: the brief was written from a ticket anyone may write. */
export function goalStartReason(goalName: string, key: string): string {
  return `read ticket ${key} for the ${goalName} goal`;
}

/** Who a goal acts as in a built-in task's history. */
export function goalActor(place: Place, goalName: string): AreaActor {
  return { ...place, actorId: `job:${goalName}`, name: `the ${goalName} goal` };
}

// ---------------------------------------------------------------------------------------
// Making and changing a goal, from a signed-in person

export type TicketCheck =
  | { kind: "ok"; tickets: Map<string, CheckedTicket> }
  | { kind: "unknown"; keys: string[] }
  | { kind: "unavailable" };

/** Looks each key up in the tracker, a few at a time: all found, some not, or no answer. */
export async function checkTickets(
  source: TaskSource,
  place: Place,
  keys: readonly string[],
): Promise<TicketCheck> {
  const found = new Map<string, CheckedTicket>();
  const unknown: string[] = [];
  for (let at = 0; at < keys.length; at += LOOKUPS_AT_ONCE) {
    const batch = keys.slice(at, at + LOOKUPS_AT_ONCE);
    const lookups = await Promise.all(batch.map((key) => source.get(place, key)));
    for (const [index, lookup] of lookups.entries()) {
      const key = batch[index] ?? "";
      if (lookup.kind === "unavailable") return { kind: "unavailable" };
      if (lookup.kind === "missing") unknown.push(key);
      else found.set(key, { key, title: lookup.task.title, url: lookup.task.url });
    }
  }
  return unknown.length > 0 ? { kind: "unknown", keys: unknown } : { kind: "ok", tickets: found };
}

/** What making or changing a goal did, the tracker's answer included. */
export type GoalOutcome = GoalWrite | { status: "tracker_unavailable" };

/** `POST /v1/goals`: the tickets checked in the tracker first, then the goal made. */
export async function createGoalForPerson(
  db: Db,
  source: TaskSource,
  actor: AreaActor,
  request: z.output<typeof createGoalRequestSchema>,
): Promise<GoalOutcome> {
  if (RESERVED_GOAL_NAMES.has(request.name)) return { status: "name_taken" };
  const check = await checkTickets(source, actor, request.tickets);
  if (check.kind === "unavailable") return { status: "tracker_unavailable" };
  if (check.kind === "unknown") return { status: "unknown_tickets", tickets: check.keys };
  return createGoal(
    db,
    actor,
    request,
    request.tickets.map((key) => check.tickets.get(key) ?? { key, title: key, url: null }),
  );
}

/** `PATCH /v1/goals/:jobId`: the tickets added are checked in the tracker, then it is changed. */
export async function editGoalForPerson(
  db: Db,
  source: TaskSource,
  actor: AreaActor,
  jobId: string,
  request: EditGoalRequest,
): Promise<GoalOutcome> {
  const current = await goalTicketKeys(db, actor, jobId);
  if (current === undefined) return { status: "not_found" };
  const known = new Set(current);
  const added = (request.tickets ?? []).filter((key) => !known.has(key));
  const check = await checkTickets(source, actor, added);
  if (check.kind === "unavailable") return { status: "tracker_unavailable" };
  if (check.kind === "unknown") return { status: "unknown_tickets", tickets: check.keys };
  return editGoal(db, actor, jobId, request, check.tickets);
}

// ---------------------------------------------------------------------------------------
// One wake

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
}

/** `[#12](url)`, or the link alone when it names no number. */
function pullLink(url: string): string {
  const number = /\/pull\/(\d+)/.exec(url)?.[1];
  return number === undefined ? url : `[#${number}](${url})`;
}

/** Why a model call gave no brief, in a few words. */
function noBrief(result: BriefWriteResult): string {
  if (result.kind === "refused") return "the model declined to write it";
  if (result.kind === "cut_off") return "the brief was cut off";
  // Read by shape: Vercel's check, without strict null checks, does not narrow this union.
  return `the model call failed: ${"error" in result ? result.error : "no answer"}`;
}

/** What a wake did, to say in its summary, and what its model call cost once it was made. */
interface Said {
  events: string[];
  queued: number;
  costMicros: number;
}

/** A reply line for the goal's thread, keyed to its ticket and event so it is queued once. */
function line(conversation: Conversation, key: string, text: string): ThreadLine {
  const payload: OutboundDelivery = {
    kind: "reply",
    target: targetOf(conversation),
    text,
    mentions: [],
  };
  return { conversationId: conversation.id, key, payload };
}

/** One wake of a goal. Throws only for what makes the wake a failure. */
export async function runGoal(
  deps: GoalDeps | undefined,
  db: Db,
  place: Place,
  job: Job,
  log: Logger,
): Promise<WakeResult> {
  const goal = await findGoal(db, job.id);
  if (goal === undefined) {
    return { outcome: "silent", summary: "it has no thread or tickets", costMicros: 0 };
  }
  const conversation = await getConversation(db, goal.conversationId);
  const said: Said = { events: [], queued: 0, costMicros: 0 };
  const notes: string[] = [];
  try {
    await settle(deps, db, place, job, goal, conversation, said, notes, log);
    const result = await briefNext(deps, db, place, job, goal, conversation, said, notes, log);
    return result;
  } catch (error) {
    // A step after the model call failed: the wake fails, but what the call cost is kept on it,
    // under the cap (from the review). Before any call, the scheduler logs the failure.
    if (said.costMicros === 0) throw error;
    log.error("goal.failed_after_call", { error });
    return {
      outcome: "failed",
      summary: [...said.events, "failed after writing a brief", ...notes].join("; "),
      costMicros: said.costMicros,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Whatever happened after, what was queued is posted now (outside any transaction).
    if (said.queued > 0 && deps?.conversations !== undefined) {
      await flushSoon(deps.conversations, conversation.id, log).catch((error: unknown) => {
        log.warn("goal.flush_failed", { error });
      });
    }
  }
}

/** Step 1: settles each briefed ticket whose change was stopped or whose pull request ended. */
async function settle(
  deps: GoalDeps | undefined,
  db: Db,
  place: Place,
  job: Job,
  goal: StoredGoal,
  conversation: Conversation,
  said: Said,
  notes: string[],
  log: Logger,
): Promise<void> {
  const provider = deps?.tasks?.provider ?? "builtin";
  let unread = 0;
  for (const ticket of goal.tickets) {
    if (ticket.state !== "briefed") continue;
    let pull: PullRequestState | undefined;
    const url = ticket.pullRequestUrl;
    if (url !== null) {
      const pulls = deps?.pulls;
      const number = pulls === undefined ? undefined : pullNumberOf(url, pulls.repository);
      if (pulls !== undefined && number !== undefined) {
        // GitHub is asked outside any transaction; a failure leaves the ticket for a later wake.
        pull = await pulls.pullState(number).catch((error: unknown): undefined => {
          log.warn("goal.pull_state_failed", { ticket: ticket.key, error });
          return undefined;
        });
        if (pull === undefined) {
          // Not even a stop settles it until GitHub answers: it may have merged (from the review).
          unread++;
          continue;
        }
      }
      if (pull === undefined) unread++;
    }
    // A merge or a close is read first: a stop said in the thread after the pull request
    // merged stops every change of the thread, but does not undo the merge.
    let state: "merged" | "closed" | "stopped" | undefined;
    let text = "";
    if (pull === "merged" && url !== null) {
      state = "merged";
      text =
        provider === "builtin"
          ? `${ticket.key}'s pull request ${pullLink(url)} merged, so ${ticket.key} is done.`
          : `${ticket.key}'s pull request ${pullLink(url)} merged. I only read the tracker, so someone needs to close ${ticket.key} there.`;
    } else if (pull === "closed" && url !== null && ticket.changeBusy) {
      // Closed while its change (not stopped) has more work in hand, a follow-up brief or a
      // worker on one: another pull request may follow, so its place is held (from the review).
      continue;
    } else if (pull === "closed" && url !== null) {
      state = "closed";
      text = `${ticket.key}'s pull request ${pullLink(url)} was closed without merging, so the goal will not brief ${ticket.key} again.`;
    } else if (ticket.changeStatus === "stopped") {
      state = "stopped";
      text = `${ticket.key}'s change was stopped in this thread, so the goal will not brief ${ticket.key} again.`;
    }
    if (state === undefined) continue;
    const settled = await settleTicket(
      db,
      ticket.id,
      state,
      line(conversation, `goal:${ticket.id}:${state}`, text),
      // A built-in task is marked done as the goal, in the same transaction (kept in its history).
      state === "merged" && provider === "builtin"
        ? async (tx) => {
            await markTaskDone(tx, place, ticket.key, goalActor(place, job.name));
          }
        : undefined,
    );
    if (settled) {
      ticket.state = state;
      said.queued++;
      said.events.push(`${ticket.key} ${state}`);
      log.info("goal.settled", { ticket: ticket.key, state });
    }
  }
  if (unread > 0) {
    notes.push(
      deps?.pulls === undefined
        ? "GitHub is not configured"
        : `${plural(unread, "pull request")} not read from GitHub`,
    );
  }
}

/** Steps 2 and 3: counts what is open and, under the limit, briefs the next ticket. */
async function briefNext(
  deps: GoalDeps | undefined,
  db: Db,
  place: Place,
  job: Job,
  goal: StoredGoal,
  conversation: Conversation,
  said: Said,
  notes: string[],
  log: Logger,
): Promise<WakeResult> {
  const done = (outcome: "said" | "silent", quiet: string, costMicros = 0): WakeResult => {
    const summary = [...said.events, ...(said.events.length === 0 ? [quiet] : []), ...notes];
    return {
      outcome: said.queued > 0 ? "said" : outcome,
      summary: summary.join("; "),
      costMicros,
    };
  };
  const open = goal.tickets.filter((ticket) => ticket.state === "briefed").length;
  const pending = goal.tickets.filter((ticket) => ticket.state === "pending");
  if (pending.length === 0) {
    if (open > 0) return done("silent", `${plural(open, "change")} open; no ticket left to brief`);
    // Every ticket is settled: said once, until a person adds one.
    const counts = new Map<string, number>();
    for (const ticket of goal.tickets)
      counts.set(ticket.state, (counts.get(ticket.state) ?? 0) + 1);
    const parts = [...counts.entries()].map(
      ([state, count]) => `${String(count)} ${state.replace("_", " ")}`,
    );
    const claimed = await claimAllSettled(db, goal.jobId, (at) =>
      line(
        conversation,
        `goal:${goal.jobId}:settled:${String(at.getTime())}`,
        `Every ticket of the ${job.name} goal is settled (${parts.join(", ")}).`,
      ),
    );
    if (claimed) {
      said.queued++;
      said.events.push("every ticket is settled");
    }
    return done("silent", "every ticket is settled");
  }
  if (open >= goal.limit) {
    return done("silent", `${String(open)} of ${String(goal.limit)} changes open; waiting`);
  }
  const writer = deps?.writer;
  if (writer === undefined) return done("silent", "the agent is not configured");
  const tasks = deps?.tasks;
  if (tasks === undefined) return done("silent", "the task tracker is not configured");
  if (job.owner === null) return done("silent", "it has no owner to brief for");
  const owner = job.owner;

  let lookups = 0;
  for (const ticket of pending) {
    const key = goalBriefKey(job.id, ticket.key);
    // A wake that died after writing the brief: posted now, never written or paid for again.
    const earlier = await briefByKey(db, key);
    if (earlier !== undefined) {
      const brief: StartChangeInput = {
        title: earlier.title,
        what: earlier.what,
        why: earlier.why,
        doneWhen: earlier.doneWhen,
        links: earlier.links,
      };
      const posted = await post(db, conversation, ticket, {
        changeId: earlier.changeId,
        briefId: earlier.briefId,
        title: ticket.title,
        text: briefForThread(brief, earlier.startReason ?? goalStartReason(job.name, ticket.key)),
      });
      if (!posted) return done("silent", `${ticket.key} changed while this wake ran`);
      said.queued++;
      said.events.push(`posted the brief for ${ticket.key}`);
      return done("said", "");
    }
    if (lookups >= MAX_LOOKUPS_PER_WAKE) break;
    lookups++;
    const lookup = await tasks.get(place, ticket.key);
    if (lookup.kind === "unavailable") {
      if (lookup.problem === "not_configured") {
        return done("silent", "the task tracker is not configured");
      }
      return {
        outcome: "failed",
        summary: [...said.events, `could not read ${ticket.key}`, ...notes].join("; "),
        costMicros: 0,
        error: "the task tracker did not answer",
      };
    }
    if (lookup.kind === "missing") {
      const settled = await settlePendingTicket(
        db,
        ticket.id,
        "skipped",
        "not in the tracker",
        line(
          conversation,
          `goal:${ticket.id}:skipped`,
          `${ticket.key} is no longer in the tracker, so the goal skips it.`,
        ),
      );
      if (settled) {
        said.queued++;
        said.events.push(`${ticket.key} skipped: not in the tracker`);
      }
      continue;
    }
    const task = lookup.task;
    if (task.status === "done") {
      // Done before the goal got to it: nothing to brief, and nothing to say.
      if (await settlePendingTicket(db, ticket.id, "done_elsewhere", undefined, undefined)) {
        said.events.push(`${ticket.key} done elsewhere`);
      }
      continue;
    }
    // A built-in task's description; Jira's is not read, so its brief is from its title.
    const description =
      tasks.provider === "builtin"
        ? ((await findBuiltinTask(db, place, ticket.key))?.description ?? null)
        : null;
    const result = await writer.write({
      goal: { name: job.name, text: job.goal },
      ticket: { key: ticket.key, title: task.title, description },
      others: goal.tickets
        .filter((other) => other.id !== ticket.id)
        .map((other) => ({ key: other.key, title: other.title })),
    });
    const cost = callCostMicros(result.usage);
    said.costMicros += cost;
    if (result.kind !== "ok") {
      const why = noBrief(result);
      const failure = await recordBriefFailure(db, ticket.id, why, (failures) =>
        line(
          conversation,
          `goal:${ticket.id}:skipped`,
          `I could not write a brief for ${ticket.key} ${String(failures)} times in a row, so the goal skips it.`,
        ),
      );
      if (failure.skipped) said.queued++;
      log.warn("goal.no_brief", { ticket: ticket.key, kind: result.kind, ...failure });
      return {
        outcome: "failed",
        summary: [
          ...said.events,
          `could not write the brief for ${ticket.key}${failure.skipped ? "; skipped it" : ""}`,
          ...notes,
        ].join("; "),
        costMicros: cost,
        error: why,
      };
    }
    const link =
      task.url ??
      (deps?.webBaseUrl === undefined
        ? undefined
        : `${deps.webBaseUrl.replace(/\/+$/, "")}/tasks/${encodeURIComponent(ticket.key)}`);
    const brief: StartChangeInput = { ...result.brief, links: link === undefined ? [] : [link] };
    const reason = goalStartReason(job.name, ticket.key);
    const created = await createBrief(db, {
      conversationId: conversation.id,
      customToolUseId: key,
      changeId: undefined,
      requestedBy: {
        source: conversation.key.source,
        workspaceId: conversation.key.workspaceId,
        actorId: owner.actorId,
        name: owner.name,
      },
      brief,
      // Every goal brief waits for a person (2.1's rule 3): the ticket is anyone's text.
      startReason: reason,
      turnEventIds: [],
    });
    if (created.kind === "no_change" || created.kind === "stopped") {
      return {
        outcome: "failed",
        summary: [...said.events, `could not brief ${ticket.key}`, ...notes].join("; "),
        costMicros: cost,
        error: `the brief was not kept (${created.kind})`,
      };
    }
    const posted = await post(db, conversation, ticket, {
      changeId: created.changeId,
      briefId: created.briefId,
      title: task.title,
      text: briefForThread(brief, reason),
    });
    if (!posted) {
      log.warn("goal.ticket_changed", { ticket: ticket.key });
      return done("silent", `${ticket.key} changed while this wake ran`, cost);
    }
    said.queued++;
    said.events.push(`posted the brief for ${ticket.key}`);
    log.info("goal.briefed", { ticket: ticket.key, costMicros: cost });
    return done("said", "", cost);
  }
  return done("silent", "no ticket to brief this wake");
}

/** Marks the ticket briefed and queues its brief, with Start, under the brief's id. */
async function post(
  db: Db,
  conversation: Conversation,
  ticket: StoredTicket,
  brief: { changeId: string; briefId: string; title: string; text: string },
): Promise<boolean> {
  // A person removed the ticket (or it was settled) since this wake read it: nothing is
  // posted, and the brief kept under its key is posted if the ticket is pending again.
  const marked = await markTicketBriefed(
    db,
    ticket.id,
    { changeId: brief.changeId, briefId: brief.briefId, title: brief.title },
    {
      conversationId: conversation.id,
      key: `brief:${brief.briefId}`,
      payload: {
        kind: "brief",
        target: targetOf(conversation),
        briefId: brief.briefId,
        text: brief.text,
        needsStart: true,
      },
    },
  );
  if (marked) ticket.state = "briefed";
  return marked;
}
