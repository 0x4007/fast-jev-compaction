/**
 * M2-RC-WS — working-set sidecar observation against the real compiled pinned
 * fork client.
 *
 * Contract source: the fork's recorded working-set audit file. It is written
 * next to the rollout it belongs to, as `<rollout>.working-set.jsonl`, and is
 * append-only JSONL whose every line is tagged `{record:"selection",...}` or
 * `{record:"turn",...}`. A selection line carries `schema_version`, `kind`,
 * `request_index`, `manifest{canonical{log_len,digest},projection{len,omitted,
 * digest,items},pins,retrieval,omissions,cost{confidence,catalog_version,...},
 * decision{winner,applied,reason},fallback{used,reason}}`, `manifest_digest`,
 * `applied`, `canonical_digest_before_request`,
 * `canonical_digest_after_selection`, `selection_reason`, `fallback_reason`.
 * A turn line carries `request_index`, `turn_index`, `decision`
 * (`projected`|`canonical`), `reason`, `epoch_id`, `canonical_len`,
 * `canonical_digest`, `wire_len`, `wire_digest`.
 *
 * Honesty rules:
 * - These tests drive the binary returned by `forkBinaryPath()` through the
 *   real pinned-client harness; they never run `responses-client.ts` (the TS
 *   double) and never skip themselves into a false pass. A missing binary or a
 *   missing sidecar is a hard failure.
 * - This smoke catalog is unknown to the client, so a selection may
 *   legitimately fall back to canonical history: the assertions validate the
 *   record structure, per-request/per-turn counts, append-only growth, and
 *   canonical preservation. They never require `applied === true`, a
 *   `projected` winner, or a reduction claim; the Rust core-loop test owns the
 *   projection-reduction proof.
 * - M2-RC-WS04 is a reader-contract test only; it makes no client claim.
 *
 * Run (no environment variable; the path below is the fixed recorded fork
 * binary resolved by the harness):
 *   deno test --allow-net=127.0.0.1 \
 *     --allow-run=<abs fork codex-exec path> \
 *     --allow-read=. --allow-read=$TMPDIR \
 *     --allow-read=<same abs fork codex-exec path> \
 *     --allow-write=$TMPDIR tests/compact-on-demand/m2-working-set-sidecar.test.ts
 */

import { assert, assertEquals, assertThrows } from "./assert.ts";
import {
  createPinnedClientHarness,
  forkBinaryPath,
  isJsonObject,
  type JsonObject,
  parseWorkingSetSidecar,
  type PinnedClientHarness,
  resolvePinnedClientBinaryPath,
  responseItems,
  sidecarSelections,
  sidecarTurns,
  type WorkingSetSidecarEntry,
  workingSetSidecarPath,
} from "./pinned-client-harness.ts";

const PROMPT_TURN1 = "m2 sidecar synthetic turn one";
const PROMPT_TURN2 = "m2 sidecar synthetic turn two";

async function withHarness(
  scenario: Parameters<typeof createPinnedClientHarness>[0]["scenario"],
  body: (harness: PinnedClientHarness) => Promise<void>,
): Promise<void> {
  const harness = await createPinnedClientHarness({
    binaryPath: resolvePinnedClientBinaryPath(forkBinaryPath()),
    scenario,
  });
  try {
    await body(harness);
  } finally {
    await harness.stop();
  }
}

function hasContentText(item: JsonObject, text: string): boolean {
  if (!Array.isArray(item.content)) return false;
  return item.content.some((part) => isJsonObject(part) && part.text === text);
}

function requireObject(value: unknown, field: string): JsonObject {
  assert(
    isJsonObject(value),
    `${field} must be a JSON object: ${JSON.stringify(value)}`,
  );
  return value;
}

function requireInteger(value: unknown, field: string): number {
  assert(
    typeof value === "number" && Number.isInteger(value),
    `${field} must be an integer: ${JSON.stringify(value)}`,
  );
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  assert(
    typeof value === "boolean",
    `${field} must be a boolean: ${JSON.stringify(value)}`,
  );
  return value;
}

function requireString(value: unknown, field: string): string {
  assert(
    typeof value === "string" && value.length > 0,
    `${field} must be a non-empty string: ${JSON.stringify(value)}`,
  );
  return value;
}

function requireKey(record: JsonObject, key: string, field: string): unknown {
  assert(
    Object.hasOwn(record, key),
    `${field} must contain ${key}: ${JSON.stringify(record)}`,
  );
  return record[key];
}

