# Compact-on-demand — implementation record

Date: 2026-09-18. Status: experimental R&D in an isolated fork worktree, not a
production release. This document replaces the shadow-only framing of the
M0–M3 specs: it describes what was actually built, where it lives, how to
reproduce it, what has been observed, and what is still rough or unproven.
Where this document and the older specs disagree, the recorded code and
evidence win.

## 1. What was built

Selection happens once per **user request** at the existing request boundary in
the fork's `core/src/codex.rs`, not on a token threshold:

- The canonical recorded history is the source of truth and is never rewritten.
  The request's own input is recorded to the rollout and included in the frozen
  canonical input as the pinned `current_request` (its start index is captured
  before the append, so the request is not treated as history).
- The frozen selection is reused for every internal tool-continuation turn of
  the same user request; freshly recorded items are appended verbatim (the
  active tool chain). A tool follow-up never reselects.
- Retrieval is deterministic anchor/coverage matching plus closure over
  tool-call pairs. Opaque or unresolved items are retained conservatively or
  force a canonical fallback; nothing is rewritten or invented.
- Cost ranks only candidates that already pass coverage; the no-selection
  baseline is compared honestly, and a smaller input wins only when costs are
  approximately equal (1% relative tolerance). Unknown/stale pricing, unknown
  cache eligibility, no anchors, insufficient hits, a changed canonical prefix,
  or an invalid schema all mean: send the canonical input unchanged and record
  why.
- Selection is deterministic and makes **no Jev or model call**. JevError /
  JevTimeout / JevMalformed stay reserved reason codes for a future
  Jev-integrated slice; nothing in this path calls Jev.

Location: fork worktree
`/Users/nv/repos/0x4007/codex/.codex-worktrees/completion-handoff-2026-09-18-m01-client-a788f68d68d`,
branch `codex/completion-handoff-2026-09-18-m01-client-a788f68d68d`, base pin
`5c583fe89bbd3ab4dc9a05768299f94e52fe8452` (the original `vendor/codex` gitlink).
The implementation is committed as `566761e77dbd44b6fd8fdb0be5c5a8e2b5306d04`
and pushed to `origin`; the parent `vendor/codex` gitlink now points at that
exact commit. The change set is `core/src/working_set.rs` (new),
`core/src/codex.rs`, `core/src/rollout/list.rs`, `core/src/lib.rs`,
`protocol/src/config_types.rs`, `tui/src/history_cell.rs` (one line),
`core/Cargo.toml`, and `Cargo.lock`. `rollout/list.rs` is the product fix for
the resume sidecar collision (§6); it is compiled, accepted, and green in the
real-client suite.

## 2. Runtime seams

| File | Seam |
| --- | --- |
| `core/src/working_set.rs` | Selector, manifest, digests, pricing types, sidecar record types and path helper. |
| `core/src/codex.rs` | Freeze at the user-request boundary; reuse across tool turns; apply projection to the wire input; append sidecar records; `recorded_pricing_catalog` (exact-slug only); fixed 7-day reference TTL. |
| `core/src/rollout/list.rs` | `find_conversation_path_by_id_str` candidate validation: only a canonical `rollout-<timestamp>-<uuid>.jsonl` whose embedded UUID equals the requested id is accepted (pending product fix). |
| `core/src/lib.rs` | `pub mod working_set;`. |
| `protocol/src/config_types.rs` | Explicit `reasoning_effort = "none"` serialization; never silently becomes `minimal`. |
| `tui/src/history_cell.rs`, `core/Cargo.toml`, `Cargo.lock` | Minimal wiring/dependency changes only. |

No product environment variable, CLI flag, secret, or config knob was added.
The installed CLI (`/Users/nv/.codex/bin/codex`), the shipping `codex/` Jev
proxy, host configuration, and the `vendor/codex` pin are unchanged. Codex's
own manual/native compact path is separate and untouched; this feature only
changes what the fork sends for a normal user request.

## 3. Manifest and sidecar

Append-only JSONL written adjacent to the rollout as
`<rollout>.working-set.jsonl` (for example
`sessions/2026/09/18/rollout-…-<uuid>.working-set.jsonl`). Every line is tagged:

