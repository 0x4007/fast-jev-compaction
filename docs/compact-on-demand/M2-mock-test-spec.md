# M2 — Mock Responses server and tests (specification)

Status: `[PROPOSED]`; no test files are created in M0. Date: 2026-09-18.
Revision: 2026-09-18 adds usage/cache-accounting assertions (M2-T17…T21, B7–B10)
per M0 §4.7.
Client under test: the pinned source at
`5c583fe89bbd3ab4dc9a05768299f94e52fe8452` (`vendor/codex`). Invariants I1–I15 in
[`M0-spec.md`](M0-spec.md) are binding.

## 1. Goal

Prove, without credentials and without a real model, that the working-set
projection preserves the wire contract of the Codex Responses client: turn
input, tool continuation, selection/fallback, malformed/failure/crash handling,
and **usage/cache accounting** — and that no historical tool call is ever
dispatched (I4). Usage fields are proven here because M3 can only observe them,
not force them.

## 2. Harness decision `[RE-VERIFY]`

Two client surfaces exist; the spec allows either only if the handback records
which one ran and its provenance:

- **Preferred: the built pinned client.** `cargo build` in `vendor/codex` and run
  its CLI (`codex exec`) against the mock via provider config overrides. This
  tests the real wire client at the pin. Cost: a Rust build; feasibility on this
  host is an open decision in the plan.
- **Fallback: the installed client** (0.154.0, per `DECISIONS.md` D1) with its
  version recorded next to the pin. Acceptable for wire/framing tests, but the
  evidence must state that the binary is *not* the pinned revision, and any
  divergence found must be re-checked against the pin.

`[VERIFIED]` The pinned revision also supports an in-process shortcut for pure
parser tests: `stream_responses` returns a fixture stream when the
`CODEX_RS_SSE_FIXTURE` path is set (`codex-rs/core/src/client.rs:159-163`,
`stream_from_fixture` at `:679`). This bypasses HTTP entirely, so it **cannot**
substitute for the mock server (it cannot cover status codes, headers, framing,
timeouts, or crashes). It is a useful complement for parser cases.

The mock server itself is test-only code written in Deno/TypeScript (repo
default per `agents/deno.md`), using `Deno.serve` on `127.0.0.1` with an
OS-assigned port; no new runtime dependency and no package install.

## 3. Server contracts

### 3.1 Transport

- Bind `127.0.0.1` only, port `0` (OS-assigned); the port is passed to the client
  via provider `base_url` (`http://127.0.0.1:<port>/v1`).
- `POST /v1/responses` is the only model route. Unknown routes return 404 with a
  JSON error and are asserted never to be hit during a model-only test.
- Request headers asserted: `content-type` is JSON; `authorization` equals the
  test sentinel (never a real credential). A request carrying any other
  authorization value fails the test.
- Responses use `content-type: text/event-stream` and the exact SSE framing the
  client parses: `event: <kind>\n` + optional `data: <json>\n` + `\n`
  (`[VERIFIED]` `process_sse` at `codex-rs/core/src/client.rs:476`; test fixture
  helper `run_sse` at `:775`). Single-key events may be sent as
  `event: <kind>\n\n`.
- Every successful stream ends with `response.completed`. A stream that closes
  without it produces `CodexErr::Stream("stream closed before response.completed")`
  (`client.rs:514`).

### 3.2 Request contract (asserted by the server)

Validated against `ResponsesApiRequest` (`codex-rs/core/src/client_common.rs:121-139`):
required keys `model`, `instructions`, `input`, `tools`, `tool_choice`,
`parallel_tool_calls`, `reasoning`, `store`, `stream`, `include`, and optional
`prompt_cache_key`, `text`. Asserted invariants: `stream == true`,
`tool_choice == "auto"`, `parallel_tool_calls == false`, `input` is an array of
`ResponseItem` JSON, `model` equals the configured test model. The server
records each request body to a per-test JSON file for assertions; recorded bodies
contain only synthetic fixture content.

### 3.3 Response contract

Minimum success stream:

```text
event: response.created
data: {"type":"response.created"}

event: response.output_item.done
data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":10,"output_tokens":1,"total_tokens":11}}}
```

Tool-call stream: one `response.output_item.done` whose `item` is a
`function_call` (`name`, `arguments`, `call_id`) followed by
`response.completed`. The continuation request must contain the prior items plus
the matching `function_call_output`.

