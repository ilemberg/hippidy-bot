import type {
  ConfirmDecisionRequest,
  ConfirmDecisionResult,
  DecisionActionResult,
  DecisionDetail,
  EditDecisionRequest,
} from "@hippidy/contracts";
import type { Logger } from "../log.ts";
import { getConversation } from "../store/conversations.ts";
import type { Db } from "../store/db.ts";
import {
  actOnProposal,
  confirmDecision,
  decisionHistory,
  findDecisionByNumber,
  mayAct,
  type DecisionActor,
  type ProposalOutcome,
} from "../store/decisions.ts";
import { flushSoon, queue, targetOf, type ConversationDeps } from "./conversations.ts";

// A person confirms, rejects or rewords a proposed decision (slices 2.2 and 2.6, decisions
// 192, 201 and 202): from Slack, where it was posted, or from the web app's wiki. One rule
// decides who may, wherever they press.

export const decisionTexts = {
  confirmed: (number: number, name: string, replaced?: { number: number; stillActive: boolean }) =>
    `Decision ${String(number)} confirmed by ${name}. It is on record now.` +
    (replaced === undefined
      ? ""
      : replaced.stillActive
        ? ` It replaces decision ${String(replaced.number)}.`
        : ` Decision ${String(replaced.number)}, which it was to replace, had already been replaced or withdrawn, so it was left as it was.`),
  rejected: (number: number, name: string) =>
    `Decision ${String(number)} rejected by ${name}. It is not on record.`,
} as const;

function actionResult(outcome: ProposalOutcome): DecisionActionResult {
  return outcome.status === "not_allowed"
    ? { status: "not_allowed", reason: outcome.reason }
    : { status: outcome.status };
}

export async function confirmDecisionByPerson(
  deps: ConversationDeps,
  decisionId: string,
  request: ConfirmDecisionRequest,
  log: Logger,
): Promise<ConfirmDecisionResult> {
  const name = request.actor.displayName ?? `${request.source} user ${request.actor.id}`;
  const result = await confirmDecision(deps.db, decisionId, {
    source: request.source,
    workspaceId: request.workspaceId,
    actorId: request.actor.id,
    name: request.actor.displayName ?? null,
  });
  log.info("decision.confirm", { decisionId, status: result.status });
  // Said once, under a key of its own: if saying it failed after the confirmation committed, a
  // second press (which finds the decision no longer proposed) says it then.
  const decision =
    result.status === "confirmed" || result.status === "not_proposed" ? result.decision : undefined;
  if (decision?.confirmedBy != null && decision.conversationId !== null) {
    const conversation = await getConversation(deps.db, decision.conversationId);
    await queue(deps, conversation, `confirmed:${decisionId}`, "note", {
      kind: "reply",
      target: targetOf(conversation),
      text: decisionTexts.confirmed(
        decision.number,
        decision.confirmedBy.name ?? name,
        result.replaced,
      ),
    });
    await flushSoon(deps, conversation.id, log);
  }
  return actionResult(result);
}

/**
 * A person rejects a proposal. One the teammate recorded is noted in its thread; one from
 * listening is not, since nothing is posted in a thread that did not mention the bot (176).
 */
export async function rejectDecisionByPerson(
  deps: ConversationDeps,
  decisionId: string,
  person: DecisionActor,
  log: Logger,
): Promise<DecisionActionResult> {
  const result = await actOnProposal(deps.db, decisionId, person, { kind: "reject" });
  log.info("decision.reject", { decisionId, status: result.status });
  if (result.status === "rejected" && result.decision.conversationId !== null) {
    const conversation = await getConversation(deps.db, result.decision.conversationId);
    await queue(deps, conversation, `rejected:${decisionId}`, "note", {
      kind: "reply",
      target: targetOf(conversation),
      text: decisionTexts.rejected(
        result.decision.number,
        person.name ?? `${person.source} user ${person.actorId}`,
      ),
    });
    await flushSoon(deps, conversation.id, log);
  }
  return actionResult(result);
}

/** A person rewords a proposal before it is confirmed. Nothing is posted. */
export async function editDecisionByPerson(
  db: Db,
  decisionId: string,
  person: DecisionActor,
  edit: EditDecisionRequest,
  log: Logger,
): Promise<DecisionActionResult> {
  const result = await actOnProposal(db, decisionId, person, { kind: "edit", edit });
  log.info("decision.edit", { decisionId, status: result.status });
  return actionResult(result);
}

/** A decision by its number, its history, and whether the person may act on it. */
export async function decisionDetail(
  db: Db,
  number: number,
  person: DecisionActor | undefined,
): Promise<DecisionDetail | undefined> {
  const decision = await findDecisionByNumber(db, number);
  if (decision === undefined) return undefined;
  const youMay =
    person === undefined ? { act: false, reason: null } : await mayAct(db, decision.id, person);
  return { decision, history: await decisionHistory(db, decision.id), youMay };
}
