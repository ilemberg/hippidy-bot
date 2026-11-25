import {
  CORRELATION_ID_HEADER,
  decisionActionResultSchema,
  decisionDetailSchema,
  decisionListSchema,
  listeningListSchema,
  sessionListSchema,
  type Decision,
  type DecisionActionResult,
  type DecisionDetail,
  type DecisionStatus,
  type EditDecisionRequest,
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

/** What a call to the API gave: its parsed body, or why there is none. */
export type ApiResult<T> = { kind: "ok"; value: T } | { kind: "failed"; reason: string };

/** A call to the API as the person, its answer checked against the contract. */
async function call<T>(
  person: Person,
  route: string,
  request: { method: "GET" } | { method: "POST" | "PATCH"; body: unknown },
  schema: z.ZodType<T>,
  deps: ApiClientDeps,
): Promise<ApiResult<T>> {
  const token = await mintApiToken(person, deps.apiSecret, deps.now?.() ?? new Date());
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    [CORRELATION_ID_HEADER]: deps.correlationId,
  };
  let res: Response;
  try {
    res = await deps.fetch(new URL(route, deps.apiBaseUrl).toString(), {
      method: request.method,
      ...(request.method === "GET"
        ? { headers }
        : {
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify(request.body),
          }),
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

/** A `GET` from the API as the person, its body checked against the contract. */
export function apiGet<T>(
  person: Person,
  route: string,
  schema: z.ZodType<T>,
  deps: ApiClientDeps,
): Promise<ApiResult<T>> {
  return call(person, route, { method: "GET" }, schema, deps);
}

/**
 * A `POST` or `PATCH` to the API as the person, with a JSON body (slice 2.6: the web app's first
 * writes). Who acts comes from the person token, never from the body.
 */
export function apiSend<T>(
  person: Person,
  method: "POST" | "PATCH",
  route: string,
  body: unknown,
  schema: z.ZodType<T>,
  deps: ApiClientDeps,
): Promise<ApiResult<T>> {
  return call(person, route, { method, body }, schema, deps);
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

/** What `GET /v1/decisions` is asked for: words to search for, a status, where from, how many. */
export interface DecisionsQuery {
  q?: string;
  status?: DecisionStatus;
  origin?: Decision["origin"];
  limit?: number;
}

/** `GET /v1/decisions` as the person: the decisions on record, newest or best matching first. */
export async function fetchDecisions(
  person: Person,
  query: DecisionsQuery,
  deps: ApiClientDeps,
): Promise<ApiResult<Decision[]>> {
  const params = new URLSearchParams();
  if (query.q !== undefined) params.set("q", query.q);
  if (query.status !== undefined) params.set("status", query.status);
  if (query.origin !== undefined) params.set("origin", query.origin);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const search = params.toString();
  const result = await apiGet(
    person,
    `/v1/decisions${search === "" ? "" : `?${search}`}`,
    decisionListSchema,
    deps,
  );
  return result.kind === "ok" ? { kind: "ok", value: result.value.decisions } : result;
}

/** `GET /v1/decisions` for the proposals made from listening, newest first. */
export function fetchCapturedProposals(
  person: Person,
  deps: ApiClientDeps,
): Promise<ApiResult<Decision[]>> {
  return fetchDecisions(person, { status: "proposed", origin: "capture", limit: 50 }, deps);
}

/** A decision looked up by its number: found, not on record, or why the API gave nothing. */
export type DecisionLookup = ApiResult<DecisionDetail> | { kind: "not_found" };

/** `GET /v1/decisions/:number` as the person: one decision, its history, what they may do. */
export async function fetchDecision(
  person: Person,
  number: number,
  deps: ApiClientDeps,
): Promise<DecisionLookup> {
  const result = await apiGet(person, `/v1/decisions/${number}`, decisionDetailSchema, deps);
  return result.kind === "failed" && result.reason === "status_404"
    ? { kind: "not_found" }
    : result;
}

const decisionRoute = (decisionId: string) => `/v1/decisions/${encodeURIComponent(decisionId)}`;

/** `POST /v1/decisions/:id/confirm` as the person, whom the API takes from the token. */
export function confirmDecision(
  person: Person,
  decisionId: string,
  deps: ApiClientDeps,
): Promise<ApiResult<DecisionActionResult>> {
  const route = `${decisionRoute(decisionId)}/confirm`;
  return apiSend(person, "POST", route, {}, decisionActionResultSchema, deps);
}

/** `POST /v1/decisions/:id/reject` as the person. */
export function rejectDecision(
  person: Person,
  decisionId: string,
  deps: ApiClientDeps,
): Promise<ApiResult<DecisionActionResult>> {
  const route = `${decisionRoute(decisionId)}/reject`;
  return apiSend(person, "POST", route, {}, decisionActionResultSchema, deps);
}

/** `PATCH /v1/decisions/:id` as the person: a proposal's new wording. */
export function editDecision(
  person: Person,
  decisionId: string,
  edit: EditDecisionRequest,
  deps: ApiClientDeps,
): Promise<ApiResult<DecisionActionResult>> {
  const route = decisionRoute(decisionId);
  return apiSend(person, "PATCH", route, edit, decisionActionResultSchema, deps);
}
