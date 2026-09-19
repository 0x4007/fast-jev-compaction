# M1 — Working-set shadow path (specification)

Implementation status (2026-09-18): this file is the historical shadow-first
specification. The delivered per-request selector, its actual manifest fields,
seams, evidence, and limits are in
[`IMPLEMENTATION.md`](IMPLEMENTATION.md); the recorded code/evidence supersede
this text where they differ.

Status: `[PROPOSED]` design; nothing in M0 implements it. Date: 2026-09-18.
Revision: 2026-09-18 adds cost-aware selection (C2, C13, §4) per M0 §4.
Source pin: `5c583fe89bbd3ab4dc9a05768299f94e52fe8452` (`vendor/codex`) — all
symbol references below are from that revision. Invariants I1–I15 in
[`M0-spec.md`](M0-spec.md) are binding here.

## 1. Goal

Derive, once per user request, a **working set**: a projection of the
append-only canonical history that keeps what the current request needs and
omits the rest. M1 ships this as a **shadow path**: the projection, its manifest,
and its **cost estimate** are computed and recorded, while the request actually
sent to the model stays byte-identical to today's canonical-history request. No
behavior change until the seam is proven.

**User correction preserved: selection is not driven by token count.** No token
target, threshold, ratio, or budget may influence which items are selected,
their order, or their pinning. Token counts appear only as accounting inputs to
the cost estimate (C13) and as recorded observations (`telemetry.tokens`). A
cost estimate is itself never a relevance rule: it ranks only candidates that
already pass C5–C8.

## 2. Definitions

| Term | Meaning |
| --- | --- |
| Canonical log | The append-only recorded history the session already maintains. M1 does not add a second history format. |
| Item | One canonical history entry (`ResponseItem` at the pinned revision). |
| `item_id` | Stable derived id: `"i" + zero-padded seq (6) + "-" + sha256(canonical_json(item))[0..12]`. Stable because the log is append-only. |
| Projection | The ordered list of `item_id`s selected for one user request, mapped back to byte-identical item JSON. |
| Pin | An item that selection may never omit. |
| Shortlist | The deterministic subset of non-pinned items that may be sent to Jev for a keep/drop decision. |
| Manifest | The per-request record of pins, retrieval hits, Jev decisions, omissions, fallback, telemetry, and cost. |
| Fallback | The non-destructive outcome: send canonically-unmodified history and record why. |
| Candidate | A projection that already satisfies C5–C8. Cost ranks candidates; it never creates one. |
| Pricing catalog | The versioned per-model record of M0 §4.1, read (not written) by M1. |
| Epoch | Cache-stability identity of M0 §4.5 for the stable prefix; recorded as `epoch_id`. |
| Baseline | The no-selection canonical full-history request, costed with the same catalog (M0 §4.2). |

## 3. Normative contract

- **C1 — Per user request.** Exactly one projection per user request, computed
  before the first model inference of that request. Tool follow-up turns within
  the same request reuse the same projection plus the active-chain overlay (C4);
  they do not recompute a new selection.
- **C2 — No token target (I2, I11).** The projection module must not read
  `get_auto_compact_token_limit()` (`codex-rs/core/src/client.rs:107`),
  `get_model_context_window()` (`:101`), or any token budget. Token counts must
  not appear in any selection predicate, sort key, cap, or threshold. The only
  permitted size-driven behavior is the hard abort in C9. Token counts may enter
  the cost estimate (C13) as accounting inputs only, and the cost estimate may
  not introduce a token threshold, tie-break, or cap.
- **C3 — Append-only source (I1).** The canonical log is never mutated,
  reordered, truncated, or rewritten by the projection path. The projection is a
  pure function of (canonical log, current request, active-chain state).
- **C4 — Active tool-chain overlay.** For the request in flight, the pending
  tool call and every call/result pair produced by it are pinned for the
  lifetime of the request. The overlay is keyed by `call_id`; a call and its
  output are never separated (C6).
- **C5 — Deterministic pins.** Pin classes, applied in this order, each
  deterministic by log position and request content only:
  1. `current_request` — every item belonging to the current user request;
  2. `active_tool_chain` — C4 items;
  3. `explicit` — items marked pinned in the canonical log (a carried prefix or
     a prior decision record);
  4. `dependency_closure` — C6.
  Pins are never removed by Jev, and Jev is never asked about a pinned item.
