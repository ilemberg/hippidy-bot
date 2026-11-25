import { describe, expect, it } from "vitest";
import { readApiConfig } from "./config.ts";
import { memoryLogger } from "./testing.ts";

const goodToken = "a".repeat(32);

describe("readApiConfig", () => {
  it("reads a valid service token", () => {
    const { log } = memoryLogger();
    expect(readApiConfig({ API_SERVICE_TOKEN: goodToken }, log).serviceToken).toBe(goodToken);
  });

  it("leaves the token unset when the variable is missing, and warns", () => {
    const { log, lines } = memoryLogger();
    expect(readApiConfig({}, log).serviceToken).toBeUndefined();
    expect(lines[0]).toMatchObject({ level: "warn", msg: "config.service_token_missing" });
  });

  it("treats an empty variable as missing", () => {
    const { log } = memoryLogger();
    expect(readApiConfig({ API_SERVICE_TOKEN: "" }, log).serviceToken).toBeUndefined();
  });

  it("refuses a token that is too short, without logging its value", () => {
    const { log, lines } = memoryLogger();
    expect(readApiConfig({ API_SERVICE_TOKEN: "short" }, log).serviceToken).toBeUndefined();
    expect(lines[0]).toMatchObject({ level: "error", msg: "config.service_token_invalid" });
    expect(JSON.stringify(lines)).not.toContain('short"');
  });

  it("reads the reconcile token separately", () => {
    const { log } = memoryLogger();
    const reconcile = "r".repeat(40);
    const config = readApiConfig({ API_SERVICE_TOKEN: goodToken, RECONCILE_TOKEN: reconcile }, log);
    expect(config).toEqual({
      serviceToken: goodToken,
      reconcileToken: reconcile,
      personAuth: undefined,
    });
    expect(readApiConfig({ API_SERVICE_TOKEN: goodToken }, log).reconcileToken).toBeUndefined();
  });

  it("reads person auth only when both the shared secret and the workspace are good", () => {
    const { log, lines } = memoryLogger();
    const secret = "w".repeat(40);
    expect(
      readApiConfig({ WEB_API_SECRET: secret, SLACK_WORKSPACE_ID: "T0123456789" }, log).personAuth,
    ).toEqual({ secret, workspaceId: "T0123456789" });
    expect(readApiConfig({ WEB_API_SECRET: secret }, log).personAuth).toBeUndefined();
    expect(readApiConfig({ SLACK_WORKSPACE_ID: "T0123456789" }, log).personAuth).toBeUndefined();
    expect(
      readApiConfig({ WEB_API_SECRET: secret, SLACK_WORKSPACE_ID: "team one" }, log).personAuth,
    ).toBeUndefined();
    expect(lines).toContainEqual(
      expect.objectContaining({ level: "error", msg: "config.slack_workspace_id_invalid" }),
    );
    expect(JSON.stringify(lines)).not.toContain(secret);
    expect(JSON.stringify(lines)).not.toContain("team one");
  });
});
