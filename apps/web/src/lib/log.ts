// JSON logs, one object per line, like the API's (`apps/api/src/log.ts`). The web app is its
// own deployable and imports nothing from the API, so it keeps this small copy.

export type LogFields = Record<string, unknown>;
export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line. */
  child(fields: LogFields): Logger;
}

export type LogSink = (line: string, level: LogLevel) => void;

const consoleSink: LogSink = (line, level) => {
  if (level === "info") console.log(line);
  else console.error(line);
};

function replacer(this: unknown, _key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

export function createLogger(sink: LogSink = consoleSink, base: LogFields = {}): Logger {
  const write = (level: LogLevel, msg: string, fields: LogFields = {}): void => {
    const reserved = { level, time: new Date().toISOString(), msg };
    let line: string;
    try {
      line = JSON.stringify({ ...reserved, ...base, ...fields, ...reserved }, replacer);
    } catch (error) {
      line = JSON.stringify({ ...reserved, logError: String(error) });
    }
    sink(line, level);
  };
  return {
    info: (msg, fields) => {
      write("info", msg, fields);
    },
    warn: (msg, fields) => {
      write("warn", msg, fields);
    },
    error: (msg, fields) => {
      write("error", msg, fields);
    },
    child: (fields) => createLogger(sink, { ...base, ...fields }),
  };
}

/** A logger that keeps parsed lines in memory, for tests. */
export function memoryLogger(): { log: Logger; lines: LogFields[] } {
  const lines: LogFields[] = [];
  return {
    log: createLogger((line) => {
      lines.push(JSON.parse(line) as LogFields);
    }),
    lines,
  };
}
