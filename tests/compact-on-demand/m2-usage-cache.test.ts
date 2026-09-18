/**
 * M2 usage and cache-accounting tests — matrix rows M2-T17…T21 and B7–B10.
 *
 * Usage is synthetic token-count data only. No price, currency, or monetary
 * total exists in these fixtures, assertions, or recorded artifacts (I10/I15).
 * Nothing here claims an M1 projection, estimator, or manifest exists.
 *
 * Run: deno test --allow-net=127.0.0.1 tests/compact-on-demand
 */

import { assert, assertEquals } from "./assert.ts";
import {
  BASE_INPUT,
  USAGE_DETAILS_OMITTED,
  USAGE_FULL,
  USAGE_FULL_SSE,
  USAGE_MISSING_TOTAL,
  USAGE_MISSING_TOTAL_SSE,
} from "./fixtures.ts";
import { startMockResponsesServer } from "./mock-responses-server.ts";
import {
  appendHistory,
  buildResponsesRequest,
  type HarnessError,
  recordUsage,
  sendResponsesTurn,
  USAGE_FIELD_NAMES,
  type UsageRecord,
} from "./responses-client.ts";

/** M2 test-side estimate shape for the unknown-pricing case. No M1 estimator exists. */
function unknownPricingEstimate(usage: UsageRecord) {
  return {
    confidence: "low" as const,
    amount: null,
    currency: null,
    unknown_fields: [
      "usage.fields.cached_tokens",
      "usage.fields.cache_write_tokens",
      "usage.fields.reasoning_tokens",
    ].filter((name) => JSON.stringify(usage).includes(name.split(".").at(-1) as string)),
    usage,
  };
}

/** M2 test-side cache-epoch ledger. Counts/dispositions only; never a rate or price. */
class CacheEpochLedger {
  #previousEpoch: string | null = null;

  observe(epoch: string, usage: UsageRecord): {
    epochChanged: boolean;
    disposition: "cache_write_or_uncached" | "cached";
    savings_claim: "none" | "requires_reported_cached_tokens";
  } {
    const epochChanged = this.#previousEpoch !== epoch;
    this.#previousEpoch = epoch;
    const cached = usage.fields.cached_tokens;
    if (epochChanged || typeof cached !== "number" || cached <= 0) {
      return { epochChanged, disposition: "cache_write_or_uncached", savings_claim: "none" };
    }
    return { epochChanged, disposition: "cached", savings_claim: "requires_reported_cached_tokens" };
  }
}

const MONEY_PATTERN = /[$€£¥]|\b(?:usd|eur|gbp|jpy)\b|\bprice\b|\bper_million\b/i;

async function captureError(fn: () => Promise<unknown>): Promise<HarnessError> {
  try {
    await fn();
  } catch (error) {
    assert(error instanceof Error && error.name === "HarnessError", `expected HarnessError, got ${String(error)}`);
    return error as HarnessError;
  }
  throw new Error("expected the operation to fail");
}

Deno.test("M2-T17 full synthetic usage: every field carried raw, separate from cost.estimate", async () => {
  const server = await startMockResponsesServer("usage-full");
  try {
    const result = await sendResponsesTurn({
      baseUrl: server.baseUrl,
      body: buildResponsesRequest({ input: BASE_INPUT }),
    });

    assertEquals(result.usage.status, "reported");
    assertEquals(result.usage.fields, {
      input_tokens: USAGE_FULL.input_tokens,
      cached_tokens: USAGE_FULL.input_tokens_details.cached_tokens,
      cache_write_tokens: USAGE_FULL.input_tokens_details.cache_write_tokens,
      output_tokens: USAGE_FULL.output_tokens,
      reasoning_tokens: USAGE_FULL.output_tokens_details.reasoning_tokens,
      total_tokens: USAGE_FULL.total_tokens,
    });
    assertEquals(result.usage.source, "response.completed.usage");
    assertEquals(result.usage.savings_claim, "none");
    assertEquals(result.usageRaw, USAGE_FULL, "raw usage must be preserved verbatim");
    assertEquals(result.costEstimate, null, "usage must stay separate from cost.estimate");

    assertEquals(result.typedUsage?.cached_input_tokens, USAGE_FULL.input_tokens_details.cached_tokens);
    assertEquals(result.typedUsage?.reasoning_output_tokens, USAGE_FULL.output_tokens_details.reasoning_tokens);
    assert(
      !Object.hasOwn(result.typedUsage as object, "cache_write_tokens"),
      "pinned typed view drops cache_write_tokens; it survives only in usageRaw",
    );
    assertEquals(server.violations, []);
  } finally {
    await server.stop();
  }
});

Deno.test("M2-T18 usage absent: unavailable, never zero; savings_claim none (I15)", async () => {
  const server = await startMockResponsesServer("usage-absent");
  try {
    const result = await sendResponsesTurn({
      baseUrl: server.baseUrl,
      body: buildResponsesRequest({ input: BASE_INPUT }),
    });
    assertEquals(result.usage.status, "unavailable");
    for (const name of USAGE_FIELD_NAMES) {
      assertEquals(result.usage.fields[name], "unavailable", `${name} must be unavailable, not 0`);
    }
    assertEquals(result.usage.savings_claim, "none");
    assertEquals(result.typedUsage, null);
    assertEquals(result.usageRaw, "unavailable");
    assertEquals(result.outputItems.length, 1, "turn still completes with absent usage");
  } finally {
    await server.stop();
  }
});

