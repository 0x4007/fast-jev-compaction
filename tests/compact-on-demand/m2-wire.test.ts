/**
 * M2 mock Responses wire tests — matrix rows M2-T01…T16 plus invariants.
 *
 * Client under test: this repository's Deno wire-contract harness (a client
 * double, see `responses-client.ts`). The pinned Rust client
 * (`vendor/codex` @ 5c583fe89bbd3ab4dc9a05768299f94e52fe8452) is not built in
 * this assignment; the exact blocker is recorded in the handback. No test here
 * may be reported as pinned-client execution.
 *
 * Run: deno test --allow-net=127.0.0.1 tests/compact-on-demand
 */

import { assert, assertEquals, assertThrows } from "./assert.ts";
import {
  ASSISTANT_ITEM_TURN1,
  BASE_INPUT,
  FAILED_SSE_MESSAGE,
  FUNCTION_CALL_ITEM,
  MINIMAL_SUCCESS_SSE,
  MINIMAL_SUCCESS_SSE_GOLDEN_LINES,
  PIN_SHA,
  RESPONSE_IDS,
  TEST_INSTRUCTIONS,
  TEST_MODEL,
  TEST_SESSION_ID,
  TOOL_CALL_ID,
  TURN1_OUTPUT_ITEMS,
  TURN2_OUTPUT_ITEMS,
  USER_ITEM_TURN2,
} from "./fixtures.ts";
import { startMockResponsesServer } from "./mock-responses-server.ts";
import {
  appendFunctionCallOutput,
  appendHistory,
  assertHistoryAppendOnly,
  assertLoopbackOrigin,
  assertSentinelOnly,
  buildResponsesRequest,
  DispatchLedger,
  HarnessError,
  REQUEST_OPTIONAL_KEYS,
  REQUEST_REQUIRED_KEYS,
  sendResponsesTurn,
} from "./responses-client.ts";

/** Credential probe lives in the test, never in the harness sources (kept env-free). */
function probeCredentialAccess(): {
  envState: Deno.PermissionState;
  readThrew: boolean;
  credentialPresence: Record<string, boolean>;
} {
  const names = ["OPENAI_API_KEY", "TYPESAFE_API_KEY"];
  const envState = Deno.permissions.querySync({ name: "env" }).state;
  let readThrew = false;
  const credentialPresence: Record<string, boolean> = {};
  for (const name of names) {
    try {
      // Presence boolean only; the value is never assigned or logged.
      credentialPresence[name] = Deno.env.get(name) !== undefined;
    } catch {
      readThrew = true;
      credentialPresence[name] = false;
    }
  }
  return { envState, readThrew, credentialPresence };
}

async function captureHarnessError(fn: () => Promise<unknown>): Promise<HarnessError> {
  try {
    await fn();
  } catch (error) {
    assert(error instanceof HarnessError, `expected HarnessError, got ${String(error)}`);
    return error;
  }
  throw new Error("expected the operation to fail");
}

const turnOptions = { baseUrl: "", body: {} as Record<string, unknown> };

