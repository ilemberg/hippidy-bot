import { createHmac, randomBytes } from "node:crypto";
import { Anthropic } from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { createWebhookVerifier } from "./webhooks.ts";

// Signs the way Anthropic does (Standard Webhooks), so the SDK's real check is exercised.
const secretBytes = randomBytes(32);
const signingKey = `whsec_${secretBytes.toString("base64")}`;

function signedHeaders(body: string, id = "whe_1", timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", secretBytes)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": `v1,${signature}`,
  };
}

const body = JSON.stringify({
  type: "event",
  id: "whe_1",
  created_at: "2026-11-18T00:00:00Z",
  data: {
    type: "session.status_idled",
    id: "sesn_123",
    organization_id: "org",
    workspace_id: "wrk",
  },
});

const verify = createWebhookVerifier(signingKey, new Anthropic({ apiKey: "sk-ant-test" }));

describe("createWebhookVerifier", () => {
  it("accepts a correctly signed webhook and returns its event", () => {
    expect(verify(body, signedHeaders(body))).toEqual({
      id: "whe_1",
      type: "session.status_idled",
      resourceId: "sesn_123",
    });
  });

  it("rejects a tampered body", () => {
    const headers = signedHeaders(body);
    expect(() => verify(body.replace("sesn_123", "sesn_999"), headers)).toThrow();
  });

  it("rejects a webhook signed with another key", () => {
    const other = createWebhookVerifier(
      `whsec_${randomBytes(32).toString("base64")}`,
      new Anthropic({ apiKey: "sk-ant-test" }),
    );
    expect(() => other(body, signedHeaders(body))).toThrow();
  });

  it("rejects an old webhook", () => {
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    expect(() => verify(body, signedHeaders(body, "whe_1", tenMinutesAgo))).toThrow();
  });

  it("rejects a webhook without signature headers", () => {
    expect(() => verify(body, {})).toThrow();
  });
});
