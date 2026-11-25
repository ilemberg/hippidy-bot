import { CORRELATION_ID_HEADER, meResponseSchema, type MeResponse } from "@hippidy/contracts";
import type { Logger } from "./log.ts";
import type { Fetch } from "./slack-oidc.ts";
import { mintApiToken, type Person } from "./tokens.ts";

// The web app talks to the system only through the API (decision 22), from its server, as
// the signed-in person (decision 194). The service token is never here.

export interface ApiClientDeps {
  fetch: Fetch;
  apiBaseUrl: string;
  apiSecret: string;
  log: Logger;
  correlationId: string;
  now?: () => Date;
}

export type MeResult = { kind: "ok"; me: MeResponse } | { kind: "failed"; reason: string };

/** `GET /v1/me` as the person: who the API takes them to be. */
export async function fetchMe(person: Person, deps: ApiClientDeps): Promise<MeResult> {
  const token = await mintApiToken(person, deps.apiSecret, deps.now?.() ?? new Date());
  let res: Response;
  try {
    res = await deps.fetch(new URL("/v1/me", deps.apiBaseUrl).toString(), {
      headers: { authorization: `Bearer ${token}`, [CORRELATION_ID_HEADER]: deps.correlationId },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    deps.log.error("api.request_failed", { route: "/v1/me", error });
    return { kind: "failed", reason: "unreachable" };
  }
  if (!res.ok) {
    deps.log.warn("api.refused", { route: "/v1/me", status: res.status });
    return { kind: "failed", reason: `status_${res.status}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const parsed = meResponseSchema.safeParse(body);
  if (!parsed.success) {
    deps.log.error("api.unexpected_response", { route: "/v1/me" });
    return { kind: "failed", reason: "unexpected_response" };
  }
  return { kind: "ok", me: parsed.data };
}
