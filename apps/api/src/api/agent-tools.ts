import {
  customToolNameSchema,
  endWaitInputSchema,
  linkProjectInputSchema,
  linkTaskInputSchema,
  raiseConflictInputSchema,
  recordWaitInputSchema,
  recallDecisionsInputSchema,
  recordApprovalInputSchema,
  recordDecisionInputSchema,
  startChangeInputSchema,
  type Decision,
  type LinkProjectInput,
  type LinkProjectOutput,
  type Project,
  type RecordApprovalInput,
  type RecordApprovalOutput,
  type RecallDecisionsInput,
  type RecordDecisionInput,
  type RecordDecisionOutput,
  type StartChangeInput,
  type StartChangeOutput,
} from "@hippidy/contracts";
import { areasInText, nameChangeAreas, ownerLines, type Fallback } from "./areas.ts";
import {
  raiseConflict,
  replacementDeciders,
  replacementLines,
  rolesFromStored,
} from "./conflicts.ts";
import { storedDeciders } from "../store/conflicts.ts";
import { endWaitFor, linkTask, recordWaitFor } from "./tasks.ts";
import type { TaskSource } from "../tasks/provider.ts";
import { findAreaByName, listAreas } from "../store/areas.ts";
import type { z } from "zod";
import type { AgentEvent } from "../agent/runtime.ts";
import { actorNameInConversation, createBrief } from "../store/changes.ts";
import { enqueueDelivery, getConversation } from "../store/conversations.ts";
import type { Db } from "../store/db.ts";
import type { Logger } from "../log.ts";
import {
  findDecisionByNumber,
  readTurnMessage,
  readTurnSenders,
  recordDecision,
  searchDecisions,
} from "../store/decisions.ts";
import {
  createProject,
  getProject,
  hasWrittenInConversation,
  isApproved,
  listApprovals,
  readToolCallContext,
  readTurnSender,
  recordApproval,
  setConversationProject,
  type ProcessedUserMessage,
  type ToolCallContext,
} from "../store/projects.ts";

// The custom tools the API answers for the agent (slice 5A, part E; decision 167). Each
// handler commits its write before it returns, through single statements and no transaction,
// so nothing is held open while the answer goes to the agent runtime. Every write is keyed on
// the call's id, so answering a call again records nothing twice.

/** A custom tool call as the agent made it. */
export interface CustomToolCall {
  /** The call's id: the `agent.custom_tool_use` event's id. */
  id: string;
  name: string;
  input: unknown;
  /** When the runtime processed the call, as it gave it; null if it gave no time. */
  processedAt: string | null;
}

/** What the agent is told: the tool's result as text, or why the call failed. */
export interface CustomToolAnswer {
  text: string;
  isError: boolean;
}

export const toolErrors = {
  notLinked: "this thread is not linked to a project; call link_project first",
  noSender:
    "cannot tell which message in this thread this call answers, so there is no one to make " +
    "the project for",
  notInThread: "only people who have written in this thread can be recorded as approving",
  noProject: (id: string) => `there is no project with id ${id}`,
  noChange: (id: string) => `this thread has no change with id ${id}`,
  noActiveDecision: (n: number) => `there is no active decision ${String(n)} to supersede`,
  changeStopped:
    "that change was stopped; leave out changeId to start a new change if it is still wanted",
  noRequester:
    "cannot tell which message in this thread this call answers, so there is no one the " +
    "change is for",
  unknownTool: (name: string) => `unknown tool "${clip(name, 100)}"`,
} as const;

/**
 * Answers one custom tool call. `messages` are the user messages the session has processed
 * so far, to tell whose message the call's turn is answering; `events` are the session's
 * events the loop acts on, for what it did before the call. Throws only if the database cannot
 * be read or written.
 */
