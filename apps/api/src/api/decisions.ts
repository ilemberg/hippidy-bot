import type { ConfirmDecisionRequest, ConfirmDecisionResult } from "@hippidy/contracts";
import type { Logger } from "../log.ts";
import { getConversation } from "../store/conversations.ts";
import { confirmDecision } from "../store/decisions.ts";
import { flushSoon, queue, targetOf, type ConversationDeps } from "./conversations.ts";

// A person confirms a proposed decision (slice 2.2, decision 192), from the source it was
// posted in: `POST /v1/decisions/:decisionId/confirm`.

export const decisionTexts = {
  confirmed: (number: number, name: string, replaced?: { number: number; stillActive: boolean }) =>
    `Decision ${String(number)} confirmed by ${name}. It is on record now.` +
    (replaced === undefined
      ? ""
      : replaced.stillActive
        ? ` It replaces decision ${String(replaced.number)}.`
        : ` Decision ${String(replaced.number)}, which it was to replace, had already been replaced or withdrawn, so it was left as it was.`),
} as const;

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
  const confirmed =
    result.status === "confirmed" ||
    (result.status === "not_proposed" && result.decision?.confirmedBy != null);
  if (confirmed && result.decision !== undefined && result.decision.conversationId !== null) {
    const conversation = await getConversation(deps.db, result.decision.conversationId);
    await queue(deps, conversation, `confirmed:${decisionId}`, "note", {
      kind: "reply",
      target: targetOf(conversation),
      text: decisionTexts.confirmed(
        result.decision.number,
        result.decision.confirmedBy?.name ?? name,
        result.replaced,
      ),
    });
    await flushSoon(deps, conversation.id, log);
  }
  return { status: result.status };
}
