import type { Logger } from "../log.ts";

/** Values every API handler can read from the request context. */
export interface ApiEnv {
  Variables: {
    correlationId: string;
    log: Logger;
  };
}
