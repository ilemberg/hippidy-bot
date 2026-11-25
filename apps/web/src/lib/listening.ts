import { randomUUID } from "node:crypto";
import type { Decision, ListeningList } from "@hippidy/contracts";
import { fetchCapturedProposals, fetchListening, type ApiResult } from "./api-client.ts";
import { signedInPerson, type HomeDeps } from "./home.ts";
import type { Person } from "./tokens.ts";

/** What the page about listening shows (slice 2.5, G9). */
export type ListeningView =
  | { kind: "unconfigured" }
  | { kind: "signed_out" }
  | {
      kind: "signed_in";
      person: Person;
      listening: ApiResult<ListeningList>;
      /** Decisions proposed from listening, waiting for someone in their thread. */
      proposals: ApiResult<Decision[]>;
      readAt: string;
    };

/** Reads the session cookie and, for a signed-in person, where the bot listens and what it found. */
export async function loadListening(
  input: { sessionCookie: string | undefined },
  deps: HomeDeps,
): Promise<ListeningView> {
  const config = deps.config;
  if (config === undefined) return { kind: "unconfigured" };
  const now = deps.now?.() ?? new Date();
  const person = await signedInPerson(input.sessionCookie, config, now);
  if (person === undefined) return { kind: "signed_out" };
  const correlationId = randomUUID();
  const client = {
    fetch: deps.fetch,
    apiBaseUrl: config.apiBaseUrl,
    apiSecret: config.apiSecret,
    log: deps.log.child({ correlationId, actorId: person.actorId }),
    correlationId,
    now: () => now,
  };
  const [listening, proposals] = await Promise.all([
    fetchListening(person, client),
    fetchCapturedProposals(person, client),
  ]);
  return { kind: "signed_in", person, listening, proposals, readAt: now.toISOString() };
}