- **C6 — Closure and no orphans.** If an item is selected, every item it
  depends on is selected. Concretely, in the pinned revision: a selected
  `function_call` requires its matching `function_call_output` (same `call_id`)
  and vice versa. A pair is kept or dropped **whole**. Orphan selection is a
  manifest-validation error, not a warning.
- **C7 — Deterministic retrieval.** Anchors are extracted from the current
  request by fixed rules (quoted strings, file paths, identifiers, error codes,
  URLs). An item is a retrieval hit iff it contains at least one anchor; score =
  number of distinct anchors matched; ties break by ascending `seq`. Retrieval
  is recomputed identically on identical input and never uses embeddings,
  sampling, clocks, or token counts. A fixed *count* cap is permitted; a
  token-derived cap is not (C2).
- **C8 — Deterministic Jev shortlist.** The shortlist is all non-pinned items,
  ordered by ascending `seq`. Batching across transport requests is
  deterministic and may use a fixed constant byte bound, but batching must not
  change membership: **every** shortlisted item receives a question. Jev may
  only answer `keep`, `drop_pair` (both call and output), or `drop_item` (an item
  with no call/result pairing, e.g. a stale user/assistant text block). Jev may
  not add items, rewrite content, or answer for an item it was not asked about.
  A missing, duplicate, ambiguous, or malformed answer is a fallback (C9), never
  a default keep or drop. Jev is **not invoked at all** when deterministic
  retrieval (C7) plus pins already resolve the shortlist, or when its expected
  cost/latency is not justified (I14); skipping Jev is recorded as
  `jev.outcome = "skipped_deterministic"`, never as an omitted decision.
- **C9 — Fallback (I6).** Fallback sends the canonical history unmodified and
  records `fallback.used = true` plus a `reason` from a closed set
  (`jev_error`, `jev_timeout`, `jev_malformed`, `schema_invalid`,
  `closure_violation`, `hard_context_overflow`, `internal_error`,
  `pricing_unknown`, `pricing_stale`, `cache_ineligible`). Conditions:
  any selection-stage error, any Jev transport/parse failure, any unaccounted
  item, or a projection that cannot be represented within the provider's hard
  context limit. Hard overflow is an **abort, not a target**: the code must not
  shrink the projection to fit. No partial projection is ever used. A
  `low`-confidence cost result (C13.4) selects the baseline path and records
  `pricing_unknown`/`pricing_stale` with `fallback.used = true`; it never
  proceeds on optimistic savings.
- **C10 — No replay (I4).** Selected historical tool calls are context only.
  Dispatch stays driven exclusively by the live stream of the current turn
  (`ResponseEvent::OutputItemDone`, `codex-rs/core/src/client_common.rs:70`,
  emitted at `codex-rs/core/src/client.rs:570`). The projection layer must not
  enqueue, execute, or synthesize tool calls, and must not touch the
  tool-dispatch path.
- **C11 — Selection, not rewriting.** Selected items are copied byte-identically.
  Nothing is summarized, re-rendered, re-ordered, or annotated inside the item
  payload. The only added data is the out-of-band manifest.
- **C12 — Observability.** Every canonical item is accounted for in the manifest
  as `selected` (with pin class or retrieval/Jev provenance) or `omitted` (with
  decision source and reason). There is no silent omission.
- **C13 — Cost-aware selection (I10–I15, M0 §4).** For every candidate and the
  baseline, compute `expected_cost(candidate, model, horizon)` with the catalog
  version in force, under the M0 §4.2 data contract. Then:
  1. Cost is a suffix policy: it ranks only candidates that already satisfy
     C5–C8 and coverage; it never adds, drops, or reorders an item to save money.
  2. The comparison key is `net = task_coverage − expected_cost` at the declared
     horizon `H1`/`H2(k)` with reuse probability `p`. Tokens alone are never the
     key, and maximum compression is never a default (M0 §4.6a–b).
  3. Cache disposition follows the epoch: unchanged `epoch_id` may bill cached
     tokens; a changed epoch bills cache-write/uncached (I13). With no usage
     evidence, `savings_claim` is `none` (I15).
  4. `confidence` gates behavior: `high` may inform selection, `medium` is
     shadow-only, `low` records `amount: null` + `unknown_fields` and keeps the
     canonical request. Missing rates are never invented (I10).
  5. `jev_cost` (model, tokens, retries, latency) is a term in the comparison;
     deterministic retrieval is preferred when it suffices (I14).
  Because M1 is shadow-only, even a `high`-confidence winner changes nothing on
  the wire; it is recorded as the candidate for the future flip decision.

