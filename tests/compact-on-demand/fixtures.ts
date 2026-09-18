/**
 * M2 mock Responses fixtures — synthetic bytes only.
 *
 * Provenance: wire contract read from the pinned client
 * `vendor/codex` @ 5c583fe89bbd3ab4dc9a05768299f94e52fe8452
 * (`codex-rs/core/src/client.rs`, `codex-rs/core/src/client_common.rs`).
 *
 * Prohibited and absent here: prices, currency codes, monetary totals,
 * credentials, real model output, wall-clock or random values.
 * Every id, token count, and text below is a fixed synthetic constant.
 */

export const PIN_SHA = "5c583fe89bbd3ab4dc9a05768299f94e52fe8452";

/** Source anchors for the contract this file encodes. */
export const PIN_SOURCE_REFS = {
  responsesApiRequest: "codex-rs/core/src/client_common.rs:121",
  processSse: "codex-rs/core/src/client.rs:476",
  streamClosedError: "codex-rs/core/src/client.rs:514",
  idleTimeoutError: "codex-rs/core/src/client.rs:491",
  unparseableItemSkip: "codex-rs/core/src/client.rs:566",
  unparseableCompletedIgnore: "codex-rs/core/src/client.rs:628",
  responseFailed: "codex-rs/core/src/client.rs:604",
  responseCompletedUsage: "codex-rs/core/src/client.rs:407",
} as const;

export const TEST_MODEL = "m2-synthetic-model";
/** Loopback-only sentinel. Never a real credential; asserted on every request. */
export const TEST_SENTINEL = "m2-test-sentinel-not-a-credential";
export const TEST_SESSION_ID = "00000000-0000-4000-8000-000000000001";
export const TEST_INSTRUCTIONS = "M2 synthetic instructions; no real model may read this.";

export const RESPONSES_PATH = "/v1/responses";
export const RESPONSES_ROUTE = `${RESPONSES_PATH}`;

/** Exact SSE frame per spec §3.1: `event: <kind>\n` + optional `data: <json>\n` + `\n`. */
export function sseFrame(kind: string, data?: unknown): string {
  const dataLine = data === undefined ? "" : `data: ${JSON.stringify(data)}\n`;
  return `event: ${kind}\n${dataLine}\n`;
}

/** Deterministic ids, one per scenario, so no random UUID can influence an assertion. */
export const RESPONSE_IDS = {
  turn1: "resp_m2_fixture_turn1",
  turn2: "resp_m2_fixture_turn2",
  toolCall: "resp_m2_fixture_tool_call",
  usageFull: "resp_m2_fixture_usage_full",
  usageAbsent: "resp_m2_fixture_usage_absent",
  usageDetailsOmitted: "resp_m2_fixture_usage_details_omitted",
  usageMissingTotal: "resp_m2_fixture_usage_missing_total",
} as const;

export const ASSISTANT_TEXT = "ok";
export const TOOL_NAME = "shell";
export const TOOL_CALL_ID = "call_m2_synthetic_1";
export const TOOL_ARGUMENTS = '{"command":"printf fixture"}';
export const TOOL_OUTPUT_TEXT = "fixture tool output";

/* ------------------------------------------------------------------ */
/* Canonical history fixtures (append-only; I1)                        */
/* ------------------------------------------------------------------ */

export const USER_ITEM_TURN1 = {
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "synthetic turn one" }],
} as const;

export const ASSISTANT_ITEM_TURN1 = {
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: ASSISTANT_TEXT }],
} as const;

export const USER_ITEM_TURN2 = {
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "synthetic turn two" }],
} as const;

export const FUNCTION_CALL_ITEM = {
  type: "function_call",
  name: TOOL_NAME,
  arguments: TOOL_ARGUMENTS,
  call_id: TOOL_CALL_ID,
} as const;

export function functionCallOutputItem(callId: string = TOOL_CALL_ID, output: string = TOOL_OUTPUT_TEXT) {
  return { type: "function_call_output", call_id: callId, output } as const;
}

/** Fallback history returned by the mock after a tool continuation turn. */
export const ASSISTANT_ITEM_AFTER_TOOL = {
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "tool result accepted" }],
} as const;

export const BASE_INPUT = [USER_ITEM_TURN1] as const;
export const TURN1_OUTPUT_ITEMS = [ASSISTANT_ITEM_TURN1] as const;
export const TURN2_OUTPUT_ITEMS = [
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "second turn" }] },
] as const;

/* ------------------------------------------------------------------ */
/* SSE fixtures                                                        */
/* ------------------------------------------------------------------ */

/**
 * Minimum success stream (spec §3.3). `response.created` carries a `response`
 * object because the pinned parser forwards `Created` only when it is present
 * (`client.rs:600`); the spec example omits it and would be a no-op there.
 */
export const MINIMAL_SUCCESS_SSE = [
  sseFrame("response.created", { type: "response.created", response: { id: RESPONSE_IDS.turn1 } }),
  sseFrame("response.output_item.done", {
    type: "response.output_item.done",
    item: ASSISTANT_ITEM_TURN1,
  }),
  sseFrame("response.completed", {
    type: "response.completed",
    response: {
      id: RESPONSE_IDS.turn1,
      usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
    },
  }),
].join("");

