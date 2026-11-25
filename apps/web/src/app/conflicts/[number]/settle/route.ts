import { handleSettleConflict } from "../../../../lib/conflicts.ts";
import { serverDeps } from "../../../../lib/server.ts";

export const dynamic = "force-dynamic";

// POST only, from a conflict's page: settle it (slice 3.2). A link or an image elsewhere cannot
// settle a conflict.
export async function POST(
  request: Request,
  context: { params: Promise<{ number: string }> },
): Promise<Response> {
  const { number } = await context.params;
  return handleSettleConflict(request, number, serverDeps());
}
