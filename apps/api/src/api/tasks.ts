import {
  mentionToken,
  type EndWaitInput,
  type LinkTaskInput,
  type RecordWaitInput,
  type Wait,
} from "@hippidy/contracts";
import { z } from "zod";
import { createLogger } from "../log.ts";
import { knownName } from "../store/areas.ts";
import { actorNameInConversation } from "../store/changes.ts";
import { enqueueDelivery, getConversation } from "../store/conversations.ts";
import type { Db } from "../store/db.ts";
import { readTurnMessage } from "../store/decisions.ts";
import {
  hasWrittenInConversation,
  type ProcessedUserMessage,
  type ToolCallContext,
} from "../store/projects.ts";
import { linkThreadToTask } from "../store/tasks.ts";
import {
  endWait,
  MAX_OPEN_WAITS_PER_THREAD,
  MAX_WAITS_PER_THREAD_PER_DAY,
  recordWait,
  waitsIn,
} from "../store/waits.ts";
import { createTaskSource, type TaskSource } from "../tasks/provider.ts";
import type { CustomToolAnswer, CustomToolCall, Routing } from "./agent-tools.ts";
import { targetOf } from "./conversations.ts";

// The teammate's task and waiting-on tools (slice 3.3, decision 210). Each write is keyed on
// the call or is the same when done again, so answering a call twice records nothing twice.

export const taskErrors = {
  noTask: (key: string, provider: string) =>
    `there is no task ${key} in ${provider === "jira" ? "Jira" : "the built-in tracker"}`,
  waiterNotInThread: (actorId: string) =>
    `${actorId} has not written in this thread; record only a wait someone here said they have`,
  unknownPerson: (actorId: string) =>
    `${actorId} is not someone the bot knows; ask for the person's Slack user id as it appears in the thread`,
  same: "a person cannot wait on themselves",
  tooMany: `this thread already has ${String(MAX_OPEN_WAITS_PER_THREAD)} open waits; end the ones that are done first`,
  tooManyToday: `this thread has recorded ${String(MAX_WAITS_PER_THREAD_PER_DAY)} waits today; record more tomorrow`,
  notTheirs:
    "only the person waiting or the person waited on may record a wait, in their own message",
  notPart: (n: number) =>
    `only the person waiting, the person waited on or whoever recorded it may end wait ${String(n)}`,
  noSender:
    "cannot tell which message in this thread this call answers, so there is no one to act for",
  noWait: (n: number) => `there is no wait ${String(n)} recorded in this thread`,
} as const;

function error(text: string): CustomToolAnswer {
  return { text, isError: true };
}

function sourceOf(db: Db, routing: Routing): TaskSource {
  return routing.tasks ?? createTaskSource({ kind: "builtin" }, db, routing.log ?? createLogger());
}

/** Links the thread to the task it works on (SCRUM-8), checked against the provider. */
export async function linkTask(
  db: Db,
  conversationId: string,
  context: ToolCallContext,
  input: LinkTaskInput,
  routing: Routing,
): Promise<CustomToolAnswer> {
  const key = input.key.toUpperCase();
  const source = sourceOf(db, routing);
  // A short wait: this runs while the conversation's sync lease is held (from the review).
  const found = await source.get(context, key, { quick: true });
  if (found.kind === "missing") return error(taskErrors.noTask(key, source.provider));
  await linkThreadToTask(db, conversationId, key);
  return {
    text: JSON.stringify(
      found.kind === "found"
        ? { key, title: found.task.title, status: found.task.statusName, linked: true }
        : {
            key,
            linked: true,
            note:
              found.problem === "not_configured"
                ? "Jira is not set up for the bot, so the key was linked as given"
                : "Jira did not answer in time, so the key was linked as given",
          },
    ),
    isError: false,
  };
}

function waitLine(wait: Wait): string {
  const who = wait.waiter.name ?? wait.waiter.actorId;
  const task = wait.taskKey === null ? "" : ` (${wait.taskKey})`;
  return `${who} is waiting on ${mentionToken(wait.waitingOn.actorId)}: ${wait.what}${task}`;
}

