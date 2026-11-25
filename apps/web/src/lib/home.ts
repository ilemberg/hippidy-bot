import { randomUUID } from "node:crypto";
import { fetchMe, type MeResult } from "./api-client.ts";
import { signInNotices, type SignInNotice } from "./auth-flow.ts";
import type { WebConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import type { Fetch } from "./slack-oidc.ts";
import { readSession, type Person } from "./tokens.ts";

/** What the home page shows. */
export type HomeView =
  | { kind: "unconfigured" }
  | { kind: "signed_out"; notice: SignInNotice | undefined }
  | { kind: "signed_in"; person: Person; me: MeResult };

export interface HomeDeps {
  config: WebConfig | undefined;
  fetch: Fetch;
  log: Logger;
  now?: () => Date;
}

const isNotice = (value: string | undefined): value is SignInNotice =>
  signInNotices.some((notice) => notice === value);

/** Reads the session cookie and, for a signed-in person, asks the API who they are. */
export async function loadHome(
  input: { sessionCookie: string | undefined; signin: string | undefined },
  deps: HomeDeps,
): Promise<HomeView> {
  const config = deps.config;
  if (config === undefined) return { kind: "unconfigured" };
  const now = deps.now?.() ?? new Date();
  const person = await readSession(input.sessionCookie, {
    secret: config.sessionSecret,
    workspaceId: config.slack.workspaceId,
    now,
  });
  if (person === undefined) {
    return { kind: "signed_out", notice: isNotice(input.signin) ? input.signin : undefined };
  }
  const correlationId = randomUUID();
  const me = await fetchMe(person, {
    fetch: deps.fetch,
    apiBaseUrl: config.apiBaseUrl,
    apiSecret: config.apiSecret,
    log: deps.log.child({ correlationId, actorId: person.actorId }),
    correlationId,
    now: () => now,
  });
  return { kind: "signed_in", person, me };
}
