import { serverDeps } from "../../lib/server.ts";
import { handleWaitAction } from "../../lib/waits.ts";

export const dynamic = "force-dynamic";

// POST only, from the waiting-on page: the signed-in person records their own wait (slice 3.3).
// Not under `/waits/`, where every segment is a wait's id.
export function POST(request: Request): Promise<Response> {
  return handleWaitAction(request, "record", undefined, serverDeps());
}
