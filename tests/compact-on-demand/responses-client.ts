/**
 * M2 Responses wire-contract harness (client double).
 *
 * This is NOT the pinned Rust client and must never be reported as such. It is
 * a credential-free Deno/TS double that reproduces the pinned client's wire
 * behavior, line-referenced in `fixtures.ts: PIN_SOURCE_REFS`, so the mock
 * server contract can be exercised without a Rust build:
 *
 * - request body shape of `ResponsesApiRequest` (client_common.rs:121)
 * - SSE event handling of `process_sse` (client.rs:476)
 * - exact terminal errors "stream closed before response.completed"
 *   (client.rs:514) and "idle timeout waiting for SSE" (client.rs:491)
 * - unparseable `output_item.done.item` skipped (client.rs:566)
 * - unparseable `response.completed.response` ignored (client.rs:628)
 * - `response.failed` error surfacing (client.rs:604)
 * - retry/status behavior (client.rs:227-360): retries only 429/401/5xx up to
 *   `request_max_retries`, then `UnexpectedStatus`/`InternalServerError`/
 *   `RetryLimit`.
 *
 * Usage is retained twice and never merged: `usageRaw` is the opaque JSON the
 * provider sent, `usage` is the explicit availability record (missing fields
 * are `"unavailable"`, never 0). No estimator, price, or currency exists here.
 */

import type { RecordedRequest } from "./mock-responses-server.ts";
import { TEST_MODEL, TEST_SENTINEL, TEST_SESSION_ID } from "./fixtures.ts";

export const REQUEST_REQUIRED_KEYS = [
  "model",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "store",
  "stream",
  "include",
] as const;

export const REQUEST_OPTIONAL_KEYS = ["prompt_cache_key", "text"] as const;

export interface ResponsesRequestOptions {
  model?: string;
  instructions?: string;
  input: readonly unknown[];
  tools?: readonly unknown[];
  promptCacheKey?: string;
}

/** Builds the exact `ResponsesApiRequest` body the pinned client serializes. */
export function buildResponsesRequest(options: ResponsesRequestOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options.model ?? TEST_MODEL,
    instructions: options.instructions ?? "M2 synthetic instructions.",
    input: options.input,
    tools: options.tools ?? [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: { effort: "low", summary: "auto" },
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
  };
  if (options.promptCacheKey !== undefined) body.prompt_cache_key = options.promptCacheKey;
  return body;
}

export type HarnessErrorKind =
  | "stream"
  | "idle_timeout"
  | "unexpected_status"
  | "internal_server_error"
  | "retry_limit"
  | "connect";

export class HarnessError extends Error {
  readonly kind: HarnessErrorKind;
  readonly status?: number;
  readonly body?: string;
  readonly retryAfterMs?: number;

  constructor(
    kind: HarnessErrorKind,
    message: string,
    status?: number,
    body?: string,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "HarnessError";
    this.kind = kind;
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ParsedSseEvent {
  kind: string;
  data: unknown;
  rawData: string;
}

/** Parses standard SSE frames; returns only frames carrying an `event:` kind. */
export function parseSseEvents(text: string): ParsedSseEvent[] {
  const events: ParsedSseEvent[] = [];
  for (const block of text.split("\n\n")) {
    if (block.trim().length === 0) continue;
    let kind: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) kind = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
    if (kind === undefined) continue;
    const rawData = dataLines.join("\n");
    let data: unknown;
    if (rawData.length > 0) {
      try {
        data = JSON.parse(rawData);
      } catch {
        // Pinned parser skips events whose data does not deserialize.
        continue;
      }
    }
    events.push({ kind, data, rawData });
  }
  return events;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Minimal `ResponseItem` deserialization contract used by `output_item.done`. */
export function isParseableResponseItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "message":
      return typeof value.role === "string" && Array.isArray(value.content);
    case "function_call":
      return typeof value.name === "string" && typeof value.arguments === "string" &&
        typeof value.call_id === "string";
    case "function_call_output":
      return typeof value.call_id === "string" && typeof value.output === "string";
    case "reasoning":
      return true;
    default:
      return false;
  }
}

export interface TypedUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_input_tokens: number;
  reasoning_output_tokens: number;
}

