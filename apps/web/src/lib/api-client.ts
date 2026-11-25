import {
  CORRELATION_ID_HEADER,
  decisionListSchema,
  listeningListSchema,
  sessionListSchema,
  type Decision,
  type ListeningList,
  type SessionActivity,
} from "@hippidy/contracts";
import type { z } from "zod";
import type { Logger } from "./log.ts";
import type { Fetch } from "./slack-oidc.ts";
import { mintApiToken, type Person } from "./tokens.ts";

// The web app talks to the system only through the API (decision 22), from its server, as
// the signed-in person (decision 194). The service token is never here.

export interface ApiClientDeps {
  fetch: Fetch;
  apiBaseUrl: string;
  apiSecret: string;
  log: Logger;
  correlationId: string;
  now?: () => Date;
}

/** What a read from the API gave: its parsed body, or why there is none. */
export type ApiResult<T> = { kind: "ok"; value: T } | { kind: "failed"; reason: string };

/** A `GET` from the API as the person, its body checked against the contract. */
export async function apiGet<T>(
  person: Person,
  route: string,
  schema: z.ZodType<T>,
  deps: ApiClientDeps,
): Promise<ApiResult<T>> {
  const token = await mintApiToken(person, deps.apiSecret, deps.now?.() ?? new Date());
  let res: Response;
  try {
    res = await deps.fetch(new URL(route, deps.apiBaseUrl).toString(), {
      headers: { authorization: `Bearer ${token}`, [CORRELATION_ID_HEADER]: deps.correlationId },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    deps.log.error("api.request_failed", { route, error });
    return { kind: "failed", reason: "unreachable" };
  }
  if (!res.ok) {
    deps.log.warn("api.refused", { route, status: res.status });
    return { kind: "failed", reason: `status_${res.status}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    deps.log.error("api.unexpected_response", { route });
    return { kind: "failed", reason: "unexpected_response" };
  }
  return { kind: "ok", value: parsed.data };
}

/** `GET /v1/sessions` as the person: the latest agents at work (slice 2.4). */
export async function fetchSessions(
  person: Person,
  limit: number,
  deps: ApiClientDeps,
): Promise<ApiResult<SessionActivity[]>> {
  const result = await apiGet(person, `/v1/sessions?limit=${limit}`, sessionListSchema, deps);
  return result.kind === "ok" ? { kind: "ok", value: result.value.sessions } : result;
}

/** `GET /v1/listening` as the person: where the bot listens (slice 2.5, G9). */
export function fetchListening(
  person: Person,
  deps: ApiClientDeps,
): Promise<ApiResult<ListeningList>> {
  return apiGet(person, "/v1/listening", listeningListSchema, deps);
}

/** `GET /v1/decisions` for the proposals made from listening, newest first. */
export async function fetchCapturedProposals(
  person: Person,
  deps: ApiClientDeps,
): Promise<ApiResult<Decision[]>> {
  const result = await apiGet(
    person,
    "/v1/decisions?status=proposed&origin=capture&limit=50",
    decisionListSchema,
    deps,
  );
  return result.kind === "ok" ? { kind: "ok", value: result.value.decisions } : result;
}