`[VERIFIED]` parser behaviors the matrix relies on: unparseable
`response.output_item.done.item` is skipped with a debug log (`client.rs:566`);
unparseable `response.completed.response` is ignored (`:628-640`, debug at
`:635`) and the turn then fails with the stream-closed error; `response.failed`
raises an error event (`:604-625`); `usage` is optional.

### 3.4 Usage and cache-accounting contract `[PROPOSED]`

The mock is the only place where cache accounting can be forced deterministically,
so the `response.completed` payload carries a **synthetic** usage object with the
same field names the real provider may use:

```jsonc
"usage": {
  "input_tokens": 1200,
  "input_tokens_details": { "cached_tokens": 1024, "cache_write_tokens": 176 },
  "output_tokens": 40,
  "output_tokens_details": { "reasoning_tokens": 24 },
  "total_tokens": 1240
}
```

- Values are synthetic fixture numbers; they are **token counts, not prices**,
  and the mock asserts nothing about money (I10/I15).
- The client-under-test must surface these raw fields to the harness; the harness
  records them as `usage` next to the M1 `cost.estimate`, never merged into it.
- Field exposure varies: a case with `usage` absent must yield
  `usage.status = "unavailable"` and `savings_claim: none` — never a zero-cost
  assumption.
- A test-side ledger compares the mock's own recorded request byte length against
  the reported `input_tokens` **only to prove the fields were carried through**,
  not to derive or assert a rate.
- No price, currency, or dollar value appears anywhere in M2 fixtures, server
  code, or assertions.

## 4. Test matrix

| Id | Case | Asserts |
| --- | --- | --- |
| M2-T01 | Single synthetic turn, no tools | Request shape (§3.2); assistant text parsed; canonical history gains exactly the turn's items; exit 0 |
| M2-T02 | Two sequential turns | Turn 2 request `input` contains turn 1's items verbatim; no reordering |
| M2-T03 | Function call + continuation | Continuation contains `function_call_output` with the same `call_id`; **dispatch count == 1** (I4) |
| M2-T04 | Shadow projection (once M1 exists) | Manifest written; canonical digest unchanged; `Prompt` sent == canonical history (M1 A9) |
| M2-T05 | Selection fallback (once M1 exists) | Injected Jev failure → full canonical history sent; `fallback.used = true` with closed-set reason |
| M2-T06 | HTTP 500 on first request | Deterministic client error; no partial turn recorded; process exit code recorded |
| M2-T07 | HTTP 429 + `Retry-After` | Retry count respects provider `request_max_retries`; no unbounded retry |
| M2-T08 | Malformed JSON request body received by server | Server 400 path exercised; client surfaces the error without panic |
| M2-T09 | 200 with `application/json` body instead of SSE | Client stream error, not a hang |
| M2-T10 | SSE truncated before `response.completed` | Error text is exactly the stream-closed error (`client.rs:514`) |
| M2-T11 | `response.failed` event mid-stream | Error surfaced; no phantom assistant item recorded |
| M2-T12 | `response.output_item.done` with unparseable item | Item skipped (`client.rs:566`); turn still completes; recorded history has no phantom item |
| M2-T13 | `response.completed` with unparseable `response` object | Turn fails with the stream-closed error; no partial success |
| M2-T14 | TCP connection closed mid-stream | Stream error; bounded time; no hang |
| M2-T15 | Silent stall past `stream_idle_timeout_ms` | Idle-timeout error (`client.rs:491`); bounded time |
| M2-T16 | Server killed between turns | Second turn fails cleanly; first turn's canonical history intact |
| M2-T17 | Full synthetic usage (cached + cache-write + reasoning) | Each field of §3.4 is carried through raw; `usage.status = "reported"`; fields are not merged into `cost.estimate` |
| M2-T18 | `response.completed` with `usage` absent | `usage.status = "unavailable"`; `cache_write_tokens`/`reasoning_tokens` recorded as `unavailable`, not `0`; `savings_claim: none` (I15) |
| M2-T19 | Partial usage (`input_tokens`/`output_tokens` only) | Missing cache fields stay `unavailable`; no inferred cache hit from `input_tokens` alone |
| M2-T20 | Unknown pricing with reported usage | `cost.confidence: low`, `amount: null`, non-empty `unknown_fields`; usage still recorded; **no** money value asserted or logged (I10) |
| M2-T21 | Two-turn cache-epoch sequence | Turn 1 (changed epoch) is charged cache-write/uncached; turn 2 (same epoch) may report cached tokens; assert the epoch/disposition flip and that `savings_claim` requires the turn-2 usage |

Every case also asserts: no credential variable is read, no traffic leaves
loopback, and the canonical history is append-only (I1). T17–T21 additionally
assert that no fixture, assertion, or recorded artifact contains a price,
currency code, or monetary total (I10).

