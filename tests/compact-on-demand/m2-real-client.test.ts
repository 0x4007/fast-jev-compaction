/**
 * M2-RC — real compiled pinned-fork client tests.
 *
 * Client under test: the binary at the fixed recorded fork path returned by
 * `forkBinaryPath()` (or an explicit `binaryPath` argument), built from the fork
 * of `vendor/codex` @ 5c583fe89bbd3ab4dc9a05768299f94e52fe8452. This file never
 * runs an installed `codex`, never runs `responses-client.ts` (the TS double),
 * and never skips itself into a false pass: if the recorded binary is absent,
 * the first test fails with the exact missing path.
 *
 * Coverage (honest subset — not the whole M2 matrix):
 * - M2-T01 request shape + parsed assistant text + canonical rollout (wire
 *   subset; the TS double rows in `m2-wire.test.ts` remain the labeled proof
 *   for the rest). The parsed assistant text asserted here is the printed
 *   `agent_message` event: the pin's JSON processor consumes `TaskComplete` to
 *   initiate shutdown and never serializes it to stdout
 *   (`vendor/codex/codex-rs/exec/src/event_processor_with_json_output.rs:48`),
 *   so `task_complete` is never an observable of this client.
 * - M2-T02 two sequential user turns through `exec resume`: turn 1 items are
 *   present verbatim and in order in turn 2's request.
 * - M2-T03 function-call continuation with the server-side dispatch counter;
 *   the call is an unknown tool name, so the client answers locally with
 *   `unsupported call: <name>` and no sandbox command runs.
 * - I4 no replay across a resumed turn: the emitted call is dispatched once.
 * - M2-T06/T16-style mock failure: HTTP 500 on the resumed turn, no retry, and
 *   the prior canonical rollout bytes are unchanged.
 * Not covered here: T04/T05 (shadow projection/fallback), T07–T15 framing rows,
 * T17–T21 usage rows. T04/T05-style selection/fallback observation now lives in
 * `m2-working-set-sidecar.test.ts`, which asserts the real client's adjacent
 * `*.working-set.jsonl` audit records; the TS double rows in `m2-wire.test.ts`
 * stay explicitly deferred as labeled.
 *
 * Run (no environment variable; the path below is the fixed recorded fork
 * binary resolved by the harness):
 *   deno test --allow-net=127.0.0.1 \
 *     --allow-run=<abs fork codex-exec path> \
 *     --allow-read=. --allow-read=$TMPDIR \
 *     --allow-read=<same abs fork codex-exec path> \
 *     --allow-write=$TMPDIR tests/compact-on-demand/m2-real-client.test.ts
 */

import { assert, assertEquals, deepEqual } from "./assert.ts";
import {
  ASSISTANT_TEXT,
  HARNESS_CALL_ID,
  HARNESS_TOOL_NAME,
  HARNESS_UNSUPPORTED_CALL_PREFIX,
  TEST_SENTINEL,
} from "./fixtures.ts";
import {
  assertCredentialFreeEnv,
  createPinnedClientHarness,
  forkBinaryPath,
  HARNESS_MODEL,
  isJsonObject,
  type JsonObject,
  type PinnedClientHarness,
  resolvePinnedClientBinaryPath,
  responseItems,
} from "./pinned-client-harness.ts";
import type { MockResponsesServer } from "./mock-responses-server.ts";

const PROMPT_TURN1 = "m2 harness synthetic turn one";
const PROMPT_TURN2 = "m2 harness synthetic turn two";

function inputOf(body: Record<string, unknown>): unknown[] {
  const input = body.input;
  assert(Array.isArray(input), "request body input must be an array");
  return input;
}

function hasContentText(item: JsonObject, text: string): boolean {
  if (!Array.isArray(item.content)) return false;
  return item.content.some((part) => isJsonObject(part) && part.text === text);
}

function messageItem(items: unknown[], role: string, text: string): JsonObject {
  const found = items.find(
    (item): item is JsonObject =>
      isJsonObject(item) && item.role === role && hasContentText(item, text),
  );
  assert(
    found !== undefined,
    `no ${role} message containing ${JSON.stringify(text)} in ${
      JSON.stringify(items)
    }`,
  );
  return found;
}

function indexOfItem(items: unknown[], needle: unknown): number {
  return items.findIndex((item) => deepEqual(item, needle));
}