export async function answerCustomToolCall(
  db: Db,
  conversationId: string,
  call: CustomToolCall,
  messages: readonly ProcessedUserMessage[],
  events: readonly AgentEvent[] = [],
  routing: Routing = {},
): Promise<CustomToolAnswer> {
  const name = customToolNameSchema.safeParse(call.name);
  if (!name.success) return error(toolErrors.unknownTool(call.name));
  const context = await readToolCallContext(db, conversationId);
  if (context === undefined) throw new Error(`no conversation ${conversationId}`);
  switch (name.data) {
    case "link_project": {
      const input = linkProjectInputSchema.safeParse(call.input);
      if (!input.success) return invalid(name.data, input.error);
      return linkProject(db, conversationId, context, call, messages, input.data);
    }
    case "record_approval": {
      const input = recordApprovalInputSchema.safeParse(call.input);
      if (!input.success) return invalid(name.data, input.error);
      return recordApprovalFor(db, conversationId, context, call.id, input.data);
    }
    case "start_change": {
      const input = startChangeInputSchema.safeParse(call.input);
      if (!input.success) return invalid(name.data, input.error);
      return startChange(db, conversationId, context, call, messages, events, input.data, routing);
    }
    case "record_decision": {
      const input = recordDecisionInputSchema.safeParse(call.input);
      if (!input.success) return invalid(name.data, input.error);
      return recordDecisionFor(
        db,
        conversationId,
        context,
        call,
        messages,
        events,
        input.data,
        routing,
      );
    }
    case "recall_decisions": {
      const input = recallDecisionsInputSchema.safeParse(call.input);
      if (!input.success) return invalid(name.data, input.error);
      return recallDecisions(db, input.data);
    }
    case "raise_conflict": {
      const input = raiseConflictInputSchema.safeParse(call.input);
      if (!input.success) return invalid(name.data, input.error);
      return raiseConflict(db, conversationId, context, call, input.data, routing);
    }
    case "link_task": {
      const input = linkTaskInputSchema.safeParse(call.input);
      if (!input.success) return invalid(name.data, input.error);
      return linkTask(db, conversationId, context, input.data, routing);
    }
    case "record_wait": {
      const input = recordWaitInputSchema.safeParse(call.input);
      if (!input.success) return invalid(name.data, input.error);
      return recordWaitFor(db, conversationId, context, call, messages, input.data);
    }
    case "end_wait": {
      const input = endWaitInputSchema.safeParse(call.input);
      if (!input.success) return invalid(name.data, input.error);
      return endWaitFor(db, conversationId, context, call, messages, input.data);
    }
  }
}

/** What routing by area needs from the loop (slice 3.1). */
export interface Routing {
  fallback?: Fallback | undefined;
  log?: Logger | undefined;
  /** Where tasks come from (slice 3.3). */
  tasks?: TaskSource | undefined;
}

/** Why a recorded decision is only proposed, for the thread; undefined when it is active. */
export function proposedBecause(conditions: {
  deciderIsAsker: boolean;
  askedToRecord: boolean;
  untrustedRead: string | undefined;
  othersInTurn?: boolean;
  /** The number of a decision it replaces that waits for its deciders (decision 208). */
  replaces?: number | undefined;
}): string | undefined {
  if (conditions.replaces !== undefined) {
    return `it would replace decision ${String(conditions.replaces)}, so only the people named above can confirm it`;
  }
  if (conditions.untrustedRead !== undefined) {
    return `I ${conditions.untrustedRead} first, so a person needs to confirm it`;
  }
  if (conditions.othersInTurn === true) {
    return "other people's words came with the message, so a person needs to confirm it";
  }
  if (!conditions.deciderIsAsker)
    return "it was not recorded at the request of the person who decided it";
  if (!conditions.askedToRecord) return "nobody asked for it to be recorded";
  return undefined;
}

/** No condition for a proposal holds: for a reason that is only the replacement's. */
const noConditions: {
  deciderIsAsker: boolean;
  askedToRecord: boolean;
  untrustedRead: string | undefined;
} = { deciderIsAsker: true, askedToRecord: true, untrustedRead: undefined };