/** Present key whose value may legitimately be absent (`null`) this run. */
function requireNullableString(
  record: JsonObject,
  key: string,
  field: string,
): void {
  const value = requireKey(record, key, field);
  assert(
    value === null || (typeof value === "string" && value.length > 0),
    `${field}.${key} must be null or a non-empty string: ${
      JSON.stringify(value)
    }`,
  );
}

/** Structural validation of one `{record:"selection",...}` line. */
function assertSelectionShape(entry: WorkingSetSidecarEntry): void {
  const record = entry.record;
  assertEquals(record.record, "selection", `line ${entry.line}`);
  assert(
    record.schema_version !== undefined && record.schema_version !== null,
    `selection.schema_version must be present (line ${entry.line})`,
  );
  requireString(record.kind, "selection.kind");
  assert(
    requireInteger(record.request_index, "selection.request_index") >= 0,
    "selection.request_index must be non-negative",
  );

  const manifest = requireObject(record.manifest, "selection.manifest");
  for (
    const key of [
      "canonical",
      "projection",
      "pins",
      "retrieval",
      "omissions",
      "cost",
      "decision",
      "fallback",
    ]
  ) {
    requireKey(manifest, key, "selection.manifest");
  }

  const canonical = requireObject(
    manifest.canonical,
    "selection.manifest.canonical",
  );
  assert(
    requireInteger(
      canonical.log_len,
      "selection.manifest.canonical.log_len",
    ) >= 0,
    "canonical.log_len must be non-negative",
  );
  requireString(canonical.digest, "selection.manifest.canonical.digest");

  const projection = requireObject(
    manifest.projection,
    "selection.manifest.projection",
  );
  assert(
    requireInteger(projection.len, "selection.manifest.projection.len") >= 0,
    "projection.len must be non-negative",
  );
  assert(
    requireInteger(
      projection.omitted,
      "selection.manifest.projection.omitted",
    ) >= 0,
    "projection.omitted must be non-negative",
  );
  assert(
    typeof projection.digest === "string",
    `selection.manifest.projection.digest must be a string: ${
      JSON.stringify(projection.digest)
    }`,
  );
  assert(
    Array.isArray(projection.items) || projection.items === null,
    `selection.manifest.projection.items must be an array or null: ${
      JSON.stringify(projection.items)
    }`,
  );

  const cost = requireObject(manifest.cost, "selection.manifest.cost");
  // Confidence and catalog version are honest runtime inputs whose encoding is
  // owned by the client; this smoke only requires them to be reported.
  requireKey(cost, "confidence", "selection.manifest.cost");
  requireKey(cost, "catalog_version", "selection.manifest.cost");

  const decision = requireObject(
    manifest.decision,
    "selection.manifest.decision",
  );
  // The winner may be null when the selection legitimately falls back to
  // canonical history; the decision block itself must always be present.
  requireNullableString(decision, "winner", "selection.manifest.decision");
  requireBoolean(decision.applied, "selection.manifest.decision.applied");
  requireString(decision.reason, "selection.manifest.decision.reason");

  const fallback = requireObject(
    manifest.fallback,
    "selection.manifest.fallback",
  );
  requireBoolean(fallback.used, "selection.manifest.fallback.used");
  requireNullableString(fallback, "reason", "selection.manifest.fallback");

  requireString(record.manifest_digest, "selection.manifest_digest");
  requireBoolean(record.applied, "selection.applied");
  requireString(
    record.canonical_digest_before_request,
    "selection.canonical_digest_before_request",
  );
  requireString(
    record.canonical_digest_after_selection,
    "selection.canonical_digest_after_selection",
  );
  requireString(record.selection_reason, "selection.selection_reason");
  requireKey(record, "fallback_reason", "selection");
}

/** Structural validation of one `{record:"turn",...}` line. */
function assertTurnShape(entry: WorkingSetSidecarEntry): void {
  const record = entry.record;
  assertEquals(record.record, "turn", `line ${entry.line}`);
  assert(
    requireInteger(record.request_index, "turn.request_index") >= 0,
    "turn.request_index must be non-negative",
  );
  assert(
    requireInteger(record.turn_index, "turn.turn_index") >= 0,
    "turn.turn_index must be non-negative",
  );
  const decision = requireString(record.decision, "turn.decision");
  assert(
    decision === "projected" || decision === "canonical",
    `turn.decision must be projected or canonical: ${JSON.stringify(decision)}`,
  );
  requireString(record.reason, "turn.reason");
  requireString(record.epoch_id, "turn.epoch_id");
  assert(
    requireInteger(record.canonical_len, "turn.canonical_len") >= 0,
    "turn.canonical_len must be non-negative",
  );
  requireString(record.canonical_digest, "turn.canonical_digest");
  assert(
    requireInteger(record.wire_len, "turn.wire_len") >= 0,
    "turn.wire_len must be non-negative",
  );
  requireString(record.wire_digest, "turn.wire_digest");
}