Deno.test("M2-T01 single synthetic turn, no tools: request framing, parsed text, append-only history", async () => {
  const server = await startMockResponsesServer("success");
  try {
    assertLoopbackOrigin(server.origin);
    const body = buildResponsesRequest({ input: BASE_INPUT, instructions: TEST_INSTRUCTIONS });
    const result = await sendResponsesTurn({ ...turnOptions, baseUrl: server.baseUrl, body });

    const keys = Object.keys(server.requests[0].body);
    for (const key of REQUEST_REQUIRED_KEYS) assert(keys.includes(key), `missing request key ${key}`);
    const extra = keys.filter(
      (key) => !REQUEST_REQUIRED_KEYS.includes(key as never) &&
        !REQUEST_OPTIONAL_KEYS.includes(key as never),
    );
    assertEquals(extra, [], "request carried unexpected keys");
    assertEquals(server.requests[0].body.stream, true);
    assertEquals(server.requests[0].body.tool_choice, "auto");
    assertEquals(server.requests[0].body.parallel_tool_calls, false);
    assertEquals(server.requests[0].body.model, TEST_MODEL);
    assert(Array.isArray(server.requests[0].body.input), "input must be an array");

    assertEquals(server.requests[0].method, "POST");
    assertEquals(server.requests[0].path, "/v1/responses");
    assertEquals(server.requests[0].contentType, "application/json");
    assertEquals(server.requests[0].accept, "text/event-stream");
    assertEquals(server.requests[0].beta, "responses=experimental");
    assertEquals(server.requests[0].conversationId, TEST_SESSION_ID);
    assertEquals(server.requests[0].sessionId, TEST_SESSION_ID);
    assertEquals(server.violations, []);
    assertEquals(server.unknownRouteHits, []);

    assertEquals(result.createdForwarded, true);
    assertEquals(result.responseId, RESPONSE_IDS.turn1);
    assertEquals(result.outputItems, [ASSISTANT_ITEM_TURN1]);
    assertEquals(result.skippedItems, []);
    assertEquals(result.typedUsage?.input_tokens, 10);
    assertEquals(result.usage.status, "reported");

    const history = appendHistory(BASE_INPUT, result.outputItems);
    assertEquals(history, [...BASE_INPUT, ASSISTANT_ITEM_TURN1]);
    assertSentinelOnly(server.requests);
  } finally {
    await server.stop();
  }
});

Deno.test("M2-T01b fixture framing is byte-exact (golden SSE lines)", () => {
  assertEquals(MINIMAL_SUCCESS_SSE.split("\n"), [...MINIMAL_SUCCESS_SSE_GOLDEN_LINES]);
});

Deno.test("M2-T02 two sequential turns: turn 2 input contains turn 1 items verbatim, no reordering", async () => {
  const server = await startMockResponsesServer("success-then-success");
  try {
    const turn1 = await sendResponsesTurn({
      ...turnOptions,
      baseUrl: server.baseUrl,
      body: buildResponsesRequest({ input: BASE_INPUT }),
    });
    const history = appendHistory(BASE_INPUT, turn1.outputItems);

    const turn2 = await sendResponsesTurn({
      ...turnOptions,
      baseUrl: server.baseUrl,
      body: buildResponsesRequest({ input: history }),
    });
    const afterTurn2 = appendHistory(history, turn2.outputItems);

    assertEquals(server.requests.length, 2);
    assertEquals(server.requests[0].body.input, [...BASE_INPUT]);
    assertEquals(server.requests[1].body.input, [...BASE_INPUT, ...TURN1_OUTPUT_ITEMS]);
    assertHistoryAppendOnly(BASE_INPUT, afterTurn2);
    assertEquals(afterTurn2.slice(0, 2), [...BASE_INPUT, ...TURN1_OUTPUT_ITEMS]);
    assertEquals(server.violations, []);
  } finally {
    await server.stop();
  }
});

Deno.test("M2-T03 function call + continuation: call_id matched, dispatch count == 1 (I4)", async () => {
  const server = await startMockResponsesServer("tool-call");
  try {
    const ledger = new DispatchLedger();
    const turn1 = await sendResponsesTurn({
      ...turnOptions,
      baseUrl: server.baseUrl,
      body: buildResponsesRequest({ input: BASE_INPUT }),
    });
    assertEquals(turn1.outputItems.length, 1);
    const callItem = turn1.outputItems[0] as { type: string; call_id: string; name: string; arguments: string };
    assertEquals(callItem.type, "function_call");
    assertEquals(callItem.call_id, TOOL_CALL_ID);
    assertEquals(callItem.name, FUNCTION_CALL_ITEM.name);

    const output = ledger.dispatch(callItem);
    const history = appendHistory(BASE_INPUT, turn1.outputItems);
    const continuation = appendFunctionCallOutput(history, callItem, output);

    const turn2 = await sendResponsesTurn({
      ...turnOptions,
      baseUrl: server.baseUrl,
      body: buildResponsesRequest({ input: continuation }),
    });

    const sentInput = server.requests[1].body.input as Array<Record<string, unknown>>;
    const functionCall = sentInput.find((item) => item.type === "function_call");
    const functionCallOutput = sentInput.find((item) => item.type === "function_call_output");
    assertEquals(functionCall?.call_id, TOOL_CALL_ID);
    assertEquals(functionCallOutput?.call_id, TOOL_CALL_ID);
    assertEquals(functionCallOutput?.output, `fixture output for ${TOOL_CALL_ID}`);
    assertEquals(sentInput.at(-1), functionCallOutput);
    assertEquals(turn2.responseId, RESPONSE_IDS.turn2);
    assertEquals(ledger.count, 1, "historical tool call must never be re-dispatched");
    assertEquals(server.emittedFunctionCalls(), 1, "server emitted exactly one function_call");
    assertEquals(server.violations, []);
  } finally {
    await server.stop();
  }
});

