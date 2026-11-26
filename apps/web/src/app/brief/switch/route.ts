import { handleBriefSwitch } from "../../../lib/briefs.ts";
import { serverDeps } from "../../../lib/server.ts";

export const dynamic = "force-dynamic";

// POST only, from the brief page: the signed-in person stops or starts their own daily briefs
// (slice 3.4). A link or an image elsewhere cannot switch them.
export function POST(request: Request): Promise<Response> {
  return handleBriefSwitch(request, serverDeps());
}
