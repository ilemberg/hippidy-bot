import {
  areaActionResultSchema,
  areaDetailSchema,
  areaListSchema,
  conflictDetailSchema,
  conflictListSchema,
  CORRELATION_ID_HEADER,
  decisionActionResultSchema,
  decisionDetailSchema,
  decisionListSchema,
  goalActionResultSchema,
  jobActionResultSchema,
  jobDetailSchema,
  jobListSchema,
  listeningListSchema,
  myBriefSchema,
  peopleListSchema,
  scorecardSchema,
  sessionListSchema,
  setBriefsResultSchema,
  settleConflictResultSchema,
  taskActionResultSchema,
  taskDetailSchema,
  taskListSchema,
  waitActionResultSchema,
  waitListSchema,
  type AreaActionResult,
  type AreaDetail,
  type AreaList,
  type Conflict,
  type ConflictDetail,
  type CreateAreaRequest,
  type CreateGoalRequest,
  type CreateTaskRequest,
  type CreateWaitRequest,
  type Decision,
  type DecisionActionResult,
  type DecisionDetail,
  type DecisionStatus,
  type EditAreaRequest,
  type EditDecisionRequest,
  type EditGoalRequest,
  type EditJobRequest,
  type GoalActionResult,
  type EditTaskRequest,
  type JobActionResult,
  type JobDetail,
  type JobList,
  type ListeningList,
  type MyBrief,
  type PeopleList,
  type Scorecard,
  type SessionActivity,
  type SetBriefsResult,
  type SettleConflictRequest,
  type SettleConflictResult,
  type TaskActionResult,
  type TaskDetail,
  type TaskList,
  type Wait,
  type WaitActionResult,
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
  status?: DecisionStatus | "all";
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
  wordingVersion: number,
  deps: ApiClientDeps,
): Promise<ApiResult<DecisionActionResult>> {
  const route = `${decisionRoute(decisionId)}/confirm`;
  return apiSend(person, "POST", route, { wordingVersion }, decisionActionResultSchema, deps);
}

