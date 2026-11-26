import { handleGoalEdit } from "../../../../lib/goals.ts";
import { serverDeps } from "../../../../lib/server.ts";

export const dynamic = "force-dynamic";

// POST only, from a goal's page: change its tickets or its limit (slice 4.4). A link or an
// image elsewhere cannot change a goal.
export async function POST(
  request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await context.params;
  return handleGoalEdit(request, name, serverDeps());
}
