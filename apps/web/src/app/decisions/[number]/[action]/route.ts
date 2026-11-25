import { handleDecisionAction } from "../../../../lib/decisions.ts";
import { serverDeps } from "../../../../lib/server.ts";

export const dynamic = "force-dynamic";

// POST only, from a decision's page: confirm, reject or edit (slice 2.6). A link or an image
// elsewhere cannot change a decision.
export async function POST(
  request: Request,
  context: { params: Promise<{ number: string; action: string }> },
): Promise<Response> {
  const { number, action } = await context.params;
  return handleDecisionAction(request, number, action, serverDeps());
}
