import { startSignIn } from "../../../lib/auth-flow.ts";
import { serverDeps } from "../../../lib/server.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return startSignIn(request, serverDeps());
}