/** A recorded decision as people read it in the thread. */
export function decisionForThread(
  decision: Decision,
  because: string | undefined,
  replaced?: { number: number; statement: string },
): string {
  const who = decision.decidedBy.name ?? decision.decidedBy.actorId ?? "someone";
  const reason = decision.reason === null ? "" : ` Why: ${decision.reason}`;
  // What it replaces is quoted, so whoever confirms a proposal sees which decision it retires.
  const quoted =
    replaced === undefined
      ? ""
      : `: "${replaced.statement.length > 300 ? `${replaced.statement.slice(0, 299)}…` : replaced.statement}"`;
  const replaces =
    decision.supersedes === null
      ? ""
      : ` It replaces decision ${String(decision.supersedes)}${quoted}.`;
  return because === undefined
    ? `**Recorded as decision ${String(decision.number)}:** ${decision.statement}\n\n_Decided by ${who}.${reason}${replaces}_`
    : `**Proposed decision ${String(decision.number)}:** ${decision.statement}\n\n_Decided by ${who}.${reason}${replaces} It is only proposed because ${because}: press Confirm if the team has decided this._`;
}

/**
 * Records a decision made in the thread (slice 2.2, decision 192). The API decides its status:
 * active only when the person who decided it sent the message the turn is answering, the agent
 * says they asked for it to be recorded, and the session read nothing untrusted first (the
 * start rule, 181 and 189). Otherwise it is proposed, and posted with Confirm.
 */
async function recordDecisionFor(
  db: Db,
  conversationId: string,
  context: ToolCallContext,
  call: CustomToolCall,
  messages: readonly ProcessedUserMessage[],
  events: readonly AgentEvent[],
  input: RecordDecisionInput,
  routing: Routing,
): Promise<CustomToolAnswer> {
  const decider = {
    source: context.source,
    workspaceId: context.workspaceId,
    actorId: input.decidedBy.actorId,
  };
  if (!(await hasWrittenInConversation(db, conversationId, decider))) {
    return error(toolErrors.notInThread);
  }
  const turn =
    call.processedAt === null
      ? undefined
      : await readTurnMessage(db, conversationId, call.processedAt, messages);
  // Every message of the call's own turn must be the decider's, and none may have come with
  // other people's words from the thread: anyone else's text could have steered the call.
  const senders = await readTurnSenders(db, conversationId, turnMessages(events, call.id));
  const deciderAlone =
    senders.actorIds.length > 0 &&
    senders.actorIds.every((actorId) => actorId === input.decidedBy.actorId);
  const replaced =
    input.supersedes === undefined ? undefined : await findDecisionByNumber(db, input.supersedes);
  const ordinary = proposedBecause({
    deciderIsAsker: deciderAlone && turn?.actorId === input.decidedBy.actorId,
    askedToRecord: input.askedToRecord,
    untrustedRead: startReason(events, call.id),
    othersInTurn: senders.carriedContext,
  });
  // Replacing an active decision waits for its deciders (decision 208), unless it would be
  // active anyway, which proves the decider is the asker, and the asker is one of them. The
  // decider the model names is not trusted on its own (from the review of 3.2).
  const deciders =
    replaced?.status === "active"
      ? await replacementDeciders(db, context, replaced, routing)
      : undefined;
  const exempt =
    ordinary === undefined && deciders?.some((d) => d.actorId === input.decidedBy.actorId) === true;
  const guarded = replaced !== undefined && deciders !== undefined && !exempt;
  const because = guarded
    ? proposedBecause({ ...noConditions, replaces: replaced.number })
    : ordinary;
  const deciderName = await actorNameInConversation(db, conversationId, input.decidedBy.actorId);
  const result = await recordDecision(db, {
    customToolUseId: call.id,
    conversationId,
    messageId: turn?.actorId === input.decidedBy.actorId ? turn.messageId : null,
    statement: input.statement,
    reason: input.reason,
    area: input.area === undefined ? undefined : input.area.toLowerCase(),
    decidedBy: { ...decider, name: deciderName },
    status: because === undefined ? "active" : "proposed",
    supersedes: input.supersedes,
    guard: !guarded
      ? undefined
      : {
          deciders: deciders.map((d) => d.actorId),
          area: replaced.area,
          summary: `Replace decision ${String(replaced.number)} ("${replaced.statement.slice(0, 200)}") with: ${input.statement}`,
          positions: [
            {
              actorId: input.decidedBy.actorId,
              name: deciderName,
              says: input.statement,
            },
            ...(replaced.decidedBy.actorId === null
              ? []
              : [
                  {
                    actorId: replaced.decidedBy.actorId,
                    name: replaced.decidedBy.name,
                    says: replaced.statement,
                  },
                ]),
          ],
        },
  });
  if (result.kind === "no_superseded") {
    return error(toolErrors.noActiveDecision(input.supersedes ?? 0));
  }
  const { decision } = result;
  const proposed = decision.status === "proposed";
  // In an area that exists, the post names its owner (slice 3.1), who may confirm a proposal.
  const area =
    decision.area === null
      ? undefined
      : await findAreaByName(db, context, decision.area).catch((failure: unknown): undefined => {
          routing.log?.error("areas.decision_failed", { conversationId, error: failure });
          return undefined;
        });
  // A guarded replacement names who decides it instead (decision 208), from what was stored,
  // so answering the call again posts what was decided the first time.
  const stored = await storedDeciders(db, decision.id);
  const guard =
    stored === null || replaced === undefined
      ? undefined
      : result.kind === "recorded" && deciders !== undefined
        ? deciders
        : rolesFromStored(stored, replaced, routing.fallback);
  const owner =
    guard !== undefined && replaced !== undefined
      ? replacementLines(replaced, guard)
      : area === undefined
        ? undefined
        : ownerLines([area], routing.fallback);
  // Queued under the decision's id, so answering the call again posts it once.
  const conversation = await getConversation(db, conversationId);
  const text = decisionForThread(
    decision,
    proposed
      ? guard !== undefined && replaced !== undefined
        ? proposedBecause({ ...noConditions, replaces: replaced.number })
        : (because ?? "it is a proposal")
      : undefined,
    replaced === undefined ? undefined : { number: replaced.number, statement: replaced.statement },
  );
  await enqueueDelivery(db, conversationId, `decision:${decision.id}`, "note", {
    kind: "decision",
    target: { ...conversation.key },
    decisionId: decision.id,
    // The owner first: an unclosed code block in the statement cannot swallow it.
    text: owner === undefined || owner.text === "" ? text : `${owner.text}\n\n${text}`,
    needsConfirm: proposed,
    ...(owner === undefined || owner.mentions.length === 0 ? {} : { mentions: owner.mentions }),
  });
  const output: RecordDecisionOutput = {
    number: decision.number,
    status: proposed ? "proposed" : "active",
  };
  return { text: JSON.stringify(output), isError: false };
}