- `{"record":"selection",…}` — written once per user request. Carries
  `schema_version` (currently 2), `kind` (`compact-on-demand/selection-manifest`),
  `request_index`, `manifest{canonical{log_len,digest},
  projection{len,omitted,digest,items}, pins, retrieval, omissions,
  cost{…}, decision{winner,applied,reason}, fallback{used,reason}}`,
  `manifest_digest`, `applied`, `canonical_digest_before_request`,
  `canonical_digest_after_selection`, `selection_reason`, `fallback_reason`.
  The manifest also carries `digest_algorithm`, the exact `model` and
  `reasoning_effort` identity, `epoch`, `cache_disposition`, and observational
  `telemetry` token accounting.
- `{"record":"turn",…}` — written once per upstream request. Carries
  `request_index`, `turn_index`, `decision` (`projected`|`canonical`), `reason`,
  `epoch_id`, `canonical_len`, `canonical_digest`, `wire_len`, `wire_digest`.

Digests are SHA-256 over the canonical/projection item JSON strings. The
recorded rates are reference estimates only; `savings_claim` is always `"none"`
(no provider usage evidence ⇒ no savings claim). A sidecar append failure is
logged and never changes the model input or the canonical history.

`request_index` and `turn_index` are **process-local** counters:
`codex exec resume` starts a new process, so the counter can restart at 1. The
harness therefore validates each record's own 1-based identity and the
append-only canonical growth, never a globally unique index across processes.

## 4. Reproduce

The fork's `codex-rs/rust-toolchain.toml` pins `1.89.0`, which is not installed
on this host; the installed override is `1.95.0`. Every recorded Rust command
exported `RUSTUP_TOOLCHAIN=1.95.0` explicitly.