## 4. Cost policy in the shadow path `[PROPOSED]`

M0 §4 is normative. M1 implements only the *estimation and recording* half — no
wire behavior changes.

### 4.1 Candidate generation vs candidate ranking

1. Generate candidates exactly as before: pins (C5), closure (C6), retrieval
   (C7), Jev (C8). These determine coverage.
2. Compute `expected_cost` for each candidate **and** the baseline (M0 §4.2),
   with `model` = the model configured for the request, `horizon` = `H1` or
   `H2(k)` declared per fixture/session, and `p` = declared reuse probability.
3. Rank by `net = task_coverage − expected_cost`, then apply the confidence gate
   (C13.4). Record the ordering, the baseline, and the winner in the manifest.
4. Shadow mode sends the canonical request regardless of the winner; the
   recorded winner is advisory input to the future flip decision.

### 4.2 Estimates out, usage back

`estimated` values are written before the request; provider `usage` (§6) is
written after the response and never overwrites the estimate. A comparison
between the two is reported as `estimated_vs_actual`, and any savings statement
requires the actual fields (I15). M1 does not read billing rates at runtime
unless a catalog record is present; with no record it emits
`cost.confidence = low`.

### 4.3 Fixtures (M0 §4.6)

| Id | Fixture | M1 assertion |
| --- | --- | --- |
| A10 | (a) large stable mostly-cached | Estimate uses cached line item; epoch unchanged; token count is high yet candidate is not penalized |
| A11 | (b) tiny uncached | Candidate may lose to (a) on `net`; asserts a token-count ranking would pick the opposite winner |
| A12 | (c) medium with cache write | Cache-write line item present; result depends on `p` and `H2(k)`, not on size |
| A13 | (d) unknown pricing | `confidence: low`, `amount: null`, `unknown_fields` non-empty, baseline sent, `savings_claim: none` |

Fixtures use synthetic labeled rate tables only; no rate is recorded for
`gpt-6-astra` or UOS (I10).

## 5. Seam in the pinned source `[VERIFIED]`

| Location | Symbol | Role |
| --- | --- | --- |
| `codex-rs/core/src/codex.rs:1930` | `async fn run_turn(..., input: Vec<ResponseItem>)` | The per-turn entry point; `input` is the canonical history handed to the model. |
| `codex-rs/core/src/codex.rs:1942` | `let prompt = Prompt { input, tools, base_instructions_override }` | The single construction site of the model request for a turn — the natural projection seam. |
| `codex-rs/core/src/codex.rs:2062` | `Cow::Owned(Prompt { input, ..prompt.clone() })` | Review-mode variant; must receive the same projection treatment or be explicitly excluded. |
| `codex-rs/core/src/client.rs:116` | `ModelClient::stream(&Prompt)` | Where `prompt.input` becomes the wire payload; must not be the first place selection happens if a manifest is required. |
| `codex-rs/core/src/client_common.rs:24` | `pub struct Prompt { input: Vec<ResponseItem>, … }` | The projection replaces `Prompt.input` only. |
| `codex-rs/core/src/client_common.rs:121` | `ResponsesApiRequest` | Wire shape; unchanged by M1. |
| `codex-rs/core/src/codex.rs:1829-1851` | `token_limit_reached` → `run_inline_auto_compact_task` | The existing, token-triggered auto-compaction. M1 neither uses nor changes it. |
| `codex-rs/core/src/codex/compact.rs` (`SUMMARIZATION_PROMPT` at `:31`) | summarization compaction | Separate path (`Op::Compact`, `codex-rs/protocol/src/protocol.rs:169`, `EventMsg::Compacted` at `:922`). M1 must not interfere with it. |

`[PROPOSED]` The projection is a new module (e.g. `codex-rs/core/src/working_set/`)
called from `run_turn` before `Prompt` construction, returning
`(Vec<ResponseItem>, SelectionManifest)`. In shadow mode the manifest is recorded
and the original `input` is still passed to `Prompt`.

## 6. Manifest and data schema `[PROPOSED]`

Strict JSON, `additionalProperties: false`, no clocks and no random ids (C11/I5):
`run_id` is a deterministic counter (`m1-<fixture>-<n>`), and all digests are
`sha256:` over canonical JSON (sorted keys, no insignificant whitespace).

