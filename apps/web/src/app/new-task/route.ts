import { serverDeps } from "../../lib/server.ts";
import { handleTaskAction } from "../../lib/tasks.ts";

export const dynamic = "force-dynamic";

// POST only, from the tasks page: create a built-in task (slice 3.3). Not under `/tasks/`, where
// every segment is a task's key, so no key is shadowed.
export function POST(request: Request): Promise<Response> {
  return handleTaskAction(request, "create", undefined, serverDeps());
}
