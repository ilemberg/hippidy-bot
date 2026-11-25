import { createRemoteJWKSet } from "jose";
import type { AuthDeps } from "./auth-flow.ts";
import { readWebConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { SLACK_JWKS_URL } from "./slack-oidc.ts";

// The real dependencies, read once per server instance. The only place that reads
// `process.env`, makes network clients or picks Slack's live keys.

let deps: AuthDeps | undefined;

export function serverDeps(): AuthDeps {
  if (deps === undefined) {
    const log = createLogger();
    deps = {
      config: readWebConfig(process.env, log),
      log,
      fetch: (url, init) => fetch(url, init),
      // Fetched on first use and cached; refetched when Slack signs with a key not seen yet.
      keys: createRemoteJWKSet(new URL(SLACK_JWKS_URL)),
    };
  }
  return deps;
}