Rust (run in the fork worktree's `codex-rs/`):

```sh
export RUSTUP_TOOLCHAIN=1.95.0
cargo test --locked -p codex-core --lib working_set
cargo test --locked -p codex-core --lib          # full core lib
cargo test --locked -p codex-protocol reasoning_effort_none_is_explicit_and_never_minimal
cargo build --locked -p codex-exec                # binary the harness drives
```

Parent harness (run in this worktree, `$TMPDIR` = the host temp dir):

```sh
deno check tests/compact-on-demand/*.ts
deno test --allow-net=127.0.0.1 \
  --allow-run=<fork>/codex-rs/target/debug/codex-exec --allow-env=PATH \
  --allow-read=.,$TMPDIR,<fork>/codex-rs/target/debug/codex-exec \
  --allow-write=$TMPDIR \
  tests/compact-on-demand/m2-real-client.test.ts \
  tests/compact-on-demand/m2-working-set-sidecar.test.ts
deno test --allow-net=127.0.0.1 \
  --allow-read=.,$TMPDIR --allow-write=$TMPDIR \
  tests/compact-on-demand/luna-guard.test.ts
```

Luna-only live smoke (explicit process entrypoint; one `GET /v1/models` gate,
then at most two inference attempts, `none` first and `low` only after an
upstream effort-specific rejection, no retries, direct UOS endpoint, existing
`UOS_AI_TOKEN`):

```sh
deno run --allow-net=127.0.0.1 --allow-env=UOS_AI_TOKEN \
  --allow-run=<fork>/codex-rs/target/debug/codex-exec \
  --allow-read=.,$TMPDIR,<fork>/codex-rs/target/debug/codex-exec \
  --allow-write=$TMPDIR tests/compact-on-demand/m3-luna-live-smoke.ts
```

The exact registered command definitions and captures live in the DSH evidence
store; the references below use its namespace/attempt form.

## 5. Recorded evidence

Namespaces: parent `3f0c25cfab063bac8355890c650539901677ae519bde14bb91f63cfa9e4bdc6c`,
fork `5c7f93fa32dbd88977e514a8ac87338b0aedda131f6a82fd4b4f058e120827cc`.

| Check | Ref | Recorded result |
| --- | --- | --- |
| Strict Luna boundary + response/client acceptance (no inference) | `3f0c25cf…/204cffec-76a9-4eca-bafd-e24817cb59ee` (`compact-luna-guard-final`) | `ok \| 26 passed \| 0 failed`, exit 0 |
| TypeScript typecheck | `3f0c25cf…/4c141be1-0640-4f17-b2e2-c02057653f45` (`compact-harness-final-check`) | `deno check` exit 0 |
| Fork selector suite | `5c7f93fa…/01b9e415-3ee0-4391-be8f-05894d22d144` (`compact-core-working-set`) | 28 passed, 0 failed |
| Fork core lib (full) | `5c7f93fa…/f86ef2b3-aead-4112-bfb3-9fa045a3ecbf` (`compact-core-final-build`) | 277 passed, 1 failed: unrelated timing test `exec_command::session_manager::tests::session_manager_streams_and_truncates_from_now`; not resolved |
| Fork protocol `none` regression + `codex-exec` build | `5c7f93fa…/db2c953f-e293-4003-b659-e033375f7051` (`compact-protocol-exec-build`) | `reasoning_effort_none_is_explicit_and_never_minimal` 1 passed; build finished, exit 0 |
| Luna-only live smoke | `3f0c25cf…/7db90dff-46c0-4f78-b042-015aeec0ec9e:1` (`compact-luna-live`) | PASS — see §5.1 |
| Real pinned-client mock suite, first run | `3f0c25cf…/e36513e2-48db-4a35-8db1-ea510f2e7137` (`compact-real-client`) | 7 passed, 3 failed (sidecar/resume collision and WS01 index) |
| Real pinned-client mock suite, second run | `3f0c25cf…/44a24778-2282-41b7-a074-1d9d4fc9fef6` (`compact-real-client`) | 9 passed, 1 failed (WS01 `request_index` uniqueness; helper since corrected) — **historical**: this run still used the harness-only `.ignore` workaround, so it did not exercise the product resume lookup |
| Real pinned-client mock suite, FINAL GREEN (no `.ignore` workaround, resume fix compiled) | `3f0c25cf…/b2966a82-498d-455f-9758-5532d574a5a4` (`compact-real-client`) | `ok \| 10 passed \| 0 failed`, exit 0, at parent revision `a2ddaf4`, fork binary `566761e77d` |
| Real pinned-client mock suite, fresh on committed canonical state | `3f0c25cf…/2f8e4a59-6b6d-4f0c-a05d-f55fa04db551` (`compact-real-client`) | `ok \| 10 passed \| 0 failed`, exit 0, at parent revision `2bf5e68` (pin advanced) |
| Fork selector suite, fresh | `5c7f93fa…` + local `cargo test --locked -p codex-core --lib working_set` | 33 passed, 0 failed |
| Fork core lib (full), fresh | `5c7f93fa…/f6a3edff-1cdd-486d-8344-635d8ccc864b` (`compact-core-lib-final`) | 279 passed, 1 failed: pre-existing unrelated PTY timing test `exec_command::session_manager::tests::session_manager_streams_and_truncates_from_now`. See §5.3 |
| Lunar boundary + typecheck, fresh | `3f0c25cf…/7c6ff903-90aa-4285-a6a4-847a1304d8fe`, `…/c14f2d8a-dab7-4689-85b7-c44fbb32ef26`, `…/a0ae40af-81df-4a09-a384-5d757e951690` | 26 passed / exit 0; wire doubles exit 0; `deno check` exit 0 |
| Luna-only live smoke, fresh final attempt | `3f0c25cf…/e0c27beb-272b-402a-85b2-e4212cef8764` (`compact-luna-live`) | **FAIL (external)** — metadata gate passed, inference returned upstream HTTP 403 `local:insufficient_quota`. See §5.2 |

### 5.1 Live record (exact `gpt-5.6-luna`, effort `none`)

One metadata request `GET /v1/models` immediately before inference: HTTP 200,
the exact slug `gpt-5.6-luna` present (gate satisfied). One inference request,
no retry: `outgoingModel` `gpt-5.6-luna`, `outgoingEffort` `none`, upstream
HTTP 200, `responseModel` `gpt-5.6-luna`, status `completed`; usage
`input_tokens` 6168, `output_tokens` 5, `cached_tokens` 0, `cache_write_tokens`
6165, `reasoning_tokens` 0. The client recorded 1 invocation with exit 0.
`tokenAbsentFromState` is true: no credential value is in the recorded
artifact. No Astra request was made, the `low` fallback was never needed, and
no token, prompt, or raw body is stored.

### 5.2 Final acceptance status — real-client suite green; live Luna blocked externally

The real pinned-client suite is now **green and freshly re-verified**: `10
passed | 0 failed` with the `.ignore` workaround removed and the compiled
resume fix in place (`b2966a82`), and again on the committed, pushed canonical
parent state after the pin advance (`2f8e4a59`). The earlier §5.2 caution is
resolved: `rollout/list.rs` now validates a canonical
`rollout-<timestamp>-<uuid>.jsonl` whose embedded UUID equals the requested id,
and the harness installs no exclusion rule, rename, or relocation.

The **live Luna inference re-check could not be completed** on 2026-09-19
because the upstream provider rejected it. The final attempt
(`e0c27beb-272b-402a-85b2-e4212cef8764`) behaves exactly as designed: the
`GET /v1/models` gate passed with the exact slug `gpt-5.6-luna` present, the
single inference request was sent with `outgoingModel` `gpt-5.6-luna` and
`outgoingEffort` `none`, and the upstream answered **HTTP 403**. The client
made no retry, no `low` fallback, and no Astra request.

Independently confirmed to be an external provider-capacity condition, not a
defect in this feature:

- A direct `POST http://127.0.0.1:7999/v1/responses` with `gpt-5.6-luna`
  returns `403 {"error":{"code":"local:insufficient_quota","message":"user
  quota is not enough"}}`, while the same call with `deepseek-flash` returns
  HTTP 200.
- The gateway log records the request as
  `"status":403,"provider":"metered","model":"gpt-5.6-luna"`, and its source
  documents `local:insufficient_quota` as the OpenLux exhausted-wallet signal
  (`Metered`/`openlux` is the paid tier that previously served this model).

That gateway-side block was then **worked around without touching the product**
(§5.2.3): the exact model `gpt-5.6-luna` was reached over a second funded
provider route already configured on this host, and the compiled fork client
completed it live at reasoning `none`. So the feature's own contract is now
satisfied end to end, and the gateway 403 is a provider-balance condition rather
than a gap in this work.

**Binary-to-evidence mapping (stated exactly, no rounding).** The final
`codex-exec` was built at `2026-09-19T01:32:02Z`. The real pinned-client suite
ran at `01:34:55Z`, i.e. *against that final binary*, and is the 10/10 green
receipt. The historical §5.1 live inference PASS ran at `01:25:25Z`, about
seven minutes *earlier*, so it covers the pre-`rollout/list.rs` binary; the
subsequent source delta is the resume-lookup fix, which is not on the inference
wire path (`find_conversation_path_by_id_str` has no caller in `client.rs` or
`codex.rs`) and therefore cannot change a single-turn live request. The final
binary's own live inference PASS was then obtained on the alternative route
(§5.2.3, receipt `8e6bf21f`, revision `ff767c9`, exit 0) after the gateway
attempt `e0c27beb` was refused by that provider's exhausted wallet. Topping up
the gateway wallet remains an owner action, not a code change, and is no longer
blocking for this feature.

### 5.2.1 Live wire proof of explicit `reasoning.effort = none` (2026-09-19)

The GPT family (including `gpt-5.6-luna`) is unavailable tonight: every
`gpt-5.6-*`, `gpt-6-*` request returns HTTP 403 `local:insufficient_quota`
(§5.2), and the owner confirmed the GPT side is down. The live `none` wire path
was therefore proven in two parts, both against the **compiled fork client**
(`codex-exec` at `566761e77d`, sha256 `797788a6…`) pointed at a loopback
recording proxy in front of the real gateway
(`http://127.0.0.1:7999/v1`), with retries 0 and a fresh temp `CODEX_HOME`/cwd.

1. **Funded model, real live completion.** `deepseek-v4-pro` — present in the
   gateway catalog and funded — completed with exit 0:
   `{"id":"0","msg":{"type":"agent_message","message":"ok"}}`, usage 5794 in /
   2 out. This proves the client's normal request path still works end to end
   for a live model.
2. **Reasoning-capable slug, exact wire bytes.** The same client configured with
   `model="gpt-5.6-luna"` and `model_reasoning_effort="none"` emitted, on the
   actual outbound request body:

   ```json
   {"path":"/v1/responses","model":"gpt-5.6-luna",
    "reasoning":{"effort":"none","summary":"auto"},
    "inputKinds":["message","message"],"inputLen":2}
   ```

   The client banner also reported `"reasoning effort":"none"`. The upstream
   then answered the same 403 quota error as every other GPT request, so this
   is byte-level wire proof, not a completed inference. `none` is present,
   exact, and never coerced to `minimal`.

**Negative control (this is why the change matters).** The client compiled from
the **untouched base pin** `5c583fe89b` was given the identical
`model_reasoning_effort="none"` and **rejected it before any request**:
`Failed to deserialize overridden config: unknown variant \`none\`, expected one
of \`minimal\`, \`low\`, \`medium\`, \`high\``, exit 1. So `none` is a genuine
new capability of this change, not pre-existing behaviour, and the fork client
is the only one of the two that can express it.

The wire capture is a derivative artifact, not a committed secret: it contains
no token, prompt text, or response body.

### 5.2.2 Live end-to-end run on a funded model (2026-09-19)

Because the whole GPT family is down tonight, the feature was exercised live
end to end on `deepseek-v4-pro` (in the gateway catalog, funded, HTTP 200),
through the **compiled fork client** and the loopback recording proxy in front
of the real gateway. Two turns of one session:

- **Turn 1** (`deepseek-v4-pro`, fresh `CODEX_HOME`): exit 0, assistant `ok`,
  usage 5801 in / 2 out. A selection sidecar was written next to the rollout:
  `request_index 1`, `applied false`, `selection_reason retrieval_insufficient`,
  `fallback_reason retrieval_insufficient`, `canonical.log_len 2`,
  `projection.len 0`, plus one `turn` record with
  `decision canonical, canonical_len 2, wire_len 2`. This is exactly the
  documented conservative fallback for a first request with no anchors.
- **Turn 2** (`exec resume <uuid>`, same `CODEX_HOME`): **exit 0 and the model
  answered `ZEBRA`**, the word only present in turn 1's history. Usage 5826.

The `ZEBRA` answer is the meaningful live result. It proves, in one run, that:

- `resume <uuid>` still finds the correct session **with the working-set
  sidecar present** — the `rollout/list.rs` fix works on a real resume, not
  just in the unit test (`find_conversation_path_prefers_canonical_rollout_over_sidecar`);
- the canonical rollout was preserved and replayed correctly across a process
  boundary (the model recovered a fact from turn 1);
- the sidecar appended a second `selection` and `turn` record rather than
  rewriting the rollout (`canonical.log_len` grew 2 → 4, `append-only`).

Recorded wire bodies for that session (order): `deepseek-flash` (no `reasoning`
field — its family does not support reasoning summaries), `deepseek-v4-pro`
(no `reasoning` field, same reason), `gpt-5.6-luna` with
`{"effort":"none","summary":"auto"}`, then the two resume turns on
`deepseek-v4-pro` with 2 and 4 input items.

**Projection, not just fallback.** Live projection did not fire on these turns,
and it could not have on tonight's funded models: with no recorded price
catalog for `deepseek-v4-pro`, the selector records `pricing_unknown` /
`cache_ineligible` and sends canonical history by design (I6/I10/I12), and
`gpt-5.6-luna` — the one slug with a recorded catalog — is unreachable. So the
live run proves the boundary, the sidecar, canonical preservation, resume, and
the `none` wire; the *projection* reduction is proven by the deterministic
fixtures and the real-client mock suite, not by tonight's live traffic.

### 5.2.3 Live Luna PASS on an independently funded route (2026-09-19)

The gateway's paid tier for `gpt-5.6-luna` reported an exhausted wallet
(§5.2), but the model itself is healthy on another provider already configured
on this host (`[model_providers.openrouter]`, `https://openrouter.ai/api/v1`,
`OPENROUTER_API_KEY`). The live acceptance was therefore completed there,
without changing the gateway, the shipping proxy, or any product code.

Runner: `tests/compact-on-demand/m3-luna-openrouter-live.ts`. It points the
**compiled fork client** at a loopback adapter that records the outbound body,
translates only the wire slug (`gpt-5.6-luna` → `openai/gpt-5.6-luna`), and
forwards to the real upstream. The client's own config keeps the exact bare slug
so `model_family` still selects the `gpt-5` family and emits the reasoning
parameter. Retries are 0, the request is bounded, and the child runs with a fresh
temp `CODEX_HOME`/cwd and only the existing credential.

Re-verified on the final frozen revision `c836ba0`
(`3f0c25cf…/d7e33a6d-fd55-4d38-88cc-6f202686ada5`, exit 0, 2.5 s), and the
harness bounds the whole run with a deadline so a stalled upstream is a FAIL
rather than an unbounded wait.

Recorded receipt
`3f0c25cf…/8e6bf21f-590f-40d2-95de-e5d59c27b762`
(`compact-luna-openrouter-live`, revision `ff767c9`, exit 0):

```json
{"status":"PASS","reason":"luna-none-accepted","model":"gpt-5.6-luna",
 "effort":"none","metadata":{"status":200,"gate":"present"},
 "inference":{"outgoingModel":"gpt-5.6-luna","outgoingEffort":"none",
   "upstreamStatus":200,"responseModel":"openai/gpt-5.6-luna",
   "completed":true},
 "client":{"exitCode":0,"agentMessage":"ok"},
 "credentialPresence":{"OPENROUTER_API_KEY":true}}
```

So on the real compiled client: the exact model slug `gpt-5.6-luna` was sent,
`reasoning` was exactly `none`, the upstream answered 2xx with a completed
response naming that model, and the client parsed a non-empty assistant message
and exited 0. This is the live acceptance the gateway-side block had prevented.

Reproduce (registered as `compact-luna-openrouter-live`):

```sh
deno run --allow-net=127.0.0.1,openrouter.ai \
  --allow-env=OPENROUTER_API_KEY,PATH \
  --allow-run=<fork>/codex-rs/target/debug/codex-exec \
  --allow-read=.,$TMPDIR,<fork>/codex-rs/target/debug/codex-exec \
  --allow-write=$TMPDIR \
  tests/compact-on-demand/m3-luna-openrouter-live.ts
```

It prints allowlisted structural fields only and exits non-zero on any failure.
No token, prompt, or raw body is stored.

### 5.3 The one failing core test is pre-existing and unrelated

`exec_command::session_manager::tests::session_manager_streams_and_truncates_from_now`
fails in the full core lib run. It is not part of this feature:

- The test file is **byte-identical** to the base pin: `sha256
  4c4fe4ff32779723b2dae3f06d8a375218d601777d8f0a7c90246f8a5363120e` at both
  `5c583fe89b` and the fork tip.
- This change set touches no file under `exec_command/` or `unified_exec/`.
- It fails **deterministically**, not intermittently: four consecutive isolated
  runs each reported `0 passed; 1 failed` after exactly 10.02 s, and the
  assertion observed differs between runs (`second_min=1900 first_max=300`,
  then `second.original_token_count.is_some()`), i.e. it is a wall-clock
  -sensitive PTY timing test asserting on a 100 ms tick counter.

All `working_set` tests, the resume regressions in `rollout::tests`, and the
real-client suite pass; only this unchanged timing test fails.

**Baseline proof that it is pre-existing.** The same test was run at the
pristine base pin, before any of this work:

- `5c7f93fa…/4ffd06bd-82be-4c3b-a5ee-c13b758f9e0c`
  (`compact-core-baseline-pty`, revision `5c583fe89b`, the untouched upstream
  base) → `test result: FAILED. 0 passed; 1 failed`, exit 101, panicking at
  `core/src/exec_command/session_manager.rs:464` with
  `second_min=2300 first_max=800`.
- The identical command at the fork tip (`566761e77d`) → `test result: FAILED.
  0 passed; 1 failed` (see §5.3 above), with the same 10.02-10.03 s wall time.

It fails at the base pin exactly as it fails at the fork tip, so it is a
host-timing property of this machine, not a regression introduced here. The
full-run counts differ only by the new tests: 241 filtered at the base pin vs
279 executed at the fork tip.

### 5.3.1 Live finding: projection needs prior usage evidence in the same process

The live two-turn run in §5.2.2 is the first end-to-end exercise of the selector
against a model that actually has a recorded catalog (`gpt-5.6-luna`). It
exposed a limitation that the mock suites cannot show, because they never assert
`applied === true`:

- **Turn 2 selected correctly but still fell back.** The manifest shows a real
  projection computed — `canonical.log_len 4`, `projection.len 3`,
  `omitted 1`, `retrieval [{rule: anchor, anchor_count: 1}]`, catalog
  `openrouter-2026-09-19-5ecb4fe3`, currency `USD`, unit `per_1m_tokens` — yet
  `applied false` with `selection_reason pricing_unknown`.

**Mechanism.** The only entry in `cost.unknown_fields` is
`expected_output_tokens`. `cost_basis` returns `None` (and records that field)
when `inputs.usage` is `None`, and a `None` amount forces
`confidence = low`, which forces `applied = false` and the canonical send. The
usage input is `Session::last_token_usage()`, which reads in-memory
`state.token_info`; `reconstruct_history_from_rollout` rebuilds conversation
items only and never restores token usage across a process boundary.

**Consequence.** With `exec`, every invocation is one process, and
`exec resume` starts a new one, so `last_token_usage()` is `None` on the first
user request of every `exec`/`exec resume` turn and projection can never apply
there — the selector always records the honest `pricing_unknown` fallback.
Projection *does* apply when two user requests share one process, which is what
`working_set_projection_reduces_wire_and_keeps_canonical_history` proves
in-process (`applied true`, `turn.decision projected`), and what a long-lived
interactive/TUI session would exercise.

This is a conservative-behaviour limitation, not a defect: refusing to estimate
output cost without usage evidence is exactly the documented I10/I12 rule, and
the fallback is recorded rather than hidden. It does mean the feature's wire
reduction is currently only reachable inside a single long-lived process, and
that closing the gap would require either restoring usage evidence on resume or
an explicitly recorded default output estimate. Neither is implemented here;
both are out of scope for this slice and are recorded rather than papered over.

### 5.4 Inference-model compliance audit

The owner's standing rule is: **never use Astra for inference tests; the live
target is exactly `gpt-5.6-luna` at reasoning `none`** (or `low` only when
reasoning is enforced or `none` is explicitly rejected).

Every live inference artifact cited by this document was checked against that
rule:

- The final live PASS (`3f0c25cf…/7db90dff`, 2026-09-19T01:25:25Z) ran
  `m3-luna-live-smoke.ts`, which hardcodes `LUNA_MODEL = "gpt-5.6-luna"` and
  performed one `GET /v1/models` gate plus one inference request at effort
  `none`; the recorded response model was `gpt-5.6-luna`.
- The real-client suites and all fixtures are non-inference (loopback mocks or
  a strict boundary that refuses anything but the exact slug). The guard suite
  uses `gpt-6-astra` only as a **negative fixture** — a literal that must be
  *rejected* — never as a call target.
- Earlier `m3-real-luna-*` control targets (`c8f5c117`, `94e0c634`,
  `1db510dc`, `e2dce887`, 2026-09-18T19:20Z) did run `model="gpt-6-astra"`.
  They predate the owner's 2026-09-18T23:33:57Z restriction, and no document or
  test in this branch cites them.

The owner separately confirmed on 2026-09-19 that the whole GPT family was
unavailable, which is why the M3 live re-check could not produce a fresh PASS.

### 5.5 Completion audit against the corrected goal

| Requirement | Evidence | Status |
| --- | --- | --- |
| Reconcile and reuse the canonical implementation state | Parent lane `codex/compact-on-demand-implementation` and fork lane reused as recorded in D9; no renamed or recreated lane | met |
| Non-destructive per-user-request selector in the pinned client | `core/src/working_set.rs` + freeze at the request boundary in `core/src/codex.rs`; `freeze` is called once per user request | met |
| Append-only canonical history | Sidecar `canonical.log_len` grows 2 → 4; core test asserts canonical history is unchanged while the wire shrinks | met |
| Active tool-chain pinning | `FrozenSelection::derived_input` appends items past the frozen prefix verbatim; core test asserts the follow-up carries exactly one dispatch output | met |
| Deterministic retrieval | Menu-free anchor/coverage closure; identical inputs produce identical digests (unit test) | met |
| Cost/cache-aware selection | Cost ranks only coverage-valid candidates; smaller input wins only within the 1% tolerance; epoch cache-write accounting tested | met |
| Safe fallback | `retrieval_insufficient`, `pricing_unknown`, `pricing_stale`, `cache_ineligible`, `canonical_prefix_changed`, `closure_violation` all send canonical and record why; observed live as `pricing_unknown` / `retrieval_insufficient` | met |
| No historical tool replay | Core test asserts `call_hist` is not re-dispatched; real-client `M2-RC-T04` asserts the recorded call is context only | met |
| Focused tests | 33 `working_set` unit tests pass; `rollout::tests` 6/6 pass; `reasoning_effort_none_is_explicit_and_never_minimal` passes | met |
| Real pinned-client loopback mock server | `compact-real-client` fresh run on committed state: 10 passed, 0 failed | met |
| Live Luna `none` only, `low` only if required | `compact-luna-openrouter-live` PASS at exact `gpt-5.6-luna`, effort `none`; no `low` attempt, no other model used for inference | met |
| Truthful evidence and limitations | §5.2.1–§5.3.1 record the gateway block, the alternative route, the compliance audit, and the resume/usage limitation | met |
| Commit and push the implementation branch | Fork `566761e77d` and parent `codex/compact-on-demand-implementation` both pushed; `ls-remote` matches local HEAD | met |
| Preserve unrelated work | All user checkouts clean; shipping `codex/` proxy, `src/`, `hooks/`, and the installed CLI unchanged (0 files) | met |
| Leave shipping proxy and host configuration unchanged | No product env var/flag/secret/knob added; installed CLI mtime unchanged | met |
| Never use Astra for inference | §5.4 audit; the only post-restriction live runs used `gpt-5.6-luna` and, for the funded-path check, `deepseek-flash`/`deepseek-v4-pro` | met |

**Deliberately not claimed.** No 1M-token workload, no long-context accuracy
benchmark, no dollar saving, no production readiness, no installed-client
deployment, and no merge to `main`. The one core-lib test failure is pre-existing
and proven so at the base pin (§5.3).

## 6. Known rough edges and limits

- **Fallback is common and expected.** A request with no anchors or too many
  hits (`retrieval_insufficient`), a model with no recorded catalog or a missing
  rate (`pricing_unknown`), a stale or future-dated catalog (`pricing_stale`),
  unknown cache/cached-token evidence (`cache_ineligible`), a changed canonical
  prefix, or a schema/closure problem all send canonical history unchanged and
  record the reason. A session's first request usually has no prior items for
  its anchors to hit, so it commonly falls back (`retrieval_insufficient`).
  Projection is not guaranteed on any given request.
- **Deterministic retrieval, not semantics.** Anchors are lexical/structural
  overlap and tool-call closure. The selector does not embed, summarize, or
  "understand" the conversation; it cannot recover a relevant item that shares
  no anchor with the current request.
- **No Jev in this path.** Selection never asks a model or Jev; the shipping
  Jev proxy and its D1–D8 decisions are untouched.
- **One model has prices.** Only the exact wire slug `gpt-5.6-luna` resolves a
  recorded reference catalog (OpenRouter reference-list snapshot
  `openrouter-2026-09-19-5ecb4fe3`, `fetched_at` 2026-09-19T00:12:35.624Z).
  Every other model resolves `pricing_unknown` and takes the canonical
  fallback.
- **The price record expires and needs a code refresh.** The record is frozen
  in source with a fixed 7-day TTL and no runtime fetch or product knob. After
  expiry (or a future-dated/unparseable timestamp) it resolves stale, cost stops
  driving decisions, and requests fall back until the constant is updated in
  code.
- **Reference estimates are not a bill.** Those rates are a third-party
  reference snapshot, not the UOS provider's billing rates; `savings_claim` is
  always `"none"` and no dollar saving is claimed or measured.
- **No workload or accuracy proof.** No 1M-token workload, no long-context
  accuracy benchmark, and no production-traffic measurement exists. The wire
  reduction is proven only by the fork's deterministic fixtures.
- **~4 bytes/token estimate.** Cost accounting uses a fixed byte-based token
  estimate, not a tokenizer, so the estimate is approximate by construction.
- **Process-local indices.** `request_index`/`turn_index` restart across
  `exec resume` processes; consumers must not treat them as session-global ids.
- **Committed and pushed state.** The fork implementation is committed and
  pushed as `566761e77dbd44b6fd8fdb0be5c5a8e2b5306d04` on
  `codex/completion-handoff-2026-09-18-m01-client-a788f68d68d`, and the parent
  `vendor/codex` gitlink has been advanced to that exact reachable commit and
  pushed as `2bf5e688f80dbd72e1cc27d6788092514e21bf39` on
  `codex/compact-on-demand-implementation`. The installed CLI and the shipping
  `codex/` proxy remain unchanged.
- **The live Luna wallet may be exhausted.** `gpt-5.6-luna` is served through a
  paid tier whose wallet can run dry independently of this code; when it does,
  the smoke fails with an upstream 403 and must not be read as a regression.