/** Records a wait someone in the thread said they have, and posts it once. */
export async function recordWaitFor(
  db: Db,
  conversationId: string,
  context: ToolCallContext,
  call: CustomToolCall,
  messages: readonly ProcessedUserMessage[],
  input: RecordWaitInput,
): Promise<CustomToolAnswer> {
  const mine = await db.query(
    `select number::int as number from waits where custom_tool_use_id = $1`,
    [call.id],
  );
  if (mine[0] !== undefined) {
    const number = z.object({ number: z.number() }).parse(mine[0]).number;
    return { text: JSON.stringify({ number, recorded: true }), isError: false };
  }
  if (input.waiter === input.waitingOn) return error(taskErrors.same);
  // Recorded only for the person whose message this turn answers, about themselves: a
  // bystander, or text the teammate read, cannot put a wait in someone else's name (from the
  // review of 3.3; as 209).
  const turn =
    call.processedAt === null
      ? undefined
      : await readTurnMessage(db, conversationId, call.processedAt, messages);
  if (turn === undefined) return error(taskErrors.noSender);
  if (turn.actorId !== input.waiter && turn.actorId !== input.waitingOn) {
    return error(taskErrors.notTheirs);
  }
  if (
    !(await hasWrittenInConversation(db, conversationId, { ...context, actorId: input.waiter }))
  ) {
    return error(taskErrors.waiterNotInThread(input.waiter));
  }
  const waitingOnName =
    (await actorNameInConversation(db, conversationId, input.waitingOn)) ??
    (await knownName(db, context, input.waitingOn));
  const known =
    waitingOnName !== null ||
    (await hasWrittenInConversation(db, conversationId, {
      ...context,
      actorId: input.waitingOn,
    })) ||
    (
      await db.query(
        `select 1 from areas where source = $1 and workspace_id = $2 and owner_actor_id = $3
         union all
         select 1 from inbound_messages where source = $1 and workspace_id = $2 and actor_id = $3
         limit 1`,
        [context.source, context.workspaceId, input.waitingOn],
      )
    ).length > 0;
  if (!known) return error(taskErrors.unknownPerson(input.waitingOn));
  const counts = await waitsIn(db, conversationId);
  if (counts.open >= MAX_OPEN_WAITS_PER_THREAD) return error(taskErrors.tooMany);
  if (counts.lastDay >= MAX_WAITS_PER_THREAD_PER_DAY) return error(taskErrors.tooManyToday);
  const recorder = turn.actorId;
  const conversation = await getConversation(db, conversationId);
  const recorded = await db.transaction(async (tx) => {
    const result = await recordWait(tx, {
      place: context,
      waiter: {
        actorId: input.waiter,
        name: await actorNameInConversation(tx, conversationId, input.waiter),
      },
      waitingOn: { actorId: input.waitingOn, name: waitingOnName },
      what: input.what,
      taskKey: input.taskKey?.toUpperCase() ?? null,
      conversationId,
      recordedBy: {
        actorId: recorder,
        name: await actorNameInConversation(tx, conversationId, recorder),
      },
      customToolUseId: call.id,
    });
    // Queued with it, so answering the call again posts it once.
    await enqueueDelivery(tx, conversationId, `wait:${result.wait.id}`, "note", {
      kind: "reply",
      target: targetOf(conversation),
      text: `**Wait ${String(result.wait.number)}:** ${waitLine(result.wait)}`,
      mentions: [input.waitingOn],
    });
    return result.wait;
  });
  return { text: JSON.stringify({ number: recorded.number, recorded: true }), isError: false };
}

/** Ends a wait recorded in this thread, as the person whose message the turn answers. */
export async function endWaitFor(
  db: Db,
  conversationId: string,
  context: ToolCallContext,
  call: CustomToolCall,
  messages: readonly ProcessedUserMessage[],
  input: EndWaitInput,
): Promise<CustomToolAnswer> {
  const turn =
    call.processedAt === null
      ? undefined
      : await readTurnMessage(db, conversationId, call.processedAt, messages);
  if (turn === undefined) return error(taskErrors.noSender);
  const actor = {
    ...context,
    actorId: turn.actorId,
    name: await actorNameInConversation(db, conversationId, turn.actorId),
  };
  const conversation = await getConversation(db, conversationId);
  const result = await endWait(
    db,
    actor,
    { number: input.number, conversationId },
    // Queued with the end, so it is never ended without being said.
    async (tx, wait) => {
      const who = wait.waiter.name ?? wait.waiter.actorId;
      await enqueueDelivery(tx, conversationId, `wait-ended:${wait.id}`, "note", {
        kind: "reply",
        target: targetOf(conversation),
        text: `Wait ${String(wait.number)} ended by ${actor.name ?? actor.actorId}: ${who} is no longer waiting on ${wait.waitingOn.name ?? wait.waitingOn.actorId} for "${wait.what}".`,
      });
    },
  );
  if (result.status === "not_found") return error(taskErrors.noWait(input.number));
  if (result.status === "not_allowed") return error(taskErrors.notPart(input.number));
  return {
    text: JSON.stringify({ number: result.wait.number, status: "ended" }),
    isError: false,
  };
}
