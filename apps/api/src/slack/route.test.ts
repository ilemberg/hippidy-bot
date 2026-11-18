import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ApiEnv } from "../api/types.ts";
import { configureApp } from "../compose.ts";
import type { Env } from "../config.ts";
import { memoryLogger } from "../testing.ts";
import fixture from "./fixtures/app-mention.json" with { type: "json" };
import type { SlackActions } from "./handler.ts";

const signingSecret = "8f742231b10e8888abcd99yyyzzz85a5";
const env: Env = {
  API_SERVICE_TOKEN: "t".repeat(48),
  SLACK_BOT_TOKEN: "xoxb-test-token",
  SLACK_SIGNING_SECRET: signingSecret,
};

function signed(body: string, secret = signingSecret, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return new Request("http://test/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": signature,
    },
    body,
  });
}

function setup(appEnv: Env = env) {
  const { log, lines } = memoryLogger();
  let reacted: (input: unknown) => void = () => undefined;
  const reaction = new Promise((resolve) => {
    reacted = resolve;
  });
  const slackActions = (): SlackActions => ({
    addReaction: (input) => {
      reacted(input);
      return Promise.resolve();
    },
  });
  const app = configureApp(new Hono<ApiEnv>(), { env: appEnv, log, slackActions });
  return { app, lines, reaction };
}

describe("POST /slack/events", () => {
  it("answers Slack's URL verification handshake", async () => {
    const { app } = setup();
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123", token: "x" });
    const res = await app.request(signed(body));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("abc123");
  });

  it("rejects a request with a bad signature", async () => {
    const { app } = setup();
    const res = await app.request(signed(JSON.stringify(fixture), "wrong-secret-0000000000000000"));
    expect(res.status).toBe(401);
  });

  it("rejects a request with no signature", async () => {
    const { app } = setup();
    const res = await app.request("/slack/events", {
      method: "POST",
      body: JSON.stringify(fixture),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a correctly signed but old request", async () => {
    const { app } = setup();
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    const res = await app.request(signed(JSON.stringify(fixture), signingSecret, tenMinutesAgo));
    expect(res.status).toBe(401);
  });

  it("acknowledges a signed app_mention, sends it through the API and reacts", async () => {
    const { app, lines, reaction } = setup();
    const res = await app.request(signed(JSON.stringify(fixture)));
    expect(res.status).toBe(200);

    expect(await reaction).toEqual({
      channel: "C0LAN2Q65",
      timestamp: "1515449522.000016",
      name: "eyes",
    });
    // Nothing tried to reach Slack, and the API itself logged the message with the Slack
    // event id as the correlation id.
    expect(JSON.stringify(lines)).not.toContain("http request failed");
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: "message.received", correlationId: "Ev0LAN670R" }),
    );
  });

  it("returns 503 when Slack is not configured, and the API keeps working", async () => {
    const { app } = setup({ API_SERVICE_TOKEN: env.API_SERVICE_TOKEN });
    const res = await app.request(signed(JSON.stringify(fixture)));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "not_configured" } });
    expect((await app.request("/health")).status).toBe(200);
  });
});
