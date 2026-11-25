// Loads the app the way Vercel does: without the "source" condition, so workspace packages
// resolve to their compiled dist/. Run after `pnpm build`. Exits non-zero on any surprise.
import app from "../src/index.ts";

const checks: [string, Request, number][] = [
  ["health", new Request("http://smoke/health"), 200],
  ["status without config", new Request("http://smoke/status"), 503],
  ["messages without token", new Request("http://smoke/v1/messages", { method: "POST" }), 401],
  [
    "me with a token and no configuration",
    new Request("http://smoke/v1/me", { headers: { authorization: "Bearer a.b.c" } }),
    401,
  ],
  [
    "slack events without config",
    new Request("http://smoke/slack/events", { method: "POST" }),
    503,
  ],
];

let failed = false;
for (const [name, request, expected] of checks) {
  const res = await app.fetch(request);
  const ok = res.status === expected;
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${res.status} (expected ${expected})`);
}
process.exit(failed ? 1 : 0);