/** `POST /v1/decisions/:id/reject` as the person. */
export function rejectDecision(
  person: Person,
  decisionId: string,
  wordingVersion: number,
  deps: ApiClientDeps,
): Promise<ApiResult<DecisionActionResult>> {
  const route = `${decisionRoute(decisionId)}/reject`;
  return apiSend(person, "POST", route, { wordingVersion }, decisionActionResultSchema, deps);
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

/** `GET /v1/areas` as the person: every area of the workspace, and who decides for the unowned. */
export function fetchAreas(person: Person, deps: ApiClientDeps): Promise<ApiResult<AreaList>> {
  return apiGet(person, "/v1/areas", areaListSchema, deps);
}

/** An area looked up by its name: found, not on record, or why the API gave nothing. */
export type AreaLookup = ApiResult<AreaDetail> | { kind: "not_found" };

/** `GET /v1/areas/:name` as the person: one area and its history, oldest first. */
export async function fetchArea(
  person: Person,
  name: string,
  deps: ApiClientDeps,
): Promise<AreaLookup> {
  const route = `/v1/areas/${encodeURIComponent(name)}`;
  const result = await apiGet(person, route, areaDetailSchema, deps);
  return result.kind === "failed" && result.reason === "status_404"
    ? { kind: "not_found" }
    : result;
}

/** `GET /v1/people` as the person: the people the record knows, for choosing an owner. */
export async function fetchPeople(
  person: Person,
  deps: ApiClientDeps,
): Promise<ApiResult<PeopleList["people"]>> {
  const result = await apiGet(person, "/v1/people", peopleListSchema, deps);
  return result.kind === "ok" ? { kind: "ok", value: result.value.people } : result;
}

/** `POST /v1/areas` as the person, whom the API takes from the token. */
export function createArea(
  person: Person,
  area: CreateAreaRequest,
  deps: ApiClientDeps,
): Promise<ApiResult<AreaActionResult>> {
  return apiSend(person, "POST", "/v1/areas", area, areaActionResultSchema, deps);
}

/** `PATCH /v1/areas/:id` as the person: what changes, on the version the form showed. */
export function editArea(
  person: Person,
  areaId: string,
  edit: EditAreaRequest,
  deps: ApiClientDeps,
): Promise<ApiResult<AreaActionResult>> {
  const route = `/v1/areas/${encodeURIComponent(areaId)}`;
  return apiSend(person, "PATCH", route, edit, areaActionResultSchema, deps);
}

/** What `GET /v1/conflicts` is asked for: which status, bearing on which decision, how many. */
export interface ConflictsQuery {
  status?: "open" | "settled" | "all";
  decision?: number;
  limit?: number;
}

/** `GET /v1/conflicts` as the person: open ones first, newest first (slice 3.2). */
export async function fetchConflicts(
  person: Person,
  query: ConflictsQuery,
  deps: ApiClientDeps,
): Promise<ApiResult<Conflict[]>> {
  const params = new URLSearchParams();
  if (query.status !== undefined) params.set("status", query.status);
  if (query.decision !== undefined) params.set("decision", String(query.decision));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const search = params.toString();
  const result = await apiGet(
    person,
    `/v1/conflicts${search === "" ? "" : `?${search}`}`,
    conflictListSchema,
    deps,
  );
  return result.kind === "ok" ? { kind: "ok", value: result.value.conflicts } : result;
}

/** A conflict looked up by its number: found, not on record, or why the API gave nothing. */
export type ConflictLookup = ApiResult<ConflictDetail> | { kind: "not_found" };

/** `GET /v1/conflicts/:number` as the person: one conflict, and whether they may settle it. */
export async function fetchConflict(
  person: Person,
  number: number,
  deps: ApiClientDeps,
): Promise<ConflictLookup> {
  const result = await apiGet(person, `/v1/conflicts/${number}`, conflictDetailSchema, deps);
  return result.kind === "failed" && result.reason === "status_404"
    ? { kind: "not_found" }
    : result;
}

/** `POST /v1/conflicts/:id/settle` as the person, whom the API takes from the token. */
export function settleConflict(
  person: Person,
  conflictId: string,
  settle: SettleConflictRequest,
  deps: ApiClientDeps,
): Promise<ApiResult<SettleConflictResult>> {
  const route = `/v1/conflicts/${encodeURIComponent(conflictId)}/settle`;
  return apiSend(person, "POST", route, settle, settleConflictResultSchema, deps);
}

/** What `GET /v1/tasks` is asked for: words to search for, which status, how many. */
export interface TasksQuery {
  q?: string;
  status?: "open" | "todo" | "doing" | "done" | "all";
  limit?: number;
}

/** `GET /v1/tasks` as the person: the provider's tasks, or why it gave none (slice 3.3). */
export function fetchTasks(
  person: Person,
  query: TasksQuery,
  deps: ApiClientDeps,
): Promise<ApiResult<TaskList>> {
  const params = new URLSearchParams();
  if (query.q !== undefined) params.set("q", query.q);
  if (query.status !== undefined) params.set("status", query.status);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const search = params.toString();
  return apiGet(person, `/v1/tasks${search === "" ? "" : `?${search}`}`, taskListSchema, deps);
}

/** A task looked up by its key: found, not in the provider, or why the API gave nothing. */
export type TaskLookup = ApiResult<TaskDetail> | { kind: "not_found" };

/** `GET /v1/tasks/:key` as the person: one task, its threads and waits, and, built-in, more. */
export async function fetchTask(
  person: Person,
  key: string,
  deps: ApiClientDeps,
): Promise<TaskLookup> {
  const route = `/v1/tasks/${encodeURIComponent(key)}`;
  const result = await apiGet(person, route, taskDetailSchema, deps);
  return result.kind === "failed" && result.reason === "status_404"
    ? { kind: "not_found" }
    : result;
}

/** `POST /v1/tasks` as the person, whom the API takes from the token (built-in tracker only). */
export function createTask(
  person: Person,
  task: CreateTaskRequest,
  deps: ApiClientDeps,
): Promise<ApiResult<TaskActionResult>> {
  return apiSend(person, "POST", "/v1/tasks", task, taskActionResultSchema, deps);
}

/** `PATCH /v1/tasks/:id` as the person: what changes, on the version the form showed. */
export function editTask(
  person: Person,
  taskId: string,
  edit: EditTaskRequest,
  deps: ApiClientDeps,
): Promise<ApiResult<TaskActionResult>> {
  const route = `/v1/tasks/${encodeURIComponent(taskId)}`;
  return apiSend(person, "PATCH", route, edit, taskActionResultSchema, deps);
}

/** What `GET /v1/waits` is asked for: which status, a person's or a task's, how many. */
export interface WaitsQuery {
  status?: "open" | "ended" | "all";
  person?: string;
  task?: string;
  limit?: number;
}

/** `GET /v1/waits` as the person: who is waiting on whom (slice 3.3). */
export async function fetchWaits(
  person: Person,
  query: WaitsQuery,
  deps: ApiClientDeps,
): Promise<ApiResult<Wait[]>> {
  const params = new URLSearchParams();
  if (query.status !== undefined) params.set("status", query.status);
  if (query.person !== undefined) params.set("person", query.person);
  if (query.task !== undefined) params.set("task", query.task);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const search = params.toString();
  const result = await apiGet(
    person,
    `/v1/waits${search === "" ? "" : `?${search}`}`,
    waitListSchema,
    deps,
  );
  return result.kind === "ok" ? { kind: "ok", value: result.value.waits } : result;
}

/** `POST /v1/waits` as the person: their own wait, the waiter taken from the token. */
export function recordWait(
  person: Person,
  wait: CreateWaitRequest,
  deps: ApiClientDeps,
): Promise<ApiResult<WaitActionResult>> {
  return apiSend(person, "POST", "/v1/waits", wait, waitActionResultSchema, deps);
}

/** `POST /v1/waits/:id/end` as the person, who must be one of its people. */
export function endWait(
  person: Person,
  waitId: string,
  deps: ApiClientDeps,
): Promise<ApiResult<WaitActionResult>> {
  const route = `/v1/waits/${encodeURIComponent(waitId)}/end`;
  return apiSend(person, "POST", route, {}, waitActionResultSchema, deps);
}

/** `GET /v1/briefs/me` as the person: whether their briefs are on, and what one would say now. */
export function fetchMyBrief(person: Person, deps: ApiClientDeps): Promise<ApiResult<MyBrief>> {
  return apiGet(person, "/v1/briefs/me", myBriefSchema, deps);
}

/** `POST /v1/briefs/me` as the person: switch their own briefs on or off (slice 3.4). */
export function setMyBriefs(
  person: Person,
  on: boolean,
  deps: ApiClientDeps,
): Promise<ApiResult<SetBriefsResult>> {
  return apiSend(person, "POST", "/v1/briefs/me", { on }, setBriefsResultSchema, deps);
}

/** `GET /v1/jobs` as the person: the standing jobs, their state and this month's spend (4.1). */
export function fetchJobs(person: Person, deps: ApiClientDeps): Promise<ApiResult<JobList>> {
  return apiGet(person, "/v1/jobs", jobListSchema, deps);
}

/** `GET /v1/scorecard` as the person: the team's counts this week against last (slice 4.5). */
export function fetchScorecard(person: Person, deps: ApiClientDeps): Promise<ApiResult<Scorecard>> {
  return apiGet(person, "/v1/scorecard", scorecardSchema, deps);
}

/** A job looked up by its name: found, not on record, or why the API gave nothing. */
export type JobLookup = ApiResult<JobDetail> | { kind: "not_found" };

/** `GET /v1/jobs/:name` as the person: one job, its latest wakes and the changes people made. */
export async function fetchJob(
  person: Person,
  name: string,
  deps: ApiClientDeps,
): Promise<JobLookup> {
  const route = `/v1/jobs/${encodeURIComponent(name)}`;
  const result = await apiGet(person, route, jobDetailSchema, deps);
  return result.kind === "failed" && result.reason === "status_404"
    ? { kind: "not_found" }
    : result;
}

/** `PATCH /v1/jobs/:id` as the person: what changes, on the version the form showed (4.2). */
export function editJob(
  person: Person,
  jobId: string,
  edit: EditJobRequest,
  deps: ApiClientDeps,
): Promise<ApiResult<JobActionResult>> {
  const route = `/v1/jobs/${encodeURIComponent(jobId)}`;
  return apiSend(person, "PATCH", route, edit, jobActionResultSchema, deps);
}

/** `POST /v1/goals` as the person: a goal for a thread the bot is in, with its tickets (4.4). */
export function createGoal(
  person: Person,
  goal: CreateGoalRequest,
  deps: ApiClientDeps,
): Promise<ApiResult<GoalActionResult>> {
  return apiSend(person, "POST", "/v1/goals", goal, goalActionResultSchema, deps);
}

/** `PATCH /v1/goals/:jobId` as the person: its tickets or limit, on the version shown (4.4). */
export function editGoal(
  person: Person,
  jobId: string,
  edit: EditGoalRequest,
  deps: ApiClientDeps,
): Promise<ApiResult<GoalActionResult>> {
  const route = `/v1/goals/${encodeURIComponent(jobId)}`;
  return apiSend(person, "PATCH", route, edit, goalActionResultSchema, deps);
}
