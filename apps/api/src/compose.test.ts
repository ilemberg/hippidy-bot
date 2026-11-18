import {
  acceptedMessageSchema,
  CORRELATION_ID_HEADER,
  errorResponseSchema,
  type InboundMessage,
} from "@hippidy/contracts";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ApiEnv } from "./api/types.ts";
import { configureApp } from "./compose.ts";
import type { Env } from "./config.ts";
import { memoryLogger } from "./testing.ts";

const token = "t".repeat(48);

const message: InboundMessage = {
  source: "slack",
  sourceEventId: "Ev0123456789",
  conversation: {
    workspaceId: "T0123456789",
    channelId: "C0123456789",
    threadId: "1763400000.000100",
    messageId: "1763400000.000100",
  },
  actor: { id: "U0123456789" },
  text: "hello",
  sentAt: "2025-11-17T17:20:00.000Z",
};

function setup(env: Env = { API_SERVICE_TOKEN: token }, newId?: () => string) {
  const { log, lines } = memoryLogger();
  const app = configureApp(
    new Hono<ApiEnv>(),
    newId === undefined ? { env, log } : { env, log, newId },
  );
  return { app, lines };
}

function postMessage(
  app: ReturnType<typeof setup>["app"],
  body: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${token}` },
) {
  return app.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = errorResponseSchema.parse(await res.json());
  expect(body.error.code).toBe(code);
  return body;
}

describe("GET /health", () => {
  it("returns 200", async () => {
    const { app } = setup();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("works with no configuration at all", async () => {
    const { app } = setup({});
    expect((await app.request("/health")).status).toBe(200);
  });
});

describe("POST /v1/messages", () => {
  it("accepts a valid message with 202 and an id, and logs it", async () => {
    const { app, lines } = setup();
    const res = await postMessage(app, message, {
      authorization: `Bearer ${token}`,
      [CORRELATION_ID_HEADER]: "Ev0123456789",
    });

    expect(res.status).toBe(202);
    const body = acceptedMessageSchema.parse(await res.json());
    expect(res.headers.get(CORRELATION_ID_HEADER)).toBe("Ev0123456789");
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: "message.received",
        correlationId: "Ev0123456789",
        messageId: body.id,
        message,
      }),
    );
  });

  it("generates a correlation id when none is sent", async () => {
    const { app } = setup();
    const res = await postMessage(app, message);
    expect(res.headers.get(CORRELATION_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("replaces a malformed correlation id", async () => {
    const { app } = setup();
    const res = await postMessage(app, message, {
      authorization: `Bearer ${token}`,
      [CORRELATION_ID_HEADER]: "bad id\twith spaces",
    });
    expect(res.headers.get(CORRELATION_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects an invalid body with 400 and lists the problems", async () => {
    const { app } = setup();
    const res = await postMessage(app, { ...message, source: "email" });
    const body = await expectError(res, 400, "invalid_request");
    expect(body.error.issues?.map((issue) => issue.path)).toContain("source");
  });

  it("rejects a body that is not JSON with 400", async () => {
    const { app } = setup();
    await expectError(await postMessage(app, "{not json"), 400, "invalid_request");
  });

  it("rejects a body over 64 KB with 413", async () => {
    const { app } = setup();
    const res = await postMessage(app, { ...message, text: "x".repeat(70_000) });
    await expectError(res, 413, "invalid_request");
  });

  it("rejects a request without a token with 401", async () => {
    const { app } = setup();
    await expectError(await postMessage(app, message, {}), 401, "unauthorized");
  });

  it("rejects a wrong token with 401", async () => {
    const { app } = setup();
    const res = await postMessage(app, message, { authorization: `Bearer ${"w".repeat(48)}` });
    await expectError(res, 401, "unauthorized");
  });

  it("rejects a token sent without the Bearer scheme", async () => {
    const { app } = setup();
    await expectError(
      await postMessage(app, message, { authorization: token }),
      401,
      "unauthorized",
    );
  });

  it("rejects every request when no token is configured", async () => {
    const { app } = setup({});
    for (const guess of ["Bearer undefined", "Bearer ", "Bearer null", ""]) {
      await expectError(
        await postMessage(app, message, { authorization: guess }),
        401,
        "unauthorized",
      );
    }
  });

  it("rejects every request when the configured token is too short", async () => {
    const { app } = setup({ API_SERVICE_TOKEN: "short" });
    const res = await postMessage(app, message, { authorization: "Bearer short" });
    await expectError(res, 401, "unauthorized");
  });

  it("checks the token before reading the body", async () => {
    const { app } = setup();
    await expectError(await postMessage(app, "{not json", {}), 401, "unauthorized");
  });
});

describe("correlation and logging", () => {
  it("logs rejected requests with the correlation id", async () => {
    const { app, lines } = setup();
    await postMessage(app, message, { [CORRELATION_ID_HEADER]: "Ev-abc" });
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: "auth.rejected", correlationId: "Ev-abc" }),
    );
  });

  it("warns when the correlation id differs from the source event id", async () => {
    const { app, lines } = setup();
    await postMessage(app, message, {
      authorization: `Bearer ${token}`,
      [CORRELATION_ID_HEADER]: "something-else",
    });
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: "message.correlation_mismatch",
        correlationId: "something-else",
      }),
    );
  });

  it("accepts a lower-case bearer scheme", async () => {
    const { app } = setup();
    const res = await postMessage(app, message, { authorization: `bearer ${token}` });
    expect(res.status).toBe(202);
  });

  it("answers an unexpected error with 500 and logs it with the correlation id", async () => {
    const { app, lines } = setup(undefined, () => {
      throw new Error("id generator broke");
    });
    const res = await postMessage(app, message, {
      authorization: `Bearer ${token}`,
      [CORRELATION_ID_HEADER]: "Ev0123456789",
    });
    await expectError(res, 500, "internal");
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: "request.failed",
        correlationId: "Ev0123456789",
        error: expect.objectContaining({ message: "id generator broke" }) as unknown,
      }),
    );
  });
});

describe("other routes", () => {
  it("returns 404 in the standard error shape", async () => {
    const { app } = setup();
    await expectError(await app.request("/nope"), 404, "not_found");
  });
});