function itemsOfType(
  items: unknown[],
  type: string,
  callId?: string,
): JsonObject[] {
  return items.filter((item): item is JsonObject =>
    isJsonObject(item) &&
    item.type === type &&
    (callId === undefined || item.call_id === callId)
  );
}

function countOfType(items: unknown[], type: string, callId?: string): number {
  return itemsOfType(items, type, callId).length;
}

/**
 * `msg` payloads of the parsed `--json` event lines with the given `msg.type`.
 *
 * The pinned exec JSON processor consumes `TaskComplete` to initiate shutdown
 * and never prints it (`event_processor_with_json_output.rs:48`), so event
 * assertions must target printed messages such as `agent_message`, never
 * `task_complete`.
 */
function eventMessagesOfType(events: JsonObject[], type: string): JsonObject[] {
  const found: JsonObject[] = [];
  for (const event of events) {
    const msg = event.msg;
    if (isJsonObject(msg) && msg.type === type) found.push(msg);
  }
  return found;
}

function assertWireFraming(
  mock: MockResponsesServer,
  expectedRequests: number,
): void {
  assertEquals(mock.violations, [], "mock framing violations");
  assertEquals(
    mock.unknownRouteHits,
    [],
    "non-`POST /v1/responses` route hits",
  );
  assertEquals(
    mock.requests.length,
    expectedRequests,
    "recorded request count",
  );
  for (const request of mock.requests) {
    assertEquals(request.contentType?.split(";")[0], "application/json");
    assertEquals(request.accept, "text/event-stream");
  }
}

async function withHarness(
  scenario: Parameters<typeof createPinnedClientHarness>[0]["scenario"],
  body: (harness: PinnedClientHarness) => Promise<void>,
): Promise<void> {
  const harness = await createPinnedClientHarness({
    binaryPath: resolvePinnedClientBinaryPath(forkBinaryPath()),
    scenario,
  });
  try {
    assertCredentialFreeEnv(harness.childEnvNames);
    await body(harness);
  } finally {
    await harness.stop();
  }
}

Deno.test("M2-RC-T00 recorded fork client binary is present (fails when the compiled fork is absent)", async () => {
  const binaryPath = resolvePinnedClientBinaryPath(forkBinaryPath());
  const stat = await Deno.stat(binaryPath);
  assert(stat.isFile, `client binary is not a regular file: ${binaryPath}`);
  console.log(JSON.stringify({ harness_binary: binaryPath }));
});

Deno.test("M2-RC-T01 real client single turn: wire shape, assistant text, canonical rollout", async () => {
  await withHarness("success", async (harness) => {
    const result = await harness.runTurn(PROMPT_TURN1);
    assert(!result.timedOut, `turn timed out; stderr: ${result.stderr}`);
    assertEquals(
      result.exitCode,
      0,
      `unexpected exit; stderr: ${result.stderr}`,
    );
    assertWireFraming(harness.mock, 1);
    assertEquals(
      harness.mock.requests[0].authorization,
      `Bearer ${TEST_SENTINEL}`,
    );

    const body = harness.mock.requests[0].body;
    assertEquals(body.model, HARNESS_MODEL);
    assertEquals(body.stream, true);
    assertEquals(body.store, false);
    assertEquals(body.tool_choice, "auto");
    assertEquals(body.parallel_tool_calls, false);
    assertEquals(typeof body.instructions, "string");
    assert(Array.isArray(body.tools), "tools must be an array");
    const sentItems = inputOf(body);
    messageItem(sentItems, "user", PROMPT_TURN1);

    const records = await harness.rolloutRecords();
    const sessionId = await harness.sessionId();
    assert(sessionId.length > 0, "session meta id must be non-empty");
    const recorded = responseItems(records);
    messageItem(recorded, "user", PROMPT_TURN1);
    messageItem(recorded, "assistant", ASSISTANT_TEXT);
    assertEquals(
      (await harness.rolloutPaths()).length,
      1,
      "one rollout file per session",
    );
    // Terminal real-turn observables: the printed mapped `agent_message`
    // carrying the synthetic response, the real process exit status asserted
    // above, and the canonical rollout asserted above. `task_complete`
    // is deliberately not asserted: the pin's JSON processor consumes it to
    // initiate shutdown and never serializes it to stdout
    // (`vendor/codex/codex-rs/exec/src/event_processor_with_json_output.rs:48`).
    const agentMessages = eventMessagesOfType(result.events, "agent_message");
    assertEquals(
      agentMessages.length,
      1,
      `expected exactly one printed agent_message event, got ${
        JSON.stringify(result.events)
      }`,
    );
    assertEquals(
      agentMessages[0].message,
      ASSISTANT_TEXT,
      "agent_message must carry the synthetic assistant response",
    );
  });
});