Deno.test("M2-T19 partial usage: cache fields stay unavailable; no inferred cache hit", async () => {
  const server = await startMockResponsesServer("usage-details-omitted");
  try {
    const result = await sendResponsesTurn({
      baseUrl: server.baseUrl,
      body: buildResponsesRequest({ input: BASE_INPUT }),
    });
    assertEquals(result.usage.status, "reported");
    assertEquals(result.usage.fields.input_tokens, USAGE_DETAILS_OMITTED.input_tokens);
    assertEquals(result.usage.fields.output_tokens, USAGE_DETAILS_OMITTED.output_tokens);
    assertEquals(result.usage.fields.total_tokens, USAGE_DETAILS_OMITTED.total_tokens);
    assertEquals(result.usage.fields.cached_tokens, "unavailable");
    assertEquals(result.usage.fields.cache_write_tokens, "unavailable");
    assertEquals(result.usage.fields.reasoning_tokens, "unavailable");
    assert(result.usage.fields.cached_tokens !== 0, "cache hit must never be inferred from input_tokens");
    assertEquals(result.usage.savings_claim, "none");
    // Documented pinned-parser default: absent details map to 0 in the typed view only.
    assertEquals(result.typedUsage?.cached_input_tokens, 0);
  } finally {
    await server.stop();
  }
});

Deno.test("M2-T19b pin-parser contract: usage missing total_tokens drops the completed event", async () => {
  const server = await startMockResponsesServer("usage-missing-total");
  try {
    const error = await captureError(() =>
      sendResponsesTurn({
        baseUrl: server.baseUrl,
        body: buildResponsesRequest({ input: BASE_INPUT }),
      })
    );
    assertEquals(error.kind, "stream");
    assertEquals(error.message, "stream closed before response.completed");
    // Raw response bytes preserve the partial usage; only the typed parse drops it.
    assert(
      USAGE_MISSING_TOTAL_SSE.includes(`"input_tokens":${USAGE_MISSING_TOTAL.input_tokens}`),
      "raw usage must be preserved in the response bytes",
    );
    assert(USAGE_MISSING_TOTAL_SSE.includes(`"output_tokens":${USAGE_MISSING_TOTAL.output_tokens}`));
    assert(
      !USAGE_MISSING_TOTAL_SSE.includes("total_tokens"),
      "the fixture must omit the required total_tokens that drops the completed event",
    );
  } finally {
    await server.stop();
  }
});

Deno.test("M2-T20 unknown pricing with reported usage: low confidence, amount null, no money", async () => {
  const server = await startMockResponsesServer("usage-full");
  try {
    const result = await sendResponsesTurn({
      baseUrl: server.baseUrl,
      body: buildResponsesRequest({ input: BASE_INPUT }),
    });
    const estimate = unknownPricingEstimate(result.usage);
    assertEquals(estimate.confidence, "low");
    assertEquals(estimate.amount, null);
    assertEquals(estimate.currency, null);
    assert(estimate.unknown_fields.length > 0, "unknown_fields must be non-empty");
    assertEquals(estimate.usage.status, "reported", "usage is still recorded");
    assert(!MONEY_PATTERN.test(JSON.stringify(estimate)), "estimate must contain no price, currency, or total");
  } finally {
    await server.stop();
  }
});

Deno.test("M2-T21 two-turn cache-epoch sequence: epoch flip and savings gating (I13)", async () => {
  const server = await startMockResponsesServer("epoch-sequence");
  try {
    const ledger = new CacheEpochLedger();
    const history = [...BASE_INPUT];

    const turn1 = await sendResponsesTurn({
      baseUrl: server.baseUrl,
      body: buildResponsesRequest({ input: history }),
    });
    assertEquals(turn1.usage.fields.cached_tokens, "unavailable");
    const changed = ledger.observe("epoch_v1", turn1.usage);
    assertEquals(changed.epochChanged, true);
    assertEquals(changed.disposition, "cache_write_or_uncached");
    assertEquals(changed.savings_claim, "none", "a changed epoch cannot claim savings");

    const turn2 = await sendResponsesTurn({
      baseUrl: server.baseUrl,
      body: buildResponsesRequest({ input: appendHistory(history, turn1.outputItems) }),
    });
    assertEquals(turn2.usage.fields.cached_tokens, USAGE_FULL.input_tokens_details.cached_tokens);
    const unchanged = ledger.observe("epoch_v1", turn2.usage);
    assertEquals(unchanged.epochChanged, false);
    assertEquals(unchanged.disposition, "cached");
    assertEquals(unchanged.savings_claim, "requires_reported_cached_tokens");
    assertEquals(server.requests.length, 2);
  } finally {
    await server.stop();
  }
});

Deno.test("M2-B10 no fixture, usage record, or assertion carries money (I10)", () => {
  const artifacts = {
    usageFixtures: { USAGE_FULL, USAGE_DETAILS_OMITTED, USAGE_MISSING_TOTAL, USAGE_FULL_SSE },
    usageRecords: [
      recordUsage(USAGE_FULL),
      recordUsage(USAGE_DETAILS_OMITTED),
      recordUsage("unavailable"),
    ],
    estimate: unknownPricingEstimate(recordUsage(USAGE_FULL)),
  };
  assert(!MONEY_PATTERN.test(JSON.stringify(artifacts)), "usage artifacts must contain no price or currency");
  for (const record of artifacts.usageRecords) {
    assertEquals(record.savings_claim, "none");
    assert(!MONEY_PATTERN.test(JSON.stringify(record)));
  }
});