Deno.test({
  name:
    "M2-T04 [deferred: TS double] shadow projection manifest and digest — real client sidecar asserted by m2-working-set-sidecar.test.ts",
  ignore: true,
  fn() {
    throw new Error(
      "M2-T04 stays deferred for the TS double: the double has no projection. The real pinned client's selection manifest and digest are asserted against its sidecar by m2-working-set-sidecar.test.ts (M2-RC-WS01..WS03).",
    );
  },
});

Deno.test({
  name:
    "M2-T05 [deferred: TS double] selection fallback to full canonical history — real client sidecar asserted by m2-working-set-sidecar.test.ts",
  ignore: true,
  fn() {
    throw new Error(
      "M2-T05 stays deferred for the TS double. The real pinned client's fallback fields and canonical preservation are asserted against its sidecar by m2-working-set-sidecar.test.ts (M2-RC-WS01..WS03); Jev is never called in M2.",
    );
  },
});

Deno.test("M2-T06 HTTP 500 on first request: deterministic error, no partial turn", async () => {
  const server = await startMockResponsesServer("http-500");
  try {
    let history: unknown[] = [...BASE_INPUT];
    const error = await captureHarnessError(async () => {
      const result = await sendResponsesTurn({
        ...turnOptions,
        baseUrl: server.baseUrl,
        body: buildResponsesRequest({ input: history }),
      });
      history = appendHistory(history, result.outputItems);
    });
    assertEquals(error.kind, "internal_server_error");
    assertEquals(error.status, 500);
    assertEquals(server.requests.length, 1, "no retry configured, so exactly one attempt");
    assertEquals(history, [...BASE_INPUT], "failed turn must not mutate canonical history");
    assertEquals(server.violations, []);
  } finally {
    await server.stop();
  }
});

Deno.test("M2-T07 HTTP 429 + Retry-After: retries respect request_max_retries, bounded", async () => {
  const server = await startMockResponsesServer("http-429");
  try {
    const started = Date.now();
    const error = await captureHarnessError(() =>
      sendResponsesTurn({
        ...turnOptions,
        baseUrl: server.baseUrl,
        body: buildResponsesRequest({ input: BASE_INPUT }),
        requestMaxRetries: 2,
      })
    );
    const elapsed = Date.now() - started;
    assertEquals(error.kind, "retry_limit");
    assertEquals(error.status, 429);
    assertEquals(server.requests.length, 3, "1 initial attempt + 2 configured retries");
    assert(elapsed < 5_000, `retry loop must stay bounded, took ${elapsed}ms`);
  } finally {
    await server.stop();
  }
});

