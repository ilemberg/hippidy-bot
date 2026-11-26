import type { Task, TaskStatus } from "@hippidy/contracts";
import { z } from "zod";

// Jira as the task provider (slice 3.3, decision 210): its REST API, read-only, with a
// credential of the API's own. The agent never sees this credential.

export interface JiraConfig {
  baseUrl: string;
  email: string;
  token: string;
  project: string;
}

/** The part of `fetch` this uses: passed in, so tests fake Jira without the network. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export const JIRA_TIMEOUT_MS = 5000;

const issueSchema = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string().nullable().optional(),
    status: z
      .object({
        name: z.string(),
        statusCategory: z.object({ key: z.string() }).optional(),
      })
      .nullable()
      .optional(),
    assignee: z.object({ displayName: z.string().nullable().optional() }).nullable().optional(),
    updated: z.string().nullable().optional(),
  }),
});

/** Jira's status category: `new` is to do, `indeterminate` doing, `done` done. */
function statusOf(category: string | undefined): TaskStatus {
  if (category === "done") return "done";
  if (category === "indeterminate") return "doing";
  return "todo";
}

function toTask(config: JiraConfig, raw: unknown): Task | undefined {
  const parsed = issueSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const issue = parsed.data;
  const updated = issue.fields.updated == null ? undefined : new Date(issue.fields.updated);
  return {
    key: issue.key,
    title: issue.fields.summary ?? "",
    status: statusOf(issue.fields.status?.statusCategory?.key),
    statusName: issue.fields.status?.name ?? "Unknown",
    assignee:
      issue.fields.assignee?.displayName == null
        ? null
        : { actorId: null, name: issue.fields.assignee.displayName },
    url: `${config.baseUrl}/browse/${encodeURIComponent(issue.key)}`,
    updatedAt:
      updated === undefined || Number.isNaN(updated.getTime())
        ? new Date(0).toISOString()
        : updated.toISOString(),
  };
}

/** Thrown when Jira cannot be reached or answers with an error; the message names no secret. */
export class JiraUnreachable extends Error {}

const FIELDS = ["summary", "status", "assignee", "updated"];

/** Quotes a value for JQL: words to search are text, never JQL. */
function jqlString(text: string): string {
  return `"${text.replace(/["\\]/g, (c) => `\\${c}`)}"`;
}

/** Words for Jira's `text ~`: its search reserves these characters, so they become spaces. */
function searchWords(text: string): string {
  return text
    .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function createJira(config: JiraConfig, fetchJira: Fetch = fetch) {
  const headers = {
    authorization: `Basic ${Buffer.from(`${config.email}:${config.token}`).toString("base64")}`,
    accept: "application/json",
    "content-type": "application/json",
  };
  /**
   * One call, its body read and parsed: anything that goes wrong on the way (no answer, an
   * error status, a body that is not JSON, the time running out while it is read) is
   * `JiraUnreachable`, so a caller has one thing to handle (from the review of 3.3). A 404
   * answers undefined.
   */
  async function call(path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
    try {
      const response = await fetchJira(`${config.baseUrl}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 404) return undefined;
      if (!response.ok) throw new JiraUnreachable(`Jira answered ${String(response.status)}`);
      return await response.json();
    } catch (error) {
      if (error instanceof JiraUnreachable) throw error;
      throw new JiraUnreachable(
        `Jira did not answer: ${error instanceof Error ? error.name : "error"}`,
      );
    }
  }
  return {
    /** The project's issues, not done first, by latest change. */
    async list(query: { q?: string | undefined; status: string; limit: number }): Promise<Task[]> {
      const clauses = [`project = ${jqlString(config.project)}`];
      const words = query.q === undefined ? "" : searchWords(query.q);
      if (words !== "") clauses.push(`text ~ ${jqlString(words)}`);
      if (query.status === "open") clauses.push("statusCategory != Done");
      else if (query.status === "todo") clauses.push('statusCategory = "To Do"');
      else if (query.status === "doing") clauses.push('statusCategory = "In Progress"');
      else if (query.status === "done") clauses.push("statusCategory = Done");
      const answer = await call(
        "/rest/api/3/search/jql",
        {
          method: "POST",
          body: JSON.stringify({
            jql: `${clauses.join(" AND ")} ORDER BY updated DESC`,
            fields: FIELDS,
            maxResults: query.limit,
          }),
        },
        JIRA_TIMEOUT_MS,
      );
      const body = z.object({ issues: z.array(z.unknown()) }).safeParse(answer);
      if (!body.success) throw new JiraUnreachable("Jira's answer did not have issues");
      return body.data.issues.flatMap((issue) => {
        const task = toTask(config, issue);
        return task === undefined || !inProject(config, task.key) ? [] : [task];
      });
    },
    /**
     * One issue by key; undefined if Jira has none, or it is in another project (Jira follows
     * a moved key to its new one, which may be a project this credential should not show).
     */
    async get(key: string, timeoutMs = JIRA_TIMEOUT_MS): Promise<Task | undefined> {
      if (!inProject(config, key)) return undefined;
      const answer = await call(
        `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${FIELDS.join(",")}`,
        { method: "GET" },
        timeoutMs,
      );
      if (answer === undefined) return undefined;
      const task = toTask(config, answer);
      if (task === undefined) throw new JiraUnreachable("Jira's answer was not an issue");
      return inProject(config, task.key) ? task : undefined;
    },
  };
}

function inProject(config: JiraConfig, key: string): boolean {
  return key.toUpperCase().startsWith(`${config.project}-`);
}