Deno.test("M2-RC-T02 real client second user turn: turn 1 items survive verbatim in the resumed request", async () => {
  await withHarness("success-then-success", async (harness) => {
    const turn1 = await harness.runTurn(PROMPT_TURN1);
    assertEquals(turn1.exitCode, 0, `turn 1 failed; stderr: ${turn1.stderr}`);
    const bytesAfterTurn1 = await harness.rolloutBytes();
    const recordedAfterTurn1 = responseItems(await harness.rolloutRecords());
    const sessionId = await harness.sessionId();

    const turn2 = await harness.resumeTurn(sessionId, PROMPT_TURN2);
    assertEquals(turn2.exitCode, 0, `turn 2 failed; stderr: ${turn2.stderr}`);
    assertWireFraming(harness.mock, 2);

    const firstItems = inputOf(harness.mock.requests[0].body);
    const resumedItems = inputOf(harness.mock.requests[1].body);
    // The assistant item exists only after turn 1, so take it from the recorded
    // canonical rollout and require the same bytes again on the wire.
    const turn1User = messageItem(firstItems, "user", PROMPT_TURN1);
    const turn1Assistant = messageItem(
      recordedAfterTurn1,
      "assistant",
      ASSISTANT_TEXT,
    );
    const userIndex = indexOfItem(resumedItems, turn1User);
    const assistantIndex = indexOfItem(resumedItems, turn1Assistant);
    const newUserIndex = indexOfItem(
      resumedItems,
      messageItem(resumedItems, "user", PROMPT_TURN2),
    );
    assert(userIndex >= 0, "turn 1 user item missing from the resumed request");
    assert(
      assistantIndex >= 0,
      "turn 1 assistant item missing from the resumed request",
    );
    assert(
      userIndex < assistantIndex && assistantIndex < newUserIndex,
      `history order changed: user=${userIndex} assistant=${assistantIndex} new=${newUserIndex}`,
    );

    const bytesAfterTurn2 = await harness.rolloutBytes();
    assert(
      bytesAfterTurn2.startsWith(bytesAfterTurn1),
      "rollout is not append-only: turn 1 bytes changed after the resumed turn",
    );
    assertEquals(
      (await harness.rolloutPaths()).length,
      1,
      "resume must append to the same rollout",
    );
    const recorded = responseItems(await harness.rolloutRecords());
    messageItem(recorded, "user", PROMPT_TURN2);
    assertEquals(
      recorded.filter((item) => isJsonObject(item) && item.role === "assistant")
        .length,
      2,
      "expected one assistant item per completed turn",
    );
  });
});

Deno.test("M2-RC-T03 real client function call: continuation carries exactly one dispatch output", async () => {
  await withHarness("tool-call-unknown", async (harness) => {
    const result = await harness.runTurn(PROMPT_TURN1);
    assertEquals(result.exitCode, 0, `turn failed; stderr: ${result.stderr}`);
    assertWireFraming(harness.mock, 2);
    assertEquals(
      harness.mock.emittedFunctionCalls(),
      1,
      "server emitted function calls",
    );

    const continuation = inputOf(harness.mock.requests[1].body);
    assertEquals(
      countOfType(continuation, "function_call", HARNESS_CALL_ID),
      1,
    );
    const outputs = itemsOfType(
      continuation,
      "function_call_output",
      HARNESS_CALL_ID,
    );
    assertEquals(
      outputs.length,
      1,
      "continuation must carry exactly one matching output",
    );
    const output = outputs[0].output;
    assert(
      typeof output === "string",
      `output must be a plain string, got ${typeof output}`,
    );
    assert(
      output.startsWith(
        `${HARNESS_UNSUPPORTED_CALL_PREFIX}${HARNESS_TOOL_NAME}`,
      ),
      `unexpected local dispatch output: ${output}`,
    );

    const recorded = responseItems(await harness.rolloutRecords());
    assertEquals(countOfType(recorded, "function_call", HARNESS_CALL_ID), 1);
    assertEquals(
      countOfType(recorded, "function_call_output", HARNESS_CALL_ID),
      1,
    );
    messageItem(recorded, "assistant", "tool result accepted");
  });
});

