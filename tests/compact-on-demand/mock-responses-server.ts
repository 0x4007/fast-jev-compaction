/**
 * M2 mock Responses server — loopback-only, synthetic, test-only.
 *
 * Binds `127.0.0.1` with an OS-assigned port; never contacts a non-loopback
 * host; reads no environment variable and no credential. Request framing is
 * validated against the pinned client contract (see fixtures.ts provenance).
 */

import {
  FAILED_SSE,
  MINIMAL_SUCCESS_SSE,
  RESPONSES_PATH,
  TEST_SENTINEL,
  TOOL_CALL_SSE,
  TOOL_CONTINUATION_SSE,
  TRUNCATED_SSE,
  UNPARSEABLE_COMPLETED_SSE,
  UNPARSEABLE_ITEM_SSE,
  USAGE_ABSENT_SSE,
  USAGE_DETAILS_OMITTED_SSE,
  USAGE_FULL_SSE,
  USAGE_MISSING_TOTAL_SSE,
} from "./fixtures.ts";

export type Scenario =
  | "success"
  | "success-then-success"
  | "tool-call"
  | "http-500"
  | "http-429"
  | "json-body-200"
  | "truncated"
  | "failed"
  | "unparseable-item"
  | "unparseable-completed"
  | "abort-mid-stream"
  | "stall"
  | "usage-full"
  | "usage-absent"
  | "usage-details-omitted"
  | "usage-missing-total"
  | "epoch-sequence";

export interface RecordedRequest {
  method: string;
  path: string;
  contentType: string | null;
  accept: string | null;
  authorization: string | null;
  beta: string | null;
  conversationId: string | null;
  sessionId: string | null;
  rawBody: string;
  body: Record<string, unknown>;
  /** Server-side count of `function_call` items emitted (I4 dispatch count). */
  emittedFunctionCalls: number;
}

export interface MockResponsesServer {
  readonly origin: string;
  readonly baseUrl: string;
  readonly port: number;
  readonly requests: RecordedRequest[];
  /** Framing violations observed on the wire; every test asserts this is empty. */
  readonly violations: string[];
  /** Any non-`POST /v1/responses` hit; model-only tests assert this is empty. */
  readonly unknownRouteHits: string[];
  /** Number of `function_call` items emitted by this server instance. */
  emittedFunctionCalls(): number;
  stop(): Promise<void>;
}

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-store",
} as const;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(body: string): Response {
  return new Response(body, { status: 200, headers: SSE_HEADERS });
}

/** Enqueues partial bytes, then errors the stream on the next pull (abrupt close, M2-T14). */
function abortingSseResponse(partial: string): Response {
  const encoder = new TextEncoder();
  let pulled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!pulled) {
        pulled = true;
        controller.enqueue(encoder.encode(partial));
        return;
      }
      controller.error(new Error("mock connection reset mid-stream"));
    },
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

/** Headers arrive, then the body stays silent forever (M2-T15 idle timeout). */
function stallingSseResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start() {
      // Intentionally never enqueues and never closes.
    },
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

