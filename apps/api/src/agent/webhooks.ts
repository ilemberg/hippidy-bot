import { Anthropic } from "@anthropic-ai/sdk";

export interface AgentWebhookEvent {
  /** Same for every retry of one event. */
  id: string;
  /** For example `session.status_idled`. */
  type: string;
  /** The id of the resource the event is about, for session events the session id. */
  resourceId: string;
}

/** Checks a webhook's signature and returns its event; throws if it is not genuine. */
export type VerifyAgentWebhook = (
  body: string,
  headers: Record<string, string>,
) => AgentWebhookEvent;

/**
 * Verifies Anthropic's webhook signatures with the SDK (signature and a five-minute freshness
 * check), using the endpoint's `whsec_` signing key.
 */
export function createWebhookVerifier(signingKey: string, client: Anthropic): VerifyAgentWebhook {
  return (body, headers) => {
    const event = client.beta.webhooks.unwrap(body, { headers, key: signingKey });
    return { id: event.id, type: event.data.type, resourceId: event.data.id };
  };
}
