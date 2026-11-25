import { signOut } from "../../../lib/auth-flow.ts";
import { serverDeps } from "../../../lib/server.ts";

export const dynamic = "force-dynamic";

// POST only, from the page's form: a link or an image elsewhere cannot sign anyone out.
export function POST(request: Request): Response {
  return signOut(request, serverDeps());
}
