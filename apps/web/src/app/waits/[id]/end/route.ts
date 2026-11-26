import { serverDeps } from "../../../../lib/server.ts";
import { handleWaitAction } from "../../../../lib/waits.ts";

export const dynamic = "force-dynamic";

// POST only, from the waiting-on page: end a wait the signed-in person is part of (slice 3.3).
// A link or an image elsewhere cannot end one.
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleWaitAction(request, "end", id, serverDeps());
}
