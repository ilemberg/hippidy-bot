import { LogLevel, ReceiverAuthenticityError, type Logger as BoltLogger } from "@slack/bolt";
import type { Logger } from "../log.ts";

/** Routes Bolt's and the receiver's own log output into our JSON logger. */
export function boltLogger(log: Logger): BoltLogger {
  let level = LogLevel.INFO;
  let name = "bolt";
  const order: Record<LogLevel, number> = {
    [LogLevel.DEBUG]: 10,
    [LogLevel.INFO]: 20,
    [LogLevel.WARN]: 30,
    [LogLevel.ERROR]: 40,
  };
  const write =
    (at: LogLevel, method: "debug" | "info" | "warn" | "error") =>
    (...parts: unknown[]): void => {
      if (order[at] < order[level]) return;
      const errors = parts.filter((part) => part instanceof Error);
      // Unsigned or badly signed requests (internet scanners, misconfiguration) are expected
      // on a public URL: a warning without a stack, not an error.
      const rejected = errors.find((error) => error instanceof ReceiverAuthenticityError);
      if (rejected !== undefined) {
        log.warn("slack.request_rejected", { logger: name, reason: rejected.message });
        return;
      }
      const text = parts
        .filter((part) => !(part instanceof Error))
        .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
        .join(" ");
      log[method]("slack.bolt", {
        logger: name,
        detail: text,
        ...(errors.length > 0 ? { error: errors[0] } : {}),
      });
    };
  return {
    debug: write(LogLevel.DEBUG, "debug"),
    info: write(LogLevel.INFO, "info"),
    warn: write(LogLevel.WARN, "warn"),
    error: write(LogLevel.ERROR, "error"),
    setLevel: (next) => {
      level = next;
    },
    getLevel: () => level,
    setName: (next) => {
      name = next;
    },
  };
}
