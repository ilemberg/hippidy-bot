import {
  acceptedMessageSchema,
  CORRELATION_ID_HEADER,
  errorResponseSchema,
  type AcceptedMessage,
  type ErrorResponse,
  type InboundMessage,
  stopResultSchema,
  type StopRequest,
  type StopResult,
} from "@hippidy/contracts";

export type PostMessageResult =
  | { kind: "accepted"; accepted: AcceptedMessage }
  | { kind: "rejected"; status: number; error: ErrorResponse["error"] | undefined };

/** What the adapter needs from the API. Defined by the contract, not by the API's code. */
export type StopCallResult =
  | { kind: "done"; result: StopResult }
  | { kind: "rejected"; status: number; error: ErrorResponse["error"] | undefined };

export interface ApiClient {
  postMessage(message: InboundMessage, correlationId: string): Promise<PostMessageResult>;
  stop(request: StopRequest, correlationId: string): Promise<StopCallResult>;
}

/** The parts of an HTTP response the client reads. */
export interface ResponseLike {
  status: number;
  json(): Promise<unknown>;
}

/**
 * Anything that answers a `Request` the way the API's HTTP interface does. Typed by shape, not
 * as the global `Response`, which Vercel's build type-checks differently from `tsc`.
 */
export type FetchLike = (request: Request) => ResponseLike | Promise<ResponseLike>;

/**
 * Calls the API through its public route, auth check and validation. Today `fetch` is the app's
 * own in-process handler; pointing it at the network is the only change needed to split them.
 */
export function createApiClient(options: {
  fetch: FetchLike;
  baseUrl: string;
  serviceToken: string | undefined;
}): ApiClient {
  const post = async (path: string, payload: unknown, correlationId: string) => {
    const request = new Request(new URL(path, options.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CORRELATION_ID_HEADER]: correlationId,
        // Sent even when unset, so the API (which fails closed) is the one that decides.
        authorization: `Bearer ${options.serviceToken ?? ""}`,
      },
      body: JSON.stringify(payload),
    });
    const response = await options.fetch(request);
    const body: unknown = await response.json().catch((): undefined => undefined);
    return { status: response.status, body };
  };

  return {
    async postMessage(message, correlationId) {
      const { status, body } = await post("/v1/messages", message, correlationId);
      const response = { status };

      if (response.status === 202) {
        const accepted = acceptedMessageSchema.safeParse(body);
        if (accepted.success) return { kind: "accepted", accepted: accepted.data };
      }
      const error = errorResponseSchema.safeParse(body);
      return { kind: "rejected", status: response.status, error: error.data?.error };
    },

    async stop(request, correlationId) {
      const { status, body } = await post("/v1/stop", request, correlationId);
      if (status === 202) {
        const result = stopResultSchema.safeParse(body);
        if (result.success) return { kind: "done", result: result.data };
      }
      const error = errorResponseSchema.safeParse(body);
      return { kind: "rejected", status, error: error.data?.error };
    },
  };
}
