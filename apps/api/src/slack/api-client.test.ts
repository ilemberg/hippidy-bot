import { CORRELATION_ID_HEADER, type InboundMessage } from "@hippidy/contracts";
import { describe, expect, it } from "vitest";
import { createApiClient, type FetchLike } from "./api-client.ts";

const message: InboundMessage = {
  source: "slack",
  sourceEventId: "Ev1",
  conversation: { workspaceId: "T1", channelId: "C1", threadId: "1.1", messageId: "1.1" },
  actor: { id: "U1" },
  text: "hi",
  sentAt: "2026-11-18T00:00:00.000Z",
};

function client(respond: (request: Request) => Response, serviceToken?: string) {
  const seen: Request[] = [];
  const fetch: FetchLike = (request) => {
    seen.push(request);
    return respond(request);
  };
  return {
    api: createApiClient({ fetch, baseUrl: "http://in-process.invalid", serviceToken }),
    seen,
  };
}

const acceptedBody = { id: "0b6c9a52-2c43-4a8e-9f5e-0d5f2b0a4c11", status: "accepted" };

describe("createApiClient", () => {
  it("posts the message with the token and correlation id, and reads a 202", async () => {
    const { api, seen } = client(() => Response.json(acceptedBody, { status: 202 }), "tok");
    expect(await api.postMessage(message, "Ev1")).toEqual({
      kind: "accepted",
      accepted: acceptedBody,
    });
    const request = seen[0];
    expect(request?.url).toBe("http://in-process.invalid/v1/messages");
    expect(request?.headers.get("authorization")).toBe("Bearer tok");
    expect(request?.headers.get(CORRELATION_ID_HEADER)).toBe("Ev1");
    expect(await request?.json()).toEqual(message);
  });

  it("returns the API's error for a rejection", async () => {
    const error = { code: "unauthorized", message: "no" };
    const { api } = client(() => Response.json({ error }, { status: 401 }));
    expect(await api.postMessage(message, "Ev1")).toEqual({ kind: "rejected", status: 401, error });
  });

  it("treats a 202 with a body that breaks the contract as a failure", async () => {
    const { api } = client(() => Response.json({ id: "not-a-uuid" }, { status: 202 }));
    expect(await api.postMessage(message, "Ev1")).toEqual({
      kind: "rejected",
      status: 202,
      error: undefined,
    });
  });

  it("copes with a body that is not JSON", async () => {
    const { api } = client(() => new Response("gateway exploded", { status: 502 }));
    expect(await api.postMessage(message, "Ev1")).toEqual({
      kind: "rejected",
      status: 502,
      error: undefined,
    });
  });

  it("still sends the header when no token is configured, so the API decides", async () => {
    const { api, seen } = client(() => Response.json({}, { status: 401 }));
    await api.postMessage(message, "Ev1");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer");
  });
});
