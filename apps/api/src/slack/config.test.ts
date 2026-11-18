import { describe, expect, it } from "vitest";
import { memoryLogger } from "../testing.ts";
import { readSlackConfig } from "./config.ts";

const env = { SLACK_BOT_TOKEN: "xoxb-123-456-abc", SLACK_SIGNING_SECRET: "s".repeat(32) };

describe("readSlackConfig", () => {
  it("reads valid settings", () => {
    const { log } = memoryLogger();
    expect(readSlackConfig(env, log)).toEqual({
      botToken: env.SLACK_BOT_TOKEN,
      signingSecret: env.SLACK_SIGNING_SECRET,
    });
  });

  it("returns undefined when anything is missing, naming the variable", () => {
    const { log, lines } = memoryLogger();
    expect(readSlackConfig({ SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN }, log)).toBeUndefined();
    expect(JSON.stringify(lines)).toContain("SLACK_SIGNING_SECRET");
  });

  it("rejects a token that is not a bot token, without logging it", () => {
    const { log, lines } = memoryLogger();
    expect(readSlackConfig({ ...env, SLACK_BOT_TOKEN: "xoxp-user-token" }, log)).toBeUndefined();
    expect(JSON.stringify(lines)).not.toContain("xoxp-user-token");
  });
});