Deno.test("M2-RC-WS01 real client records one working-set selection per user request", async () => {
  await withHarness("success-then-success", async (harness) => {
    const turn1 = await harness.runTurn(PROMPT_TURN1);
    assertEquals(turn1.exitCode, 0, `turn 1 failed; stderr: ${turn1.stderr}`);
    const sessionId = await harness.sessionId();
    const bytesAfterTurn1 = await harness.rolloutBytes();

    const turn2 = await harness.resumeTurn(sessionId, PROMPT_TURN2);
    assertEquals(turn2.exitCode, 0, `turn 2 failed; stderr: ${turn2.stderr}`);
    assertEquals(harness.mock.violations, [], "mock framing violations");
    assertEquals(harness.mock.requests.length, 2, "two user requests");

    const entries = await harness.sidecarEntries();
    const selections = sidecarSelections(entries);
    assertEquals(
      selections.length,
      harness.mock.requests.length,
      "one selection record per user request",
    );
    for (const selection of selections) assertSelectionShape(selection);
    // `exec resume` launches a fresh process, so the Rust request counter can
    // restart at 1. Validate each record's local identity without requiring a
    // globally unique request_index across process boundaries.
    const requestIndexes = selections.map((selection) =>
      requireInteger(selection.record.request_index, "selection.request_index")
    );
    assert(
      requestIndexes.every((requestIndex) => requestIndex >= 1),
      `each selection must carry a 1-based request identity: ${requestIndexes}`,
    );
    const canonicalLengths = selections.map((selection, index) => {
      const manifest = requireObject(
        selection.record.manifest,
        `selection[${index}].manifest`,
      );
      const canonical = requireObject(
        manifest.canonical,
        `selection[${index}].manifest.canonical`,
      );
      assertEquals(
        selection.record.canonical_digest_after_selection,
        canonical.digest,
        `selection[${index}] canonical digest must match its manifest identity`,
      );
      return requireInteger(
        canonical.log_len,
        `selection[${index}].manifest.canonical.log_len`,
      );
    });
    assert(
      canonicalLengths.every((length, index) =>
        index === 0 || length >= canonicalLengths[index - 1]
      ),
      `selection canonical history must not shrink: ${canonicalLengths}`,
    );

    assertEquals(
      (await harness.rolloutPaths()).length,
      1,
      "one rollout file per session",
    );
    assert(
      (await harness.rolloutBytes()).startsWith(bytesAfterTurn1),
      "sidecar observation must not rewrite the canonical rollout",
    );
    const items = responseItems(await harness.rolloutRecords());
    assert(
      items.some((item) =>
        isJsonObject(item) && item.role === "user" &&
        hasContentText(item, PROMPT_TURN1)
      ),
      "turn 1 user item missing from the canonical rollout",
    );
    assert(
      items.some((item) =>
        isJsonObject(item) && item.role === "user" &&
        hasContentText(item, PROMPT_TURN2)
      ),
      "turn 2 user item missing from the canonical rollout",
    );
  });
});

Deno.test("M2-RC-WS02 real client tool follow-up appends a turn without a new selection", async () => {
  await withHarness("tool-call-unknown", async (harness) => {
    const result = await harness.runTurn(PROMPT_TURN1);
    assertEquals(result.exitCode, 0, `turn failed; stderr: ${result.stderr}`);
    assertEquals(harness.mock.violations, [], "mock framing violations");
    assertEquals(
      harness.mock.requests.length,
      2,
      "one initial request plus one tool follow-up",
    );
    assertEquals(harness.mock.emittedFunctionCalls(), 1);

    const entries = await harness.sidecarEntries();
    const selections = sidecarSelections(entries);
    const turns = sidecarTurns(entries);
    assertEquals(selections.length, 1, "the tool follow-up must not reselect");
    for (const selection of selections) assertSelectionShape(selection);
    assertEquals(
      turns.length,
      harness.mock.requests.length,
      "each upstream request appends one turn record",
    );
    for (const turn of turns) assertTurnShape(turn);
    const turnIndexes = turns.map((turn) =>
      requireInteger(turn.record.turn_index, "turn.turn_index")
    );
    assertEquals(
      new Set(turnIndexes).size,
      turnIndexes.length,
      "turn_index values must be unique",
    );
  });
});