/** Searches the active decisions for the agent (slice 2.2). */
async function recallDecisions(db: Db, input: RecallDecisionsInput): Promise<CustomToolAnswer> {
  const found = await searchDecisions(db, {
    query: input.query,
    area: input.area,
    limit: input.limit ?? 10,
  });
  return {
    text: JSON.stringify({ decisions: found.map(decisionForAgent) }),
    isError: false,
  };
}

/** A decision as the agent reads it: what, why, who, when and where, to cite. */
export function decisionForAgent(decision: Decision) {
  return {
    number: decision.number,
    statement: decision.statement,
    ...(decision.reason === null ? {} : { reason: decision.reason }),
    ...(decision.area === null ? {} : { area: decision.area }),
    decidedBy: decision.decidedBy.name ?? decision.decidedBy.actorId,
    decidedOn: decision.decidedAt.slice(0, 10),
    where:
      decision.origin === "import"
        ? `the planning log, entry ${decision.originRef ?? "?"}`
        : decision.messageId === null
          ? "a thread"
          : `a thread, message ${decision.messageId}`,
  };
}

/**
 * The start rule (slice 2.1, decision 181; G18): a brief needs a person to start it when the
 * session called any MCP tool (Jira, Confluence) or read git refs other than `main` (decision
 * 189) before writing it, since what it read there may have shaped the brief. Undefined when no one needs to. Read from the session's events,
 * not from the agent; if the call is not among them, a person must start it (fail closed).
 */
export function startReason(events: readonly AgentEvent[], callId: string): string | undefined {
  const index = events.findIndex((event) => event.id === callId);
  if (index < 0) return "could not tell what was read before this brief";
  const tools = [
    ...new Set(
      events.slice(0, index).flatMap((event) => {
        if (event.kind === "mcp_tool_use") return [`${event.server}.${event.name}`];
        // Refs anyone on GitHub can write: a fork's pull request, say (G18, decision 189).
        if (event.kind === "git_read") return ["git (refs other than main)"];
        return [];
      }),
    ),
  ];
  return tools.length === 0 ? undefined : `read with ${tools.join(", ")}`;
}