```jsonc
{
  "schema_version": 2,
  "kind": "compact-on-demand/selection-manifest",
  "run_id": "m1-fixture-0001",
  "request_id": "req-0001",
  "source_pin": "5c583fe89bbd3ab4dc9a05768299f94e52fe8452",
  "model": "…",
  "canonical": { "log_len": 42, "digest": "sha256:…" },
  "projection": { "items": ["i000003-1a2b3c4d5e6f", "…"], "digest": "sha256:…" },
  "epoch": { "epoch_id": "sha256:…", "stable_prefix_digest": "sha256:…", "changed": false },
  "cache_disposition": { "cached_eligible": true, "reason": "epoch unchanged; prefix byte-identical" },
  "pins": [
    { "item_id": "i000041-…", "pin_class": "current_request", "reason": "seq 41 is the current user request" },
    { "item_id": "i000042-…", "pin_class": "active_tool_chain", "reason": "call_id=call_7 awaiting output" }
  ],
  "retrieval": [
    { "item_id": "i000012-…", "rule": "anchor", "anchors": ["src/working_set/mod.rs"], "score": 2, "tie_break": 12 }
  ],
  "omissions": [
    { "item_id": "i000004-…", "decision_source": "jev", "decision": "drop_pair", "reason": "superseded read of same path at seq 31" }
  ],
  "jev": {
    "shortlist": ["i000004-…", "…"],
    "batches": [ { "batch": 1, "items": ["i000004-…"], "request_digest": "sha256:…" } ],
    "answers_digest": "sha256:…",
    "outcome": "ok"
  },
  "cost": {
    "catalog_version": "…",
    "currency": "USD",
    "unit": "per_1m_tokens",
    "horizon": "H2(3)",
    "reuse_probability": 0.7,
    "confidence": "high",
    "unknown_fields": [],
    "estimate": {
      "candidate": { "amount": 0.0, "breakdown": { "uncached_input": 0.0, "cached_input": 0.0, "cache_write": 0.0, "output": 0.0, "long_context": 0.0, "retrieval": 0.0, "jev": 0.0 } },
      "baseline":  { "amount": 0.0, "breakdown": { "…": 0.0 } },
      "net": 0.0
    },
    "usage": { "status": "pending", "input_tokens": null, "cached_tokens": null, "cache_write_tokens": "unavailable", "output_tokens": null, "reasoning_tokens": "unavailable" },
    "savings_claim": "none"
  },
  "cost_decision": { "winner": "candidate", "shadow_only": true, "reason": "high confidence; shadow mode sends canonical anyway" },
  "fallback": { "used": false, "reason": null },
  "telemetry": {
    "tokens": { "canonical": 1234, "projection": 567 },
    "note": "observational/accounting only; never an input to selection (C2)"
  }
}
```

Field rules: `cost.estimate.*.amount` and `cost.estimate.net` are `null` when any
required rate is unknown; `cost.usage.status` is `pending` at estimate time and
`reported`/`unavailable` after the response; provider fields are never merged
into `estimate`; `cost_decision.shadow_only` is `true` whenever `confidence` is
not `high` or M1 is in shadow mode; `cost.savings_claim` stays `none` until
provider usage exists (I15). No numeric price literal for any real model may
appear in a fixture or manifest (I10).

Per-item decision records are also written as append-only JSONL
(`selection-record.jsonl`, one object per canonical item per run) so a test can
assert C12 without parsing the full manifest. Field set matches `pins`,
`retrieval`, and `omissions` above plus `{ "status": "selected" | "omitted" }`.

The canonical log itself keeps its existing recorded form (`RolloutItem`,
`CompactedItem`); M1 adds no canonical writer and no canonical schema.

## 7. Rollout

1. Shadow mode on a fixture: compute projection + manifest + cost estimate; send
   canonical history; assert A1–A15 below.
2. Shadow mode in a real bounded session (M3 only): same, with provider usage
   recorded after each response (§4.2).
3. Flip to using the projection is **out of scope for M1** and requires a
   separate decision with M2 wire evidence *and* a `high`-confidence catalog
   record; an unknown-price model (e.g. `gpt-6-astra`/UOS today) cannot be the
   first flip (I10/I12).

## 8. Acceptance criteria for M1

