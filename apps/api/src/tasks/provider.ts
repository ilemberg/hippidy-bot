import type { ListTasksQuery, Task, TaskList, TaskProvider } from "@hippidy/contracts";
import type { TaskConfig } from "../config.ts";
import type { Logger } from "../log.ts";
import type { Place } from "../store/areas.ts";
import type { Db } from "../store/db.ts";
import { findBuiltinTask, listBuiltinTasks, toTask } from "../store/tasks.ts";
import { createJira, JiraUnreachable, type Fetch } from "./jira.ts";

// Tasks behind one provider (slice 3.3, decision 210): the built-in tracker or Jira, read the
// same way so the web app's page is the same whichever is the team's home. Nothing is cached.

/** A task looked up by key: found, not there, or the provider could not say. */
export type TaskLookup =
  | { kind: "found"; task: Task }
  | { kind: "missing" }
  | { kind: "unavailable"; problem: "not_configured" | "unreachable" };

export interface TaskSource {
  readonly provider: TaskProvider;
  list(place: Place, query: ListTasksQuery): Promise<TaskList>;
  get(place: Place, key: string): Promise<TaskLookup>;
}

export function createTaskSource(
  config: TaskConfig,
  db: Db,
  log: Logger,
  fetchJira?: Fetch,
): TaskSource {
  if (config.kind === "builtin") {
    return {
      provider: "builtin",
      async list(place, query) {
        const rows = await listBuiltinTasks(db, place, {
          q: query.q,
          status: query.status ?? "open",
          limit: query.limit,
        });
        return { provider: "builtin", available: true, problem: null, tasks: rows.map(toTask) };
      },
      async get(place, key) {
        const row = await findBuiltinTask(db, place, key);
        return row === undefined ? { kind: "missing" } : { kind: "found", task: toTask(row) };
      },
    };
  }
  if (config.kind === "jira_unconfigured") {
    return {
      provider: "jira",
      list: () =>
        Promise.resolve({
          provider: "jira",
          available: false,
          problem: "not_configured",
          tasks: [],
        }),
      get: () => Promise.resolve({ kind: "unavailable", problem: "not_configured" }),
    };
  }
  const jira = createJira(config, fetchJira);
  return {
    provider: "jira",
    async list(_place, query) {
      try {
        const tasks = await jira.list({
          q: query.q,
          status: query.status ?? "open",
          limit: query.limit,
        });
        return { provider: "jira", available: true, problem: null, tasks };
      } catch (error) {
        if (!(error instanceof JiraUnreachable)) throw error;
        log.warn("tasks.jira_unreachable", { error: error.message });
        return { provider: "jira", available: false, problem: "unreachable", tasks: [] };
      }
    },
    async get(_place, key) {
      try {
        const task = await jira.get(key);
        return task === undefined ? { kind: "missing" } : { kind: "found", task };
      } catch (error) {
        if (!(error instanceof JiraUnreachable)) throw error;
        log.warn("tasks.jira_unreachable", { error: error.message });
        return { kind: "unavailable", problem: "unreachable" };
      }
    },
  };
}
