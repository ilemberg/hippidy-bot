import { describe, expect, it } from "vitest";
import { createLogger } from "./log.ts";
import { memoryLogger } from "./testing.ts";

describe("createLogger", () => {
  it("writes one JSON object per line with level, time and message", () => {
    const { log, lines } = memoryLogger();
    log.info("hello", { a: 1 });
    expect(lines).toEqual([
      { level: "info", time: expect.any(String) as string, msg: "hello", a: 1 },
    ]);
  });

  it("adds child fields to every line", () => {
    const { log, lines } = memoryLogger();
    log.child({ correlationId: "c1" }).warn("w");
    expect(lines[0]).toMatchObject({ level: "warn", correlationId: "c1" });
  });

  it("serializes errors", () => {
    const { log, lines } = memoryLogger();
    log.error("boom", { error: new Error("bad") });
    expect(lines[0]?.error).toMatchObject({ name: "Error", message: "bad" });
  });

  it("never lets fields overwrite level, time or message", () => {
    const { log, lines } = memoryLogger();
    log.info("real", { msg: "spoofed", level: "error", time: "never" });
    expect(lines[0]).toMatchObject({ level: "info", msg: "real" });
    expect(lines[0]?.time).not.toBe("never");
  });

  it("keeps nested errors and their causes", () => {
    const { log, lines } = memoryLogger();
    log.error("boom", { context: { error: new Error("outer", { cause: new Error("inner") }) } });
    expect(lines[0]?.context).toMatchObject({
      error: { message: "outer", cause: { message: "inner" } },
    });
  });

  it("does not throw on values JSON cannot represent", () => {
    const { log, lines } = memoryLogger();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    log.info("big", { n: 10n });
    log.info("loop", { circular });
    expect(lines[0]).toMatchObject({ n: "10" });
    expect(lines[1]).toMatchObject({ msg: "loop", logError: expect.any(String) as string });
  });

  it("drops lines below the minimum level", () => {
    const written: string[] = [];
    const log = createLogger({ minLevel: "info", sink: (line) => written.push(line) });
    log.debug("quiet");
    expect(written).toEqual([]);
  });
});