Deno.test("M2-RC-T04 real client no replay: a resumed turn reuses the recorded call as context only", async () => {
  await withHarness("tool-call-unknown-resume", async (harness) => {
    const turn1 = await harness.runTurn(PROMPT_TURN1);
    assertEquals(turn1.exitCode, 0, `turn 1 failed; stderr: ${turn1.stderr}`);
    const sessionId = await harness.sessionId();
    const bytesAfterTurn1 = await harness.rolloutBytes();

    const turn2 = await harness.resumeTurn(sessionId, PROMPT_TURN2);
    assertEquals(turn2.exitCode, 0, `turn 2 failed; stderr: ${turn2.stderr}`);
    assertWireFraming(harness.mock, 3);
    assertEquals(
      harness.mock.emittedFunctionCalls(),
      1,
      "server emitted function calls",
    );

    const recorded = responseItems(await harness.rolloutRecords());
    assertEquals(countOfType(recorded, "function_call", HARNESS_CALL_ID), 1);
    assertEquals(
      countOfType(recorded, "function_call_output", HARNESS_CALL_ID),
      1,
    );

    const resumedItems = inputOf(harness.mock.requests[2].body);
    assertEquals(
      countOfType(resumedItems, "function_call_output", HARNESS_CALL_ID),
      1,
      "the historical output must appear once as context, never re-dispatched",
    );
    messageItem(resumedItems, "user", PROMPT_TURN2);
    assert(
      (await harness.rolloutBytes()).startsWith(bytesAfterTurn1),
      "rollout is not append-only across the resumed turn",
    );
  });
});

Deno.test("M2-RC-T05 real client mock failure: no retry, prior rollout preserved, error surfaced", async () => {
  await withHarness("success-then-http-500", async (harness) => {
    const turn1 = await harness.runTurn(PROMPT_TURN1);
    assertEquals(turn1.exitCode, 0, `turn 1 failed; stderr: ${turn1.stderr}`);
    const bytesAfterTurn1 = await harness.rolloutBytes();
    const itemsAfterTurn1 = responseItems(await harness.rolloutRecords());
    const sessionId = await harness.sessionId();

    const turn2 = await harness.resumeTurn(sessionId, PROMPT_TURN2);
    assert(!turn2.timedOut, "failed turn must terminate, not hang");
    assert(
      turn2.exitCode !== null,
      "child must report a real exit status, not a signal kill",
    );
    // On a turn error core emits `error` and then (internally) `task_complete`;
    // the pin's JSON processor prints only the error and consumes the
    // completion event to shut down, and `exec` still exits 0
    // (`core/src/codex.rs:1898`, `exec/src/lib.rs:295`,
    // `exec/src/event_processor_with_json_output.rs:48`), so only the printed
    // error event is asserted and the status is recorded rather than normalized
    // into a non-zero expectation.
    console.log(
      JSON.stringify({
        failed_turn_exit_code: turn2.exitCode,
        error_events: turn2.errorEvents.length,
      }),
    );
    assert(
      turn2.errorEvents.length >= 1,
      "client must surface the mock failure as an error event",
    );
    assert(
      turn2.errorEvents[0].message.length > 0,
      "error event message must not be empty",
    );

    assertEquals(
      harness.mock.requests.length,
      2,
      "retries must be disabled for this harness",
    );
    assertWireFraming(harness.mock, 2);

    const bytesAfterFailure = await harness.rolloutBytes();
    assert(
      bytesAfterFailure.startsWith(bytesAfterTurn1),
      "failed turn must not rewrite the canonical rollout prefix",
    );
    const itemsAfterFailure = responseItems(await harness.rolloutRecords());
    assertEquals(
      itemsAfterFailure.filter((item) =>
        isJsonObject(item) && item.role === "assistant"
      ).length,
      itemsAfterTurn1.filter((item) =>
        isJsonObject(item) && item.role === "assistant"
      ).length,
      "a failed turn must not record a phantom assistant item",
    );
  });
});
