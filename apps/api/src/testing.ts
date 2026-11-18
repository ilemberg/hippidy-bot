import { createLogger, type LogFields, type Logger } from "./log.ts";

/** A logger that keeps parsed lines in memory, for assertions. */
export function memoryLogger(): { log: Logger; lines: LogFields[] } {
  const lines: LogFields[] = [];
  const log = createLogger({
    minLevel: "debug",
    sink: (line) => {
      lines.push(JSON.parse(line) as LogFields);
    },
  });
  return { log, lines };
}