export interface TypedCompleted {
  id: string;
  usage: TypedUsage | null;
  usageRaw: unknown;
}

/**
 * Mirrors `ResponseCompleted` (client.rs:407): `id` and the three base token
 * counts are required; detail objects are optional. Unknown detail keys such as
 * `cache_write_tokens` are dropped by the pinned typed view and remain only in
 * `usageRaw`.
 */
export function parseResponseCompleted(value: unknown): TypedCompleted | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string") return null;
  const rawUsage = value.usage;
  if (rawUsage === undefined || rawUsage === null) {
    return { id: value.id, usage: null, usageRaw: "unavailable" };
  }
  if (!isRecord(rawUsage)) return null;
  const input = asNumber(rawUsage.input_tokens);
  const output = asNumber(rawUsage.output_tokens);
  const total = asNumber(rawUsage.total_tokens);
  if (input === undefined || output === undefined || total === undefined) return null;
  let cached = 0;
  if (rawUsage.input_tokens_details !== undefined) {
    if (!isRecord(rawUsage.input_tokens_details)) return null;
    cached = asNumber(rawUsage.input_tokens_details.cached_tokens) ?? 0;
  }
  let reasoning = 0;
  if (rawUsage.output_tokens_details !== undefined) {
    if (!isRecord(rawUsage.output_tokens_details)) return null;
    reasoning = asNumber(rawUsage.output_tokens_details.reasoning_tokens) ?? 0;
  }
  return {
    id: value.id,
    usage: {
      input_tokens: input,
      output_tokens: output,
      total_tokens: total,
      cached_input_tokens: cached,
      reasoning_output_tokens: reasoning,
    },
    usageRaw: rawUsage,
  };
}

/* ------------------------------------------------------------------ */
/* Usage record — explicit availability, never a zero assumption (I15) */
/* ------------------------------------------------------------------ */

export const USAGE_FIELD_NAMES = [
  "input_tokens",
  "cached_tokens",
  "cache_write_tokens",
  "output_tokens",
  "reasoning_tokens",
  "total_tokens",
] as const;

export type UsageFieldName = (typeof USAGE_FIELD_NAMES)[number];
export type UsageFieldValue = number | "unavailable";

export interface UsageRecord {
  status: "reported" | "unavailable";
  source: "response.completed.usage";
  fields: Record<UsageFieldName, UsageFieldValue>;
  savings_claim: "none";
}

function field(raw: unknown, path: readonly string[]): UsageFieldValue {
  let current: unknown = raw;
  for (const key of path) {
    if (!isRecord(current)) return "unavailable";
    current = current[key];
  }
  return asNumber(current) ?? "unavailable";
}

/** Records opaque raw usage. Missing fields are `"unavailable"`, never inferred. */
export function recordUsage(usageRaw: unknown): UsageRecord {
  if (!isRecord(usageRaw)) {
    return {
      status: "unavailable",
      source: "response.completed.usage",
      fields: {
        input_tokens: "unavailable",
        cached_tokens: "unavailable",
        cache_write_tokens: "unavailable",
        output_tokens: "unavailable",
        reasoning_tokens: "unavailable",
        total_tokens: "unavailable",
      },
      savings_claim: "none",
    };
  }
  const fields: Record<UsageFieldName, UsageFieldValue> = {
    input_tokens: field(usageRaw, ["input_tokens"]),
    cached_tokens: field(usageRaw, ["input_tokens_details", "cached_tokens"]),
    cache_write_tokens: field(usageRaw, ["input_tokens_details", "cache_write_tokens"]),
    output_tokens: field(usageRaw, ["output_tokens"]),
    reasoning_tokens: field(usageRaw, ["output_tokens_details", "reasoning_tokens"]),
    total_tokens: field(usageRaw, ["total_tokens"]),
  };
  const status = USAGE_FIELD_NAMES.some((name) => fields[name] !== "unavailable")
    ? "reported"
    : "unavailable";
  return { status, source: "response.completed.usage", fields, savings_claim: "none" };
}

/* ------------------------------------------------------------------ */
/* Turn execution                                                      */
/* ------------------------------------------------------------------ */

