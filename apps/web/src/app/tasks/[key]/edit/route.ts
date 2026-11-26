import { serverDeps } from "../../../../lib/server.ts";
import { handleTaskAction } from "../../../../lib/tasks.ts";

export const dynamic = "force-dynamic";

// POST only, from a built-in task's page: change it (slice 3.3). A link or an image elsewhere
// cannot change a task.
export async function POST(
  request: Request,
  context: { params: Promise<{ key: string }> },
): Promise<Response> {
  const { key } = await context.params;
  return handleTaskAction(request, "edit", key, serverDeps());
}
