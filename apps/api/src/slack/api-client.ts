import {
  acceptedMessageSchema,
  CORRELATION_ID_HEADER,
  errorResponseSchema,
  type AcceptedMessage,
  type ErrorResponse,
  type InboundMessage,
  confirmDecisionResultSchema,
  type ConfirmDecisionRequest,
  type ConfirmDecisionResult,
  startBriefResultSchema,
  type StartBriefRequest,
  type StartBriefResult,
  stopResultSchema,
  type StopRequest,
  type StopResult,
  observationResultSchema,
  setListeningResponseSchema,
  type Observation,
  type ObservationResult,
  type SetListeningRequest,
  type SetListeningResponse,
  setBriefsResultSchema,
  type SetBriefsRequest,
  type SetBriefsResult,
} from "@hippidy/contracts";

export type PostMessageResult =
  | { kind: "accepted"; accepted: AcceptedMessage }
  | { kind: "rejected"; status: number; error: ErrorResponse["error"] | undefined };

/** What the adapter needs from the API. Defined by the contract, not by the API's code. */
export type StopCallResult =
  | { kind: "done"; result: StopResult }
  | { kind: "rejected"; status: number; error: ErrorResponse["error"] | undefined };

export type StartBriefCallResult =
  | { kind: "done"; result: StartBriefResult }
  | { kind: "rejected"; status: number; error: ErrorResponse["error"] | undefined };

export type SetListeningCallResult =
  | { kind: "done"; result: SetListeningResponse }
  | { kind: "rejected"; status: number; error: ErrorResponse["error"] | undefined };

export type ObserveCallResult =
  | { kind: "done"; result: ObservationResult }
  | { kind: "rejected"; status: number; error: ErrorResponse["error"] | undefined };

export type ConfirmDecisionCallResult =
  | { kind: "done"; result: ConfirmDecisionResult }
  | { kind: "rejected"; status: number; error: ErrorResponse["error"] | undefined };

export type SetBriefsCallResult =
  | { kind: "done"; result: SetBriefsResult }
  | { kind: "rejected"; status: number; error: ErrorResponse["error"] | undefined };

export interface ApiClient {
  postMessage(message: InboundMessage, correlationId: string): Promise<PostMessageResult>;
  stop(request: StopRequest, correlationId: string): Promise<StopCallResult>;
  /** A person pressed Start under a brief (slice 2.1). */
  startBrief(
    briefId: string,
    request: StartBriefRequest,
    correlationId: string,
  ): Promise<StartBriefCallResult>;
  /** A person pressed Confirm under a proposed decision (slice 2.2). */
  confirmDecision(
    decisionId: string,
    request: ConfirmDecisionRequest,
    correlationId: string,
  ): Promise<ConfirmDecisionCallResult>;
  /** Someone said "listen" or "stop listening" in a channel (slice 2.5). */
  setListening(
    request: SetListeningRequest,
    correlationId: string,
  ): Promise<SetListeningCallResult>;
  /** A message was posted, edited or deleted in a channel (slice 2.5). */
  observe(observation: Observation, correlationId: string): Promise<ObserveCallResult>;
  /** Someone wrote "stop briefs" or "start briefs" to the bot (slice 3.4). */
  setBriefs(request: SetBriefsRequest, correlationId: string): Promise<SetBriefsCallResult>;
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
  const send = async (
    method: "POST" | "PUT",
    path: string,
    payload: unknown,
    correlationId: string,
  ) => {
    const request = new Request(new URL(path, options.baseUrl), {
      method,
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
  const post = (path: string, payload: unknown, correlationId: string) =>
    send("POST", path, payload, correlationId);

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

    async confirmDecision(decisionId, request, correlationId) {
      const path = `/v1/decisions/${encodeURIComponent(decisionId)}/confirm`;
      const { status, body } = await post(path, request, correlationId);
      if (status === 202) {
        const result = confirmDecisionResultSchema.safeParse(body);
        if (result.success) return { kind: "done", result: result.data };
      }
      const error = errorResponseSchema.safeParse(body);
      return { kind: "rejected", status, error: error.data?.error };
    },

    async setListening(request, correlationId) {
      const { status, body } = await send("PUT", "/v1/listening", request, correlationId);
      if (status === 200) {
        const result = setListeningResponseSchema.safeParse(body);
        if (result.success) return { kind: "done", result: result.data };
      }
      const error = errorResponseSchema.safeParse(body);
      return { kind: "rejected", status, error: error.data?.error };
    },

    async observe(observation, correlationId) {
      const { status, body } = await post("/v1/observations", observation, correlationId);
      if (status === 200) {
        const result = observationResultSchema.safeParse(body);
        if (result.success) return { kind: "done", result: result.data };
      }
      const error = errorResponseSchema.safeParse(body);
      return { kind: "rejected", status, error: error.data?.error };
    },

    async setBriefs(request, correlationId) {
      const { status, body } = await post("/v1/briefs/people", request, correlationId);
      // Any success status: the route answers with what briefs are now for the person.
      if (status >= 200 && status < 300) {
        const result = setBriefsResultSchema.safeParse(body);
        if (result.success) return { kind: "done", result: result.data };
      }
      const error = errorResponseSchema.safeParse(body);
      return { kind: "rejected", status, error: error.data?.error };
    },

    async startBrief(briefId, request, correlationId) {
      const path = `/v1/briefs/${encodeURIComponent(briefId)}/start`;
      const { status, body } = await post(path, request, correlationId);
      if (status === 202) {
        const result = startBriefResultSchema.safeParse(body);
        if (result.success) return { kind: "done", result: result.data };
      }
      const error = errorResponseSchema.safeParse(body);
      return { kind: "rejected", status, error: error.data?.error };
    },
  };
}
