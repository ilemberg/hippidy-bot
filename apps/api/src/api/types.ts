import type { Logger } from "../log.ts";

/**
 * Who made the request, once an auth middleware let it through: a service holding the
 * service token, or a person signed in to the web app (decision 194).
 */
export type Caller =
  { kind: "service" } | { kind: "person"; workspaceId: string; actorId: string; name: string };

/** Values every API handler can read from the request context. */
export interface ApiEnv {
  Variables: {
    correlationId: string;
    log: Logger;
    /** Set by the auth middleware; read only on routes behind one. */
    caller: Caller;
  };
}
