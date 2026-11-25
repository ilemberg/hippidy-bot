import { handleAreaAction } from "../../lib/areas.ts";
import { serverDeps } from "../../lib/server.ts";

export const dynamic = "force-dynamic";

// POST only, from the areas page: create an area (slice 3.1). Not under `/areas/`, where every
// segment is an area's name, so no name is shadowed.
export function POST(request: Request): Promise<Response> {
  return handleAreaAction(request, "create", undefined, serverDeps());
}