| Id | Check |
| --- | --- |
| A1 | Two projections of the same fixture produce identical `projection.digest` and manifest bytes. |
| A2 | Setting `model_auto_compact_token_limit` (or the model context window) to any two different values leaves `projection.digest` byte-identical; a static check shows the projection module never calls the token-limit accessors (C2). |
| A3 | Closure holds: every selected call has its selected output and vice versa (C6); a synthetic orphan is rejected as `closure_violation` → fallback. |
| A4 | Canonical digest and record count are unchanged before/after projection (C3); the projection path performs no canonical writes. |
| A5 | With a pending call, the call is pinned before Jev and never appears in `jev.shortlist` (C4/C5). |
| A6 | Dispatch counter equals the number of tool calls emitted by the current turn's live stream; zero historical dispatches (C10). |
| A7 | Injected `jev_error`, `jev_timeout`, `jev_malformed`, and truncated answer each produce `fallback.used = true`, a closed-set reason, and a projection equal to the full canonical input (C9). |
| A8 | Every canonical item appears exactly once across `pins` + `retrieval` + `omissions` (C12). |
| A9 | In shadow mode the `Prompt` handed to `ModelClient::stream` is byte-identical to the pre-change canonical input. |
| A10 | Fixture (a): the large, epoch-stable, mostly-cached candidate is estimated with the cached line item and is not penalized for its token count (C13.2). |
| A11 | Fixture (b): the tiny uncached candidate can lose on `net` to (a); asserts that a token-count-only ranking would choose a different winner (C2/C13.2). |
| A12 | Fixture (c): cache-write is estimated and amortized over `H2(k)` with `p`; changing only token counts (not `p`/`k`) does not change the winner. |
| A13 | Fixture (d): unknown prices ⇒ `confidence: low`, `amount: null`, non-empty `unknown_fields`, canonical baseline sent, `savings_claim: none`, `fallback.reason` ∈ {`pricing_unknown`, `pricing_stale`, `cache_ineligible`} (C13.4/I10). |
| A14 | No manifest or fixture contains a price literal for `gpt-6-astra` or UOS; a static check finds no rate constants outside labeled synthetic tables (I10). |
| A15 | Before any `usage` exists, every savings-bearing field is `none`/`null` and `cost_decision.shadow_only = true` (I15). |

Fixture tests must report selected/omitted IDs, dependency closure, the unchanged
canonical digest, and the cost comparison (estimate, baseline, confidence,
winner) per the M0 plan and M0 §4.

## 9. Prohibited for M1

Editing `vendor/codex` in place to make the seam fit (I9); destructive history
rewrite; token-target tuning; inventing or hardcoding prices (I10); using a token
count as a selection/sort key via the cost path (C2/C13); invoking Jev when
deterministic retrieval suffices (I14); claiming cache savings without provider
usage evidence (I15); Jev receiving private history during the mock phase;
dispatching any tool call reconstructed from history (I4); changing
`Op::Compact` summarization or the existing auto-compact trigger.

## 10. Open questions

1. Seam: inside `run_turn` (`codex.rs:1942`) or a wrapper around
   `ModelClient::stream` (`client.rs:116`)? The former is easier to make
   deterministic and testable in-process; the latter catches compaction requests
   too, which M1 does not want.
2. Treatment of `Reasoning`/encrypted items: selected verbatim when their turn
   is selected, or always pinned? Azure's `attach_item_ids` path
   (`client.rs:449`) must keep working either way.
3. Whether a bounded *head* form of `drop_result` (call kept, output truncated)
   is ever valid for the Responses API. Until M2 shows wire evidence that an
   orphaned `function_call` is accepted, M1 drops whole pairs (C6).
4. Where the manifest is written (rollout-adjacent JSONL vs a separate debug
   directory) and its retention bounds.
5. Token estimation for the cost function: which deterministic counter (the
   pinned revision's existing tokenizer path vs a declared approximation) is
   authoritative, and how its error is recorded so estimates stay honest (I15).
6. How `reuse_probability` `p` and horizon `H2(k)` are derived without clocks or
   session-specific guesswork; the default must be the conservative
   `H1`/`p = 0` until evidence supports more.
7. How a candidate that keeps a *larger* stable prefix than the baseline is
   represented when the projection changes prefix order — prefix stability
   (M0 §4.5) may conflict with aggressive omission, and the tie-break must
   prefer the cache-stable form.
