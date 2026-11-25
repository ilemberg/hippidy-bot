import { randomUUID } from "node:crypto";
import type { SessionActivity } from "@hippidy/contracts";
import { fetchSessions, type ApiResult } from "./api-client.ts";
import { signInNotices, type SignInNotice } from "./auth-flow.ts";
import type { WebConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import type { Fetch } from "./slack-oidc.ts";
import { readSession, type Person } from "./tokens.ts";

/** How many sessions the page shows: the Dashboard v1 plan's ten. */
export const SESSIONS_SHOWN = 10;

/** What the home page shows. */
export type HomeView =
  | { kind: "unconfigured" }
  | { kind: "signed_out"; notice: SignInNotice | undefined }
  | {
      kind: "signed_in";
      person: Person;
      /** The latest agents at work (slice 2.4), or why the API gave none. */
      sessions: ApiResult<SessionActivity[]>;
      /** When the list was read, for "as of". */
      readAt: string;
    };

export interface HomeDeps {
  config: WebConfig | undefined;
  fetch: Fetch;
  log: Logger;
  now?: () => Date;
}

/** The person the session cookie names, if it is valid for this workspace and still fresh. */
export function signedInPerson(
  sessionCookie: string | undefined,
  config: WebConfig,
  now: Date,
): Promise<Person | undefined> {
  return readSession(sessionCookie, {
    secret: config.sessionSecret,
    workspaceId: config.slack.workspaceId,
    now,
  });
}

const isNotice = (value: string | undefined): value is SignInNotice =>
  signInNotices.some((notice) => notice === value);

/** Reads the session cookie and, for a signed-in person, asks the API for the latest sessions. */
export async function loadHome(
  input: { sessionCookie: string | undefined; signin: string | undefined },
  deps: HomeDeps,
): Promise<HomeView> {
  const config = deps.config;
  if (config === undefined) return { kind: "unconfigured" };
  const now = deps.now?.() ?? new Date();
  const person = await signedInPerson(input.sessionCookie, config, now);
  if (person === undefined) {
    return { kind: "signed_out", notice: isNotice(input.signin) ? input.signin : undefined };
  }
  const correlationId = randomUUID();
  const sessions = await fetchSessions(person, SESSIONS_SHOWN, {
    fetch: deps.fetch,
    apiBaseUrl: config.apiBaseUrl,
    apiSecret: config.apiSecret,
    log: deps.log.child({ correlationId, actorId: person.actorId }),
    correlationId,
    now: () => now,
  });
  return { kind: "signed_in", person, sessions, readAt: now.toISOString() };
}