/**
 * The user messages of the call's own turn: processed after the last turn that ended before
 * the call. A message from an earlier turn that is still waiting (its turn's end not yet
 * synced) is not the call's, so it is not linked to the brief.
 */
export function turnMessages(events: readonly AgentEvent[], callId: string): string[] {
  const index = events.findIndex((event) => event.id === callId);
  if (index < 0) return [];
  const before = events.slice(0, index);
  const lastEnd = before.findLastIndex(
    (event) =>
      event.kind === "terminated" || (event.kind === "idle" && event.reason !== "requires_action"),
  );
  return before
    .slice(lastEnd + 1)
    .flatMap((event) => (event.kind === "user_message" && event.processed ? [event.id] : []));
}

/** The brief as people read it in the thread, with whether someone must start it. */
export function briefForThread(brief: StartChangeInput, reason: string | undefined): string {
  const links = brief.links.length === 0 ? "" : `\n**Links:** ${brief.links.join(", ")}`;
  const status =
    reason === undefined
      ? "_Handed to the coding worker._"
      : `_I ${reason} before writing this, so someone needs to press Start before the ` +
        "coding worker gets it._";
  return (
    `**Brief for the coding worker: ${brief.title}**\n\n**What:** ${brief.what}\n\n` +
    `**Why:** ${brief.why}\n\n**Done when:** ${brief.doneWhen}${links}\n\n${status}`
  );
}

/**
 * Writes a brief for a coding worker and posts it in the thread (decisions 181, 184). The
 * change is for the sender of the message the turn is answering; the messages of that turn
 * wait for the worker. A brief that needs no person goes to the worker after this sync.
 */
async function startChange(
  db: Db,
  conversationId: string,
  context: ToolCallContext,
  call: CustomToolCall,
  messages: readonly ProcessedUserMessage[],
  events: readonly AgentEvent[],
  input: StartChangeInput,
  routing: Routing,
): Promise<CustomToolAnswer> {
  const callAt = call.processedAt === null ? Number.NaN : Date.parse(call.processedAt);
  const requesterId = Number.isNaN(callAt)
    ? undefined
    : await readTurnSender(db, conversationId, call.processedAt ?? "", messages);
  if (requesterId === undefined) return error(toolErrors.noRequester);
  const reason = startReason(events, call.id);
  const result = await createBrief(db, {
    conversationId,
    customToolUseId: call.id,
    changeId: input.changeId,
    requestedBy: {
      source: context.source,
      workspaceId: context.workspaceId,
      actorId: requesterId,
      name: await actorNameInConversation(db, conversationId, requesterId),
    },
    brief: input,
    startReason: reason,
    turnEventIds: turnMessages(events, call.id).filter((eventId) =>
      messages.some(
        (message) => message.eventId === eventId && Date.parse(message.processedAt) <= callAt,
      ),
    ),
  });
  if (result.kind === "no_change") return error(toolErrors.noChange(input.changeId ?? ""));
  if (result.kind === "stopped") return error(toolErrors.changeStopped);
  // Queued under the brief's id, so answering the call again posts it once.
  const conversation = await getConversation(db, conversationId);
  await enqueueDelivery(db, conversationId, `brief:${result.briefId}`, "note", {
    kind: "brief",
    target: { ...conversation.key },
    briefId: result.briefId,
    text: briefForThread(input, reason),
    needsStart: reason !== undefined,
  });
  // The areas the brief touches, named once per change with their owners (slice 3.1). Queued
  // after the brief, so they read under it. Optional: a failure is reported, never blocks.
  await nameBriefAreas(db, conversationId, context, input, result, routing).catch(
    (failure: unknown) => {
      routing.log?.error("areas.brief_failed", { conversationId, error: failure });
    },
  );
  const output: StartChangeOutput = {
    changeId: result.changeId,
    briefId: result.briefId,
    status: result.started ? "started" : "waiting_for_start",
  };
  return { text: JSON.stringify(output), isError: false };
}

