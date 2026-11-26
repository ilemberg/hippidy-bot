import { handleNewGoal } from "../../lib/goals.ts";
import { serverDeps } from "../../lib/server.ts";

export const dynamic = "force-dynamic";

// POST only, from the form at `/jobs/new-goal`: make a goal (slice 4.4). Not under `/jobs/`,
// where every segment is a job's name.
export function POST(request: Request): Promise<Response> {
  return handleNewGoal(request, serverDeps());
}
