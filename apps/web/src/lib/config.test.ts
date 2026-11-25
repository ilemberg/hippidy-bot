import { describe, expect, it } from "vitest";
import { readWebConfig, type Env } from "./config.ts";
import { memoryLogger } from "./log.ts";

const env: Env = {
  SLACK_CLIENT_ID: "1234.5678",
  SLACK_CLIENT_SECRET: "c".repeat(32),
  SLACK_WORKSPACE_ID: "T0123456789",
  WEB_API_SECRET: "a".repeat(48),
  WEB_SESSION_SECRET: "b".repeat(48),
  API_BASE_URL: "https://hippidy-bot.vercel.app",
  WEB_BASE_URL: "https://hippidy-web.vercel.app/",
};

describe("readWebConfig", () => {
  it("reads a complete configuration", () => {
    const { log } = memoryLogger();
    expect(readWebConfig(env, log)).toEqual({
      slack: { clientId: "1234.5678", clientSecret: "c".repeat(32), workspaceId: "T0123456789" },
      apiSecret: "a".repeat(48),
      sessionSecret: "b".repeat(48),
      apiBaseUrl: "https://hippidy-bot.vercel.app",
      webBaseUrl: "https://hippidy-web.vercel.app",
    });
  });

  it("allows plain http only on this machine", () => {
    const { log } = memoryLogger();
    const local = { ...env, API_BASE_URL: "http://localhost:3000" };
    expect(readWebConfig(local, log)?.apiBaseUrl).toBe("http://localhost:3000");
    expect(readWebConfig({ ...env, API_BASE_URL: "http://api.example.com" }, log)).toBeUndefined();
    expect(readWebConfig({ ...env, WEB_BASE_URL: "https://x.example/app" }, log)).toBeUndefined();
  });

  it.each([
    ["nothing at all", {}],
    ["a missing client secret", { ...env, SLACK_CLIENT_SECRET: undefined }],
    ["a short API secret", { ...env, WEB_API_SECRET: "short" }],
    ["a workspace that is not a team id", { ...env, SLACK_WORKSPACE_ID: "acme" }],
    ["the same secret twice", { ...env, WEB_SESSION_SECRET: env.WEB_API_SECRET }],
  ])("leaves sign-in off for %s, without logging a value", (_case, given: Env) => {
    const { log, lines } = memoryLogger();
    expect(readWebConfig(given, log)).toBeUndefined();
    expect(lines).toContainEqual(expect.objectContaining({ msg: "config.web_not_configured" }));
    const logged = JSON.stringify(lines);
    for (const value of Object.values(given)) {
      if (value !== undefined && value.length > 8) expect(logged).not.toContain(value);
    }
  });
});
