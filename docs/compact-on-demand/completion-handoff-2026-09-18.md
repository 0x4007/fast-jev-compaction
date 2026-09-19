# Compact-on-demand completion

## Canonical goal identity

Continuation of session `01a0b1b1-49e4-76e0-a567-0369d8a02131`, authorized by the owner on 2026-09-18 to set a corrected goal and finish. Keep the existing parent lane; do not rename or recreate it.

- Parent repository: `/Users/nv/repos/0x4007/fast-jev-compaction`
- Canonical existing lane: `/Users/nv/repos/0x4007/.codex-worktrees/compact-on-demand-implementation`
- Branch: `codex/compact-on-demand-implementation`
- Original base: `c1eab5fdbd6bde7d67f2da070116496558836884`
- Recovered head: `a2ddaf45fecfcb2edbb0949da519833c2967127b`, clean before this handoff
- Stable plan: `/Users/nv/repos/0x4007/.codex-worktrees/compact-on-demand-implementation/docs/compact-on-demand/completion-handoff-2026-09-18.md`
- Owner: primary orchestrator; implementation: DeepSeek through DSH, one writer per surface

## Corrected goal

Finish the actual pinned Rust Codex compact-on-demand client with deterministic per-user-request selection, canonical-history preservation, active-chain pinning, cost/cache-aware ranking and safe fallback, prove the real client against loopback mocks, run only gpt-5.6-luna with reasoning none or low only when required, and commit and push the completed implementation without changing the shipping proxy or host configuration.

## Authority and discrepancies resolved

- The user's exact inference-test target is `gpt-5.6-luna`. Astra is prohibited for inference tests. Old goal and old control documents naming Astra as Luna are invalid. No aliases, provider substitution, inherited model/reasoning defaults, or retries.
- The user requires selection once per user request, not after a token threshold. Cost ranks coverage-valid candidates; approximately equal costs prefer fewer input tokens. The old M1 text forbidding that final tie-break conflicts with the explicit user correction and is superseded.
- Existing M0-M3 documents were intermediate shadow-first specifications, not permission to stop at a mock or shadow-only implementation. Finish actual client behavior after focused mock proof. Preserve non-destructive unknown-price/cache fallback and never invent prices or savings.
- `vendor/codex` remains an immutable checkout. Implement changes in a separately recorded fork worktree from its exact base, commit and push that fork branch, and then deliberately advance the parent gitlink to that exact reachable fork commit. This is the explicit pin-update event contemplated by M0; it is not an in-place vendor edit or upgrade to a different upstream.
- The previous-session protocol error does not require repairing the shared proxy before building/testing an isolated client against an isolated mock or the already-authorized direct UOS endpoint. Do not repair or restart shared services as a side task.
- This is experimental R&D plus the requested focused commit/push, not a production release, new system installation, or default-branch merge. Do not add a product environment variable, flag, secret, or CLI option.

## Ordered delivery

1. Implement the minimal Rust path at the existing per-user-request boundary. Keep canonical history as source and freeze selection across internal tool continuations with an append-only active overlay. Copy selected items without rewriting them. Keep tool dispatch driven by fresh stream events only.
2. Implement deterministic coverage/anchor retrieval and closure, stable-prefix accounting, honest versioned cost inputs, a no-selection baseline, smaller-input tie-break only for approximately equal costs, and conservative fallback with safe structural diagnostics. Reuse existing runtime options/interfaces; no unrequested product knob.
3. Focused Rust tests and real pinned-client loopback integration prove selection, history preservation, active-chain continuation, no replay, fallback, and usage handling. Existing TS doubles remain clearly labeled; enable or replace deferred projection tests only when real coverage exists.
4. Luna-only live smoke: one immediate GET `/v1/models` exact-slug gate, at most two synthetic inference calls, `none` first and `low` only after explicit none rejection/enforcement, no retries, 120s bound per call, existing `UOS_AI_TOKEN`, direct existing UOS provider endpoint only. Hard request allowlist before forwarding, exact response-model check. No private history, Jev calls, billing claims, or secrets in artifacts.
5. Record limitations/evidence tied to exact tested changes, commit only owned files, push the fork implementation branches, advance and commit parent gitlink, verify remote reachability. Do not merge main, delete branches, install a replacement CLI, or alter host config/proxy.

## Evidence and intervention

Use `/Users/nv/.codex/agents/assets/test-evidence/evidence.ts`, registered exact commands and capture mode; parent mechanically relays host storage/build operations when DSH sandbox denies them. Workers propose exact commands before relay, then interpret saved results. Compilation may be a cold build; initial expectation 10-30 minutes with compiler output as progress, inspect failures rather than repeating unchanged. Worker assignments are immutable; print-mode feedback is the next bounded assignment. Stop only exact task-owned workers/jobs on confirmed failure or unsafe action; never restart a shared daemon.

## Completion audit

Require actual Rust mutation and compiled-client request proof, deterministic selection, preserved canonical records, active tool pairing, no historical dispatch, meaningful cost/cache fixtures and honest unknown-data fallback, Luna-only serialized request/response evidence, exact command statuses/references, and committed/pushed reproducible parent plus fork state. Report experimental limitations; no 1M-token, accuracy, dollar-savings, installed-client, or production claims without those separate proofs.

## Fork module m01-client

- Module ID: `m01-client`; derived aid10 `788f68d68d`.
- Repository: `/Users/nv/repos/0x4007/codex`.
- Worktree: `/Users/nv/repos/0x4007/codex/.codex-worktrees/completion-handoff-2026-09-18-m01-client-a788f68d68d`.
- Branch: `codex/completion-handoff-2026-09-18-m01-client-a788f68d68d`.
- Base: `5c583fe89bbd3ab4dc9a05768299f94e52fe8452` exactly, no newer upstream.
- State: created by primary 2026-09-18, owned writer DeepSeek DSH worker-02; parent integration only after exit/descendant settlement.
- Owned implementation: focused `codex-rs/core/src/working_set.rs` (or minimal module), `core/src/codex.rs`, `core/src/lib.rs`, core tests, and minimal protocol/client/model/config changes proven indispensable for the requested feature/Luna-none wire compatibility; no TUI redesign, dependencies, broad refactor, sandbox constants, auto-compact trigger changes, host configuration, or Git writes by worker.
- Dependent parent harness owns only `tests/compact-on-demand/**` and docs, not Rust; serialized coordination on data contracts through handbacks.
- Accepted fork tip must descend from exact source pin and be pushed before parent advances gitlink. The user checkout on main remains unchanged.