/** Golden line-by-line expectation for MINIMAL_SUCCESS_SSE (byte-level framing assertion). */
export const MINIMAL_SUCCESS_SSE_GOLDEN_LINES = [
  "event: response.created",
  `data: {"type":"response.created","response":{"id":"${RESPONSE_IDS.turn1}"}}`,
  "",
  "event: response.output_item.done",
  `data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}`,
  "",
  "event: response.completed",
  `data: {"type":"response.completed","response":{"id":"${RESPONSE_IDS.turn1}","usage":{"input_tokens":10,"output_tokens":1,"total_tokens":11}}}`,
  "",
  "",
] as const;

export const TOOL_CALL_SSE = [
  sseFrame("response.created", { type: "response.created", response: { id: RESPONSE_IDS.toolCall } }),
  sseFrame("response.output_item.done", {
    type: "response.output_item.done",
    item: FUNCTION_CALL_ITEM,
  }),
  sseFrame("response.completed", {
    type: "response.completed",
    response: { id: RESPONSE_IDS.toolCall, usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } },
  }),
].join("");

export const TOOL_CONTINUATION_SSE = [
  sseFrame("response.created", { type: "response.created", response: { id: RESPONSE_IDS.turn2 } }),
  sseFrame("response.output_item.done", {
    type: "response.output_item.done",
    item: ASSISTANT_ITEM_AFTER_TOOL,
  }),
  sseFrame("response.completed", {
    type: "response.completed",
    response: { id: RESPONSE_IDS.turn2, usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } },
  }),
].join("");

/** Stream body that never reaches `response.completed` (M2-T10). */
export const TRUNCATED_SSE = [
  sseFrame("response.created", { type: "response.created", response: { id: RESPONSE_IDS.turn1 } }),
  sseFrame("response.output_item.done", {
    type: "response.output_item.done",
    item: ASSISTANT_ITEM_TURN1,
  }),
].join("");

/** `response.failed` with a rate-limit error; delay is parsed per `try_parse_retry_after` (M2-T11). */
export const FAILED_SSE = [
  sseFrame("response.created", { type: "response.created", response: { id: RESPONSE_IDS.turn1 } }),
  sseFrame("response.failed", {
    type: "response.failed",
    response: {
      id: RESPONSE_IDS.turn1,
      error: {
        code: "rate_limit_exceeded",
        type: "server_error",
        message: "Please try again in 1.898s",
      },
    },
  }),
].join("");

export const FAILED_SSE_MESSAGE = "Please try again in 1.898s";
export const FAILED_SSE_RETRY_AFTER_MS = 1898;

/** `response.output_item.done` whose item cannot deserialize as a ResponseItem (M2-T12). */
export const UNPARSEABLE_ITEM_SSE = [
  sseFrame("response.created", { type: "response.created", response: { id: RESPONSE_IDS.turn1 } }),
  sseFrame("response.output_item.done", {
    type: "response.output_item.done",
    item: { type: "message" },
  }),
  sseFrame("response.output_item.done", {
    type: "response.output_item.done",
    item: ASSISTANT_ITEM_TURN1,
  }),
  sseFrame("response.completed", {
    type: "response.completed",
    response: { id: RESPONSE_IDS.turn1, usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } },
  }),
].join("");

/** `response.completed.response` without the required `id` (M2-T13). */
export const UNPARSEABLE_COMPLETED_SSE = [
  sseFrame("response.created", { type: "response.created", response: { id: RESPONSE_IDS.turn1 } }),
  sseFrame("response.output_item.done", {
    type: "response.output_item.done",
    item: ASSISTANT_ITEM_TURN1,
  }),
  sseFrame("response.completed", {
    type: "response.completed",
    response: { usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } },
  }),
].join("");

/* ------------------------------------------------------------------ */
/* Usage fixtures (spec §3.4) — synthetic token counts, never money    */
/* ------------------------------------------------------------------ */

export const USAGE_FULL = {
  input_tokens: 1200,
  input_tokens_details: { cached_tokens: 1024, cache_write_tokens: 176 },
  output_tokens: 40,
  output_tokens_details: { reasoning_tokens: 24 },
  total_tokens: 1240,
} as const;

/** Usage with the detail objects omitted (M2-T19): cache fields must stay unavailable. */
export const USAGE_DETAILS_OMITTED = {
  input_tokens: 1200,
  output_tokens: 40,
  total_tokens: 1240,
} as const;

/** Usage missing the required `total_tokens` (M2-T19b pin-parser case). */
export const USAGE_MISSING_TOTAL = {
  input_tokens: 1200,
  output_tokens: 40,
} as const;

/** Usage present but not an object (hostile payload; must not be inferred from). */
export const USAGE_NON_OBJECT = "unavailable" as const;

export function successSseWithUsage(id: string, usage: unknown): string {
  return [
    sseFrame("response.created", { type: "response.created", response: { id } }),
    sseFrame("response.output_item.done", {
      type: "response.output_item.done",
      item: ASSISTANT_ITEM_TURN1,
    }),
    sseFrame("response.completed", { type: "response.completed", response: { id, usage } }),
  ].join("");
}

export const USAGE_FULL_SSE = successSseWithUsage(RESPONSE_IDS.usageFull, USAGE_FULL);
export const USAGE_ABSENT_SSE = successSseWithUsage(RESPONSE_IDS.usageAbsent, undefined);
export const USAGE_DETAILS_OMITTED_SSE = successSseWithUsage(
  RESPONSE_IDS.usageDetailsOmitted,
  USAGE_DETAILS_OMITTED,
);
export const USAGE_MISSING_TOTAL_SSE = successSseWithUsage(
  RESPONSE_IDS.usageMissingTotal,
  USAGE_MISSING_TOTAL,
);