function scenarioResponse(scenario: Scenario, requestIndex: number): Response {
  switch (scenario) {
    case "success":
    case "success-then-success":
      return sseResponse(MINIMAL_SUCCESS_SSE);
    case "tool-call":
      return sseResponse(requestIndex === 1 ? TOOL_CALL_SSE : TOOL_CONTINUATION_SSE);
    case "http-500":
      return jsonResponse(500, { error: { message: "synthetic internal error", type: "server_error" } });
    case "http-429":
      return new Response(
        JSON.stringify({ error: { message: "synthetic rate limit", type: "rate_limit_exceeded" } }),
        {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "0" },
        },
      );
    case "json-body-200":
      return new Response(JSON.stringify({ error: "not an SSE stream" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    case "truncated":
      return sseResponse(TRUNCATED_SSE);
    case "failed":
      return sseResponse(FAILED_SSE);
    case "unparseable-item":
      return sseResponse(UNPARSEABLE_ITEM_SSE);
    case "unparseable-completed":
      return sseResponse(UNPARSEABLE_COMPLETED_SSE);
    case "abort-mid-stream":
      return abortingSseResponse(TRUNCATED_SSE);
    case "stall":
      return stallingSseResponse();
    case "usage-full":
      return sseResponse(USAGE_FULL_SSE);
    case "usage-absent":
      return sseResponse(USAGE_ABSENT_SSE);
    case "usage-details-omitted":
      return sseResponse(USAGE_DETAILS_OMITTED_SSE);
    case "usage-missing-total":
      return sseResponse(USAGE_MISSING_TOTAL_SSE);
    case "epoch-sequence":
      // Turn 1: changed cache epoch, no cache fields reported. Turn 2: same epoch with cached tokens.
      return sseResponse(requestIndex === 1 ? MINIMAL_SUCCESS_SSE : USAGE_FULL_SSE);
  }
}

/** Counts `function_call` items actually emitted in a scenario body. */
function countEmittedFunctionCalls(scenario: Scenario, requestIndex: number): number {
  if (scenario !== "tool-call") return 0;
  return requestIndex === 1 ? 1 : 0;
}

export async function startMockResponsesServer(scenario: Scenario): Promise<MockResponsesServer> {
  const requests: RecordedRequest[] = [];
  const violations: string[] = [];
  const unknownRouteHits: string[] = [];
  let emittedFunctionCalls = 0;
  const controller = new AbortController();
  let listenResolve: (port: number) => void;
  const listening = new Promise<number>((resolve) => {
    listenResolve = resolve;
  });

  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: controller.signal,
      onListen: ({ port }) => listenResolve(port),
    },
    async (req) => {
      const url = new URL(req.url);

      if (req.method !== "POST" || url.pathname !== RESPONSES_PATH) {
        unknownRouteHits.push(`${req.method} ${url.pathname}`);
        return jsonResponse(404, { error: { message: "unknown route" } });
      }

      const rawBody = await req.text();
      const authorization = req.headers.get("authorization");
      const contentType = req.headers.get("content-type");
      const accept = req.headers.get("accept");

      if (!contentType?.toLowerCase().startsWith("application/json")) {
        violations.push(`content-type is not JSON: ${contentType ?? "<absent>"}`);
      }
      if (accept !== "text/event-stream") {
        violations.push(`accept is not text/event-stream: ${accept ?? "<absent>"}`);
      }
      if (authorization !== `Bearer ${TEST_SENTINEL}`) {
        violations.push("authorization is not the loopback sentinel");
        return jsonResponse(401, { error: { message: "sentinel authorization required" } });
      }

      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(rawBody);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return jsonResponse(400, { error: { message: "body must be a JSON object" } });
        }
        body = parsed as Record<string, unknown>;
      } catch {
        return jsonResponse(400, { error: { message: "invalid JSON body" } });
      }

      const requestIndex = requests.length + 1;
      emittedFunctionCalls += countEmittedFunctionCalls(scenario, requestIndex);
      requests.push({
        method: req.method,
        path: url.pathname,
        contentType,
        accept,
        authorization,
        beta: req.headers.get("openai-beta"),
        conversationId: req.headers.get("conversation_id"),
        sessionId: req.headers.get("session_id"),
        rawBody,
        body,
        emittedFunctionCalls,
      });

      return scenarioResponse(scenario, requestIndex);
    },
  );

  const port = await listening;
  return {
    origin: `http://127.0.0.1:${port}`,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    violations,
    unknownRouteHits,
    emittedFunctionCalls: () => emittedFunctionCalls,
    stop: async () => {
      // Abort first so a stalled in-flight body cannot block graceful shutdown.
      controller.abort();
      await server.shutdown().catch(() => {});
    },
  };
}
