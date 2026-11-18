export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line. */
  child(fields: LogFields): Logger;
}

/** Receives one finished JSON line. Replaced in tests. */
export type LogSink = (line: string, level: LogLevel) => void;

const levelOrder: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const consoleSink: LogSink = (line, level) => {
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
};

function serializeError(error: Error): LogFields {
  const out: LogFields = { name: error.name, message: error.message, stack: error.stack };
  if (error.cause !== undefined) out.cause = error.cause;
  return out;
}

/** JSON replacer: keeps errors (and their causes) readable and turns BigInt into a string. */
function replacer(this: unknown, _key: string, value: unknown): unknown {
  if (value instanceof Error) return serializeError(value);
  if (typeof value === "bigint") return value.toString();
  return value;
}

function stringify(entry: LogFields): string {
  try {
    return JSON.stringify(entry, replacer);
  } catch (error) {
    // Circular data or a throwing toJSON must never make logging itself fail.
    const { level, time, msg } = entry;
    return JSON.stringify({ level, time, msg, logError: String(error) });
  }
}

export interface LoggerOptions {
  sink?: LogSink;
  minLevel?: LogLevel;
  fields?: LogFields;
}

/** Structured JSON logger: one object per line, with `level`, `time` and `msg`. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? consoleSink;
  const minLevel = options.minLevel ?? "info";
  const base = options.fields ?? {};

  const write = (level: LogLevel, msg: string, fields: LogFields = {}): void => {
    if (levelOrder[level] < levelOrder[minLevel]) return;
    // Reserved keys come first in the line, and are written again last so caller fields can
    // never overwrite them.
    const reserved = { level, time: new Date().toISOString(), msg };
    const entry: LogFields = { ...reserved, ...base, ...fields, ...reserved };
    sink(stringify(entry), level);
  };

  return {
    debug: (msg, fields) => {
      write("debug", msg, fields);
    },
    info: (msg, fields) => {
      write("info", msg, fields);
    },
    warn: (msg, fields) => {
      write("warn", msg, fields);
    },
    error: (msg, fields) => {
      write("error", msg, fields);
    },
    child: (fields) => createLogger({ sink, minLevel, fields: { ...base, ...fields } }),
  };
}
