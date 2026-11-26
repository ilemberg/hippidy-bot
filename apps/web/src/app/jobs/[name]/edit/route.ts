import { handleJobEdit } from "../../../../lib/jobs.ts";
import { serverDeps } from "../../../../lib/server.ts";

export const dynamic = "force-dynamic";

// POST only, from a job's page: pause, resume or change it (slice 4.2). A link or an image
// elsewhere cannot change a job.
export async function POST(
  request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await context.params;
  return handleJobEdit(request, name, serverDeps());
}