## 5. Determinism and isolation

Fixtures are fixed JSON/SST byte strings; no wall-clock, random UUID, or map
ordering may influence an assertion. The mock binds loopback and an ephemeral
port; tests may run in parallel only if each test owns its server instance and
its own temp `CODEX_HOME`. Test provider config is injected with `-c` overrides
(`model_providers.<name>.base_url`, `wire_api`, `requires_openai_auth=false`,
`request_max_retries`, `stream_max_retries`, `stream_idle_timeout_ms` — the
`ModelProviderInfo` fields `[VERIFIED]` in the pinned revision), never by
editing user config.

## 6. Evidence capture

Per `agents/test-evidence.md`, from the exact worktree root:

1. Register one named target once the command is final, e.g.
   `{"op":"register","target":"m2-mock","definition":{"command":["deno","test","--allow-net=127.0.0.1","--allow-run=codex","--allow-read=.","--allow-write=$TMPDIR","tests/compact-on-demand"],"cwd":"."},"reason":"M2 mock Responses tests, pinned submodule <sha>"}`.
   The registered reason records the exact submodule revision.
2. Execute once in `capture` mode; return the `REPOSITORY_KEY/UUID` reference,
   host, worktree, source revision, outcome, and executed/cached status.
3. Use `fresh` only for a changed condition or new acceptance, with a reason.

Credential-free proof: run with a scrubbed environment (only `PATH`, `HOME`,
`TMPDIR`, `SYSTEMROOT` inherited). `[RE-VERIFY]` Deno `--env`/dotenv discovery can
read an ancestor `.env` from a nested worktree; verify the effective
credential-presence booleans before claiming credential-free execution, and
never overwrite or copy any existing dotenv file. The mock's sentinel-header
assertion is the positive proof that no real provider credential was used.

Direct minimal-permission runs are preferred over `deno run -A`
(`agents/deno.md`); the only `-A` exception in this repo is the evidence tool
itself.

## 7. Acceptance criteria for M2

| Id | Check |
| --- | --- |
| B1 | The registered command passes on a clean checkout of this worktree, credential-free. |
| B2 | The evidence reference records the exact submodule revision and the executed (not cached) outcome. |
| B3 | Every matrix row M2-T01…T21 has a named, executed test with its assertion visible in the test name or receipt. |
| B4 | No test contacts a non-loopback host and no test reads a real credential variable. |
| B5 | Canonical-history and no-replay assertions hold in all rows where they apply. |
| B6 | Failures preserve real child status (no normalized/renamed exit code). |
| B7 | Every §3.4 usage field is asserted in at least one row; absent/partial usage is recorded as `unavailable`, never as zero (I15). |
| B8 | Usage and estimates stay separate in the manifest; no test merges them or emits a derived monetary value (I10). |
| B9 | The unknown-pricing row (T20) records usage with `confidence: low` and `amount: null`, and never claims savings. |
| B10 | The cache-epoch row (T21) charges a changed epoch as cache-write/uncached and only allows cached tokens on an unchanged epoch (I13). |

## 8. Prohibited for M2

Real model calls (that is M3); real credentials; writing under `vendor/codex`
(I9); editing user `~/.codex` config; using the existing shipping proxy or the
live gateway as the mock; installing packages or adding a runtime dependency;
claiming credential-free execution without the sentinel-header assertion;
recording, hardcoding, or asserting any price/rate for any model (I10); treating
synthetic usage fixtures as evidence of real cache savings (I15); using
token-count totals as a pass/fail quality threshold.

## 9. Open questions

1. Build feasibility of the pinned Rust client on this host (plan open decision
   3). If it is not feasible within budget, the fallback client must be recorded
   explicitly with its version.
2. Test file location — `tests/compact-on-demand/**` is the natural path but is
   prohibited in M0 and must be granted in the M2 assignment.
3. Whether the M1 projection is exercised in-process (Rust unit test) or through
   the CLI; `CODEX_RS_SSE_FIXTURE` covers the parser but not the projection seam.
4. Whether the pinned revision's `usage` deserialization accepts
   `input_tokens_details`/`cache_write_tokens` at all. `[RE-VERIFY]` against
   `client_common.rs` before writing T17–T21; if the fields are dropped by the
   typed parser, the test records them as `unavailable` and asserts raw-body
   preservation instead of typed passthrough.
5. Where the usage ledger lives (mock-side JSON per test vs client-side manifest)
   so that M3 can reuse the same recorder without inventing a second schema.