Deno.test("M2-T08 malformed JSON request body: server 400, client surfaces it without panic", async () => {
  const server = await startMockResponsesServer("success");
  try {
    const response = await fetch(`${server.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "text/event-stream",
        "authorization": "Bearer m2-test-sentinel-not-a-credential",
      },
      body: '{"model": "m2-synthetic-model", ',
    });
    assertEquals(response.status, 400);
    const payload = await response.json() as { error: { message: string } };
    assertEquals(payload.error.message, "invalid JSON body");
    assertEquals(server.requests.length, 0, "malformed body is rejected before recording");
    assertEquals(server.violations, []);
    assertEquals(server.unknownRouteHits, []);
  } finally {
    await server.stop();
  }
});

Deno.test("M2-T09 200 with application/json instead of SSE: stream error, not a hang", async () => {
  const server = await startMockResponsesServer("json-body-200");
  try {
    const started = Date.now();
    const error = await captureHarnessError(() =>
      sendResponsesTurn({
        ...turnOptions,
        baseUrl: server.baseUrl,
        body: buildResponsesRequest({ input: BASE_INPUT }),
      })
    );
    assertEquals(error.kind, "stream");
    assertEquals(error.message, "stream closed before response.completed");
    assert(Date.now() - started < 5_000, "must not hang on a non-SSE 200");
  } finally {
    await server.stop();
  }
});

Deno.test("M2-T10 SSE truncated before response.completed: exact stream-closed error", async () => {
  const server = await startMockResponsesServer("truncated");
  try {
    let history: unknown[] = [...BASE_INPUT];
    const error = await captureHarnessError(async () => {
      const result = await sendResponsesTurn({
        ...turnOptions,
        baseUrl: server.baseUrl,
        body: buildResponsesRequest({ input: history }),
      });
      history = appendHistory(history, result.outputItems);
    });
    assertEquals(error.kind, "stream");
    assertEquals(error.message, "stream closed before response.completed");
    assertEquals(history, [...BASE_INPUT], "no partial turn may be recorded");
  } finally {
    await server.stop();
  }
});

Deno.test("M2-T11 response.failed mid-stream: error surfaced, no phantom assistant item", async () => {
  const server = await startMockResponsesServer("failed");
  try {
    const error = await captureHarnessError(() =>
      sendResponsesTurn({
        ...turnOptions,
        baseUrl: server.baseUrl,
        body: buildResponsesRequest({ input: BASE_INPUT }),
      })
    );
    assertEquals(error.kind, "stream");
    assertEquals(error.message, FAILED_SSE_MESSAGE);
    assertEquals(error.retryAfterMs, 1898, "rate-limit delay parsed per try_parse_retry_after");
  } finally {
    await server.stop();
  }
});

Deno.test("M2-T12 unparseable output_item.done item is skipped; turn still completes", async () => {
  const server = await startMockResponsesServer("unparseable-item");
  try {
    const result = await sendResponsesTurn({
      ...turnOptions,
      baseUrl: server.baseUrl,
      body: buildResponsesRequest({ input: BASE_INPUT }),
    });
    assertEquals(result.skippedItems, [{ type: "message" }]);
    assertEquals(result.outputItems, [ASSISTANT_ITEM_TURN1]);
    const history = appendHistory(BASE_INPUT, result.outputItems);
    assertEquals(history.length, BASE_INPUT.length + 1, "no phantom item in recorded history");
  } finally {
    await server.stop();
  }
});

Deno.test("M2-T13 unparseable response.completed.response: turn fails with stream-closed error", async () => {
  const server = await startMockResponsesServer("unparseable-completed");
  try {
    let history: unknown[] = [...BASE_INPUT];
    const error = await captureHarnessError(async () => {
      const result = await sendResponsesTurn({
        ...turnOptions,
        baseUrl: server.baseUrl,
        body: buildResponsesRequest({ input: history }),
      });
      history = appendHistory(history, result.outputItems);
    });
    assertEquals(error.kind, "stream");
    assertEquals(error.message, "stream closed before response.completed");
    assertEquals(history, [...BASE_INPUT], "no partial success may be recorded");
  } finally {
    await server.stop();
  }
});

Deno.test("M2-T14 TCP connection closed mid-stream: stream error, bounded time, no hang", async () => {
  const server = await startMockResponsesServer("abort-mid-stream");
  try {
    const started = Date.now();
    const error = await captureHarnessError(() =>
      sendResponsesTurn({
        ...turnOptions,
        baseUrl: server.baseUrl,
        body: buildResponsesRequest({ input: BASE_INPUT }),
        streamIdleTimeoutMs: 2_000,
      })
    );
    const elapsed = Date.now() - started;
    assertEquals(error.kind, "stream");
    assert(error.message.startsWith("SSE error:"), `unexpected message: ${error.message}`);
    assert(elapsed < 5_000, `aborted stream must fail promptly, took ${elapsed}ms`);
  } finally {
    await server.stop();
  }
});

Deno.test("M2-T15 silent stall past stream_idle_timeout_ms: exact idle-timeout error", async () => {
  const server = await startMockResponsesServer("stall");
  try {
    const started = Date.now();
    const error = await captureHarnessError(() =>
      sendResponsesTurn({
        ...turnOptions,
        baseUrl: server.baseUrl,
        body: buildResponsesRequest({ input: BASE_INPUT }),
        streamIdleTimeoutMs: 300,
      })
    );
    const elapsed = Date.now() - started;
    assertEquals(error.kind, "idle_timeout");
    assertEquals(error.message, "idle timeout waiting for SSE");
    assert(elapsed >= 250, "idle timeout must not fire before the configured delay");
    assert(elapsed < 5_000, `idle timeout must stay bounded, took ${elapsed}ms`);
  } finally {
    await server.stop();
  }
});

Deno.test("M2-T16 server killed between turns: second turn fails cleanly, turn 1 history intact", async () => {
  const server = await startMockResponsesServer("success-then-success");
  let history: unknown[] = [...BASE_INPUT];
  try {
    const turn1 = await sendResponsesTurn({
      ...turnOptions,
      baseUrl: server.baseUrl,
      body: buildResponsesRequest({ input: history }),
    });
    history = appendHistory(history, turn1.outputItems);
    const afterTurn1 = [...history];

    await server.stop();

    const error = await captureHarnessError(() =>
      sendResponsesTurn({
        ...turnOptions,
        baseUrl: server.baseUrl,
        body: buildResponsesRequest({ input: history }),
      })
    );
    assertEquals(error.kind, "connect");
    assertEquals(history, afterTurn1, "first turn canonical history must remain intact");
    assertEquals(history, [...BASE_INPUT, ASSISTANT_ITEM_TURN1]);
  } finally {
    await server.stop().catch(() => {});
  }
});

Deno.test("M2-INV append-only helper rejects any mutation of prior history (I1)", () => {
  const previous: unknown[] = [...BASE_INPUT, ...TURN1_OUTPUT_ITEMS];
  const mutated: unknown[] = [...previous];
  mutated[0] = USER_ITEM_TURN2;
  assertThrows(() => assertHistoryAppendOnly(previous, mutated), /append-only invariant violated/);
  assertThrows(() => assertHistoryAppendOnly(previous, previous.slice(0, 1)), /append-only invariant violated/);
  const appended = appendHistory(previous, TURN2_OUTPUT_ITEMS);
  assertEquals(appended.slice(0, previous.length), previous);
  assertEquals(appended.at(-1), TURN2_OUTPUT_ITEMS[0]);
});

Deno.test("M2-INV credential-free: no harness source reads env, and no credential is readable", async () => {
  const probe = probeCredentialAccess();
  if (probe.readThrew) {
    // Permission is absent, denied, or prompt: reads fail closed, so no credential can be read.
    assertEquals(probe.envState === "granted", false, "a granted env permission must be readable");
  } else {
    for (const [name, present] of Object.entries(probe.credentialPresence)) {
      assertEquals(present, false, `${name} must be absent for a credential-free run`);
    }
  }

  const sourceFiles = ["fixtures.ts", "mock-responses-server.ts", "responses-client.ts"];
  for (const file of sourceFiles) {
    const source = await Deno.readTextFile(new URL(file, import.meta.url));
    assert(!/Deno\.env|process\.env/.test(source), `${file} must not read environment variables`);
    assert(
      !/OPENAI_API_KEY|TYPESAFE_API_KEY|API_KEY|AUTH_TOKEN/.test(source),
      `${file} must not reference a credential variable`,
    );
  }
});

Deno.test("M2-INV pinned revision is recorded in the fixtures", () => {
  assertEquals(PIN_SHA, "5c583fe89bbd3ab4dc9a05768299f94e52fe8452");
});
