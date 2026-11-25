import {
  customToolNameSchema,
  linkProjectInputSchema,
  recordApprovalInputSchema,
  startChangeInputSchema,
  type LinkProjectInput,
  type LinkProjectOutput,
  type Project,
  type RecordApprovalInput,
  type RecordApprovalOutput,
  type StartChangeInput,
  type StartChangeOutput,
} from "@hippidy/contracts";
import type { z } from "zod";
import type { AgentEvent } from "../agent/runtime.ts";
import { actorNameInConversation, createBrief } from "../store/changes.ts";
import { enqueueDelivery, getConversation } from "../store/conversations.ts";
import type { Db } from "../store/db.ts";
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
      return startChange(db, conversationId, context, call, messages, events, input.data);
    }
  }
}

/**
 * The start rule (slice 2.1, decision 181; G18): a brief needs a person to start it when the
 * session called any MCP tool (Jira, Confluence) before writing it, since what it read there
 * may have shaped the brief. Undefined when no one needs to. Read from the session's events,
 * not from the agent; if the call is not among them, a person must start it (fail closed).
 */
export function startReason(events: readonly AgentEvent[], callId: string): string | undefined {
  const index = events.findIndex((event) => event.id === callId);
  if (index < 0) return "could not tell what was read before this brief";
  const tools = [
    ...new Set(
      events
        .slice(0, index)
        .flatMap((event) =>
          event.kind === "mcp_tool_use" ? [`${event.server}.${event.name}`] : [],
        ),
    ),
  ];
  return tools.length === 0 ? undefined : `read with ${tools.join(", ")}`;
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
    turnEventIds: messages
      .filter((message) => Date.parse(message.processedAt) <= callAt)
      .map((message) => message.eventId),
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
  const output: StartChangeOutput = {
    changeId: result.changeId,
    briefId: result.briefId,
    status: result.started ? "started" : "waiting_for_start",
  };
  return { text: JSON.stringify(output), isError: false };
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