Deno.test("M2-RC-WS03 real client sidecar appends turn records and preserves canonical history", async () => {
  await withHarness("success-then-success", async (harness) => {
    const turn1 = await harness.runTurn(PROMPT_TURN1);
    assertEquals(turn1.exitCode, 0, `turn 1 failed; stderr: ${turn1.stderr}`);
    const sidecarAfterTurn1 = await harness.sidecarBytes();
    const entriesAfterTurn1 = parseWorkingSetSidecar(sidecarAfterTurn1);
    assertEquals(sidecarSelections(entriesAfterTurn1).length, 1);
    assertEquals(sidecarTurns(entriesAfterTurn1).length, 1);
    for (const turn of sidecarTurns(entriesAfterTurn1)) assertTurnShape(turn);
    const bytesAfterTurn1 = await harness.rolloutBytes();
    const recordsAfterTurn1 = await harness.rolloutRecords();
    const userItemsAfterTurn1 = responseItems(recordsAfterTurn1).filter(
      (item) => isJsonObject(item) && item.role === "user",
    ).length;

    const sessionId = await harness.sessionId();
    const turn2 = await harness.resumeTurn(sessionId, PROMPT_TURN2);
    assertEquals(turn2.exitCode, 0, `turn 2 failed; stderr: ${turn2.stderr}`);

    const sidecarAfterTurn2 = await harness.sidecarBytes();
    assert(
      sidecarAfterTurn2.startsWith(sidecarAfterTurn1),
      "sidecar is not append-only: turn 1 records changed after turn 2",
    );
    const turns = sidecarTurns(parseWorkingSetSidecar(sidecarAfterTurn2));
    assertEquals(turns.length, 2, "one appended turn record per user request");
    for (const turn of turns) assertTurnShape(turn);
    const canonicalLens = turns.map((turn) =>
      requireInteger(turn.record.canonical_len, "turn.canonical_len")
    );
    assert(
      canonicalLens[1] >= canonicalLens[0],
      `canonical_len must not shrink across appended turns: ${canonicalLens}`,
    );

    assert(
      (await harness.rolloutBytes()).startsWith(bytesAfterTurn1),
      "canonical rollout is not append-only",
    );
    // The canonical rollout also carries the session's synthetic initial
    // context, so the exact user-item count is not fixed. What must hold across
    // the resumed turn is that the canonical record count never shrinks and
    // that both fixed synthetic prompts are still present verbatim.
    const recordsAfterTurn2 = await harness.rolloutRecords();
    assert(
      recordsAfterTurn2.length >= recordsAfterTurn1.length,
      `canonical rollout must not drop records across the resumed turn: ${recordsAfterTurn1.length} -> ${recordsAfterTurn2.length}`,
    );
    const items = responseItems(recordsAfterTurn2);
    assert(
      items.filter((item) => isJsonObject(item) && item.role === "user")
        .length >= userItemsAfterTurn1,
      "canonical user-turn count must not shrink across the resumed turn",
    );
    assert(
      items.some((item) =>
        isJsonObject(item) && item.role === "user" &&
        hasContentText(item, PROMPT_TURN1)
      ),
      "turn 1 user item missing from the canonical rollout",
    );
    assert(
      items.some((item) =>
        isJsonObject(item) && item.role === "user" &&
        hasContentText(item, PROMPT_TURN2)
      ),
      "turn 2 user item missing from the canonical rollout",
    );
  });
});

Deno.test("M2-RC-WS04 sidecar reader maps the adjacent path and rejects untagged or malformed lines", () => {
  assertEquals(
    workingSetSidecarPath("/tmp/sessions/2026/09/18/rollout-1.jsonl"),
    "/tmp/sessions/2026/09/18/rollout-1.working-set.jsonl",
  );
  assertThrows(
    () => workingSetSidecarPath("/tmp/sessions/2026/09/18/rollout-1.txt"),
    /does not end in \.jsonl/,
  );

  const entries = parseWorkingSetSidecar(
    '{"record":"selection","request_index":1}\n\n{"record":"turn","turn_index":0}\n',
  );
  assertEquals(entries.map((entry) => entry.tag), ["selection", "turn"]);
  assertEquals(entries.map((entry) => entry.line), [1, 3]);
  assertThrows(
    () => parseWorkingSetSidecar('{"request_index":1}'),
    /no known record tag/,
  );
  assertThrows(
    () => parseWorkingSetSidecar('{"record":"selection"'),
    /is not JSON/,
  );
  assertThrows(
    () => parseWorkingSetSidecar("[1,2]"),
    /is not a JSON object/,
  );
});