export interface TurnResult {
  ok: true;
  responseId: string;
  createdForwarded: boolean;
  outputItems: unknown[];
  skippedItems: unknown[];
  skippedCompleted: unknown[];
  typedUsage: TypedUsage | null;
  /** Opaque raw usage as sent by the provider; never merged with an estimate. */
  usageRaw: unknown;
  /** Separate availability record; kept distinct from any cost estimate. */
  usage: UsageRecord;
  /** No estimator exists in M2; explicitly null so usage cannot silently merge into it. */
  costEstimate: null;
  events: ParsedSseEvent[];
  requestBody: Record<string, unknown>;
}

export interface SendTurnOptions {
  baseUrl: string;
  body: Record<string, unknown>;
  requestMaxRetries?: number;
  /** Deterministic zero backoff; only retry counts are asserted. */
  backoffMs?: (attempt: number) => number;
  streamIdleTimeoutMs?: number;
  sentinel?: string;
  fetchImpl?: typeof fetch;
}

export async function sendResponsesTurn(options: SendTurnOptions): Promise<TurnResult> {
  const {
    baseUrl,
    body,
    requestMaxRetries = 0,
    backoffMs = () => 0,
    streamIdleTimeoutMs = 2_000,
    sentinel = TEST_SENTINEL,
    fetchImpl = fetch,
  } = options;

  const url = `${baseUrl}/responses`;
  let attempt = 0;

  while (true) {
    attempt += 1;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "text/event-stream",
          "authorization": `Bearer ${sentinel}`,
          "openai-beta": "responses=experimental",
          "conversation_id": TEST_SESSION_ID,
          "session_id": TEST_SESSION_ID,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (attempt > requestMaxRetries) {
        throw new HarnessError("connect", `request failed: ${String(error)}`);
      }
      await sleep(backoffMs(attempt));
      continue;
    }

    if (response.ok) {
      return await consumeTurn(response, body, streamIdleTimeoutMs);
    }

    const status = response.status;
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterMs = retryAfterHeader === null ? undefined : Number(retryAfterHeader) * 1000;
    const errorBody = await response.text().catch(() => "");

    if (!(status === 429 || status === 401 || status >= 500)) {
      throw new HarnessError(
        "unexpected_status",
        `unexpected status ${status}`,
        status,
        errorBody,
      );
    }
    if (attempt > requestMaxRetries) {
      if (status === 500) {
        throw new HarnessError("internal_server_error", "internal server error", status, errorBody);
      }
      throw new HarnessError("retry_limit", `retry limit reached for status ${status}`, status, errorBody);
    }
    await sleep(retryAfterMs ?? backoffMs(attempt));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function consumeTurn(
  response: Response,
  requestBody: Record<string, unknown>,
  idleTimeoutMs: number,
): Promise<TurnResult> {
  const events = await readSseStream(response, idleTimeoutMs);

  let createdForwarded = false;
  let completed: TypedCompleted | null = null;
  let failure: { message: string; retryAfterMs?: number } | null = null;
  const outputItems: unknown[] = [];
  const skippedItems: unknown[] = [];
  const skippedCompleted: unknown[] = [];

  for (const event of events) {
    switch (event.kind) {
      case "response.created":
        // client.rs:600 forwards Created only when a `response` object is present.
        if (isRecord(event.data) && event.data.response !== undefined) createdForwarded = true;
        break;
      case "response.output_item.done": {
        if (!isRecord(event.data)) break;
        const item = event.data.item;
        if (item === undefined) break;
        if (!isParseableResponseItem(item)) {
          skippedItems.push(item);
          break;
        }
        outputItems.push(item);
        break;
      }
      case "response.failed": {
        if (!isRecord(event.data)) break;
        const responseValue = event.data.response;
        if (responseValue === undefined) break;
        let message = "response.failed event received";
        let retryAfterMs: number | undefined;
        if (isRecord(responseValue)) {
          const error = responseValue.error;
          if (isRecord(error)) {
            if (typeof error.message === "string") message = error.message;
            retryAfterMs = parseRetryAfterFromError(error);
          }
        }
        failure = { message, retryAfterMs };
        break;
      }
      case "response.completed": {
        if (!isRecord(event.data)) break;
        const responseValue = event.data.response;
        if (responseValue === undefined) break;
        const parsed = parseResponseCompleted(responseValue);
        if (parsed === null) {
          skippedCompleted.push(responseValue);
          break;
        }
        completed = parsed;
        break;
      }
      default:
        break;
    }
  }

  if (completed !== null) {
    return {
      ok: true,
      responseId: completed.id,
      createdForwarded,
      outputItems,
      skippedItems,
      skippedCompleted,
      typedUsage: completed.usage,
      usageRaw: completed.usageRaw,
      usage: recordUsage(completed.usageRaw),
      costEstimate: null,
      events,
      requestBody,
    };
  }
  if (failure !== null) {
    throw new HarnessError("stream", failure.message, undefined, undefined, failure.retryAfterMs);
  }
  throw new HarnessError("stream", "stream closed before response.completed");
}

/** Mirrors `try_parse_retry_after` (client.rs:711): code + "Please try again in Ns|ms". */
export function parseRetryAfterFromError(error: Record<string, unknown>): number | undefined {
  if (error.code !== "rate_limit_exceeded") return undefined;
  const message = typeof error.message === "string" ? error.message : "";
  const match = /try again in ([\d.]+)(ms|s)/.exec(message);
  if (match === null) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  return match[2] === "s" ? value * 1000 : value;
}

async function readSseStream(response: Response, idleTimeoutMs: number): Promise<ParsedSseEvent[]> {
  if (response.body === null) {
    throw new HarnessError("stream", "stream closed before response.completed");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: ParsedSseEvent[] = [];
  let buffer = "";

  const flush = (block: string) => {
    for (const event of parseSseEvents(`${block}\n\n`)) events.push(event);
  };

  try {
    while (true) {
      const result = await withIdleTimeout(reader, idleTimeoutMs);
      if (result.done) {
        buffer += decoder.decode();
        if (buffer.trim().length > 0) flush(buffer);
        break;
      }
      buffer += decoder.decode(result.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        flush(block);
        boundary = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("stream", `SSE error: ${String(error)}`);
  }
  return events;
}

function withIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const read = reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new HarnessError("idle_timeout", "idle timeout waiting for SSE"));
    }, idleTimeoutMs);
  });
  return Promise.race([read, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/* ------------------------------------------------------------------ */
/* History and fixture-append helpers (I1)                             */
/* ------------------------------------------------------------------ */

/** Appends items and proves the previous history is preserved as an exact prefix. */
export function appendHistory(
  previous: readonly unknown[],
  items: readonly unknown[],
): unknown[] {
  const next = [...previous, ...items];
  assertHistoryAppendOnly(previous, next);
  return next;
}

export function assertHistoryAppendOnly(previous: readonly unknown[], next: readonly unknown[]): void {
  if (next.length < previous.length) {
    throw new Error("history shrank: append-only invariant violated");
  }
  for (let index = 0; index < previous.length; index += 1) {
    const before = JSON.stringify(previous[index]);
    const after = JSON.stringify(next[index]);
    if (before !== after) {
      throw new Error(`history item ${index} changed: append-only invariant violated`);
    }
  }
}

/** Adds the tool result for a dispatched call; used to build the continuation request. */
export function appendFunctionCallOutput(
  history: readonly unknown[],
  callItem: { call_id: string },
  output: string,
): unknown[] {
  return appendHistory(history, [
    { type: "function_call_output", call_id: callItem.call_id, output },
  ]);
}

/** Tool executor used by tests; counts dispatches so I4 (no replay) is provable. */
export class DispatchLedger {
  readonly dispatches: string[] = [];

  dispatch(callItem: { call_id: string; name: string; arguments: string }): string {
    this.dispatches.push(callItem.call_id);
    return `fixture output for ${callItem.call_id}`;
  }

  get count(): number {
    return this.dispatches.length;
  }
}

/* ------------------------------------------------------------------ */
/* Loopback and credential-free assertions                             */
/* ------------------------------------------------------------------ */

export function assertLoopbackOrigin(origin: string): void {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) {
    throw new Error(`origin is not loopback: ${origin}`);
  }
}

export function assertSentinelOnly(requests: readonly RecordedRequest[], sentinel = TEST_SENTINEL): void {
  for (const request of requests) {
    if (request.authorization !== `Bearer ${sentinel}`) {
      throw new Error("a request did not carry the loopback sentinel authorization");
    }
  }
}