/**
 * Names the areas a brief touches, with their owners, once per change (slice 3.1): those the
 * teammate named and those its words and paths match.
 */
async function nameBriefAreas(
  db: Db,
  conversationId: string,
  context: ToolCallContext,
  input: StartChangeInput,
  result: { changeId: string; briefId: string },
  routing: Routing,
): Promise<void> {
  const areas = await listAreas(db, context);
  if (areas.length === 0) return;
  const named = new Set((input.areas ?? []).map((name) => name.trim().toLowerCase()));
  const touched = [
    ...new Map(
      [
        ...areas.filter((area) => named.has(area.name)),
        ...areasInText(
          areas,
          [input.title, input.what, input.why, input.doneWhen, ...input.links].join("\n"),
        ),
      ].map((area) => [area.id, area]),
    ).values(),
  ];
  await nameChangeAreas(
    { db, deliverers: {} },
    {
      conversationId,
      changeId: result.changeId,
      areas: touched,
      via: "brief",
      key: `areas:${result.changeId}:brief:${result.briefId}`,
      fallback: routing.fallback,
    },
    routing.log,
  );
}

/**
 * Links the thread to a project: one that exists, or a new one in `plan`, made for the sender
 * of the message the turn is answering: the latest the session processed at or before the call.
 */
async function linkProject(
  db: Db,
  conversationId: string,
  context: ToolCallContext,
  call: CustomToolCall,
  messages: readonly ProcessedUserMessage[],
  input: LinkProjectInput,
): Promise<CustomToolAnswer> {
  let project: Project;
  if (input.name !== undefined) {
    const senderId =
      call.processedAt === null
        ? undefined
        : await readTurnSender(db, conversationId, call.processedAt, messages);
    if (senderId === undefined) return error(toolErrors.noSender);
    project = await createProject(
      db,
      {
        name: input.name,
        createdBy: { source: context.source, workspaceId: context.workspaceId, actorId: senderId },
      },
      call.id,
    );
  } else {
    const projectId = input.projectId ?? "";
    const found = await getProject(db, projectId);
    if (found === undefined) return error(toolErrors.noProject(projectId));
    project = found.project;
  }
  const linked = await setConversationProject(db, conversationId, project.id);
  if (linked.kind === "no_project") return error(toolErrors.noProject(project.id));
  if (linked.kind === "no_conversation") throw new Error(`no conversation ${conversationId}`);
  const output: LinkProjectOutput = {
    projectId: project.id,
    name: project.name,
    stage: project.stage,
  };
  return { text: JSON.stringify(output), isError: false };
}

/** Records an approval or withdrawal for the thread's project. */
async function recordApprovalFor(
  db: Db,
  conversationId: string,
  context: ToolCallContext,
  callId: string,
  input: RecordApprovalInput,
): Promise<CustomToolAnswer> {
  if (context.projectId === null) return error(toolErrors.notLinked);
  const actor = {
    source: context.source,
    workspaceId: context.workspaceId,
    actorId: input.actor.actorId,
  };
  if (!(await hasWrittenInConversation(db, conversationId, actor))) {
    return error(toolErrors.notInThread);
  }
  const result = await recordApproval(
    db,
    context.projectId,
    {
      subject: input.subject,
      subjectRef: input.subjectRef,
      subjectVersion: input.subjectVersion,
      action: input.action,
      actor,
      conversationId,
    },
    callId,
  );
  if (result.kind === "no_project") return error(toolErrors.notLinked);
  if (result.kind === "no_conversation") throw new Error(`no conversation ${conversationId}`);
  const { approval } = result;
  const output: RecordApprovalOutput = {
    approvalId: approval.id,
    subjectApproved: isApproved(
      await listApprovals(db, approval.projectId),
      approval.subject,
      approval.subjectRef,
    ),
  };
  return { text: JSON.stringify(output), isError: false };
}

function error(text: string): CustomToolAnswer {
  return { text, isError: true };
}

/** A short reason the input was refused: each problem's path and message, kept brief. */
function invalid(tool: string, problem: z.ZodError): CustomToolAnswer {
  const issues = problem.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.join(".");
      return path === "" ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");
  return error(clip(`invalid input for ${tool}: ${issues}`, 500));
}

function clip(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}
