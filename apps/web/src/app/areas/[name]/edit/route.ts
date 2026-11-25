import { handleAreaAction } from "../../../../lib/areas.ts";
import { serverDeps } from "../../../../lib/server.ts";

export const dynamic = "force-dynamic";

// POST only, from an area's page: change it (slice 3.1). A link or an image elsewhere cannot
// change an area.
export async function POST(
  request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await context.params;
  return handleAreaAction(request, "edit", name, serverDeps());
}
