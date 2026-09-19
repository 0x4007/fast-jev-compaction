# Decisions

Small architecture record for the Codex Jev compaction adapter (`codex/`).
Scope: the Codex side only; the Claude Code plugin and the library keep their
existing behaviour.

## D1 — Local compaction is intercepted by a loopback Responses proxy

Codex 0.154.0 marks a local-compaction request with
`x-codex-turn-metadata: {"request_kind":"compaction","compaction":{"implementation":"responses"}}`.
The adapter is a Deno proxy on `127.0.0.1:8787` that matches **only** that
header combination for `POST /v1/responses` and forwards everything else
byte-transparently to `http://127.0.0.1:8000`. No prompt matching, no provider
rename, no binary fork, no gateway edit; an explicit compaction with another
implementation is forwarded and not claimed as handled.

Consequence: normal turns never touch Jev, streaming and status/auth fidelity
are preserved by construction, and the interception predicate cannot drift with
prompt text.

## D2 — Reuse the existing library, render text

The adapter maps Codex input items to the library's `Message` shape, runs
`compact()` with the library's own defaults, and renders the surviving
transcript as text. Kept content is verbatim; `drop_result` keeps the call with
its input plus a bounded head; `drop_call` removes the call and its paired
output. Unknown/opaque items and unmatched outputs are rendered as bounded
notices, never silently deleted, and encrypted blobs are not exposed as text.

Consequence: the memory is text, so structured tool-call replay is not restored
and the adapter says so in the summary and the header. `dist/` must be built
before running the adapter. Jev receives the conversation text and truncated
tool inputs, but no full tool output: each result is represented by a size note
(`ok, 4213 chars (omitted)`), and texts are abridged only when the state exceeds
its token budget.

## D3 — Failure is non-destructive, never a fabricated success

Every non-success path returns HTTP 400 and Codex keeps its original history:
malformed bodies, missing input, no candidates, Jev HTTP error, a Jev timeout,
malformed answers, no reduction, render failure, empty summary, or a summary
over the 400,000-character cap. Kept content is never truncated to force a
success, and no token usage is invented. The library validates every asked
question, so a partial or missing decision set throws instead of substituting an
answer.

The Jev HTTP call is bounded at 30 s by an adapter-owned fetch wrapper
(`createJevTimeoutFetch`) passed to `JevClient` through its existing `fetch`
option: one `AbortSignal` covers headers and response-body consumption, any
caller signal is preserved and forwarded, the timer and listeners are released
on every path, and transport failures carry a fixed non-secret message. The
wrapper is adapter-only: the passthrough fetch, `src/`, and the Claude plugin
are unchanged. A timeout is a `jev-failed` outcome, so it enters the proxy's
existing failure cache; an internal `jevTimeoutMs` option lets tests inject a
small bound without adding product configuration.

## D4 — Fixed product configuration, test-only injection

No new environment variables, secrets, or CLI flags. `startProxy` accepts
internal options (port, upstream origin, asker, fetch, Jev timeout, log) so the
acceptance test can use ephemeral loopback ports and a fake Jev; nothing in
those options is exposed as product configuration.

## D5 — Acceptance proves adoption, not proxy success

`codex/smoke.ts` drives the installed `codex app-server` under an isolated
`CODEX_HOME` with a fake upstream and fake Jev, then asserts that the *next*
provider request carries the summary Codex adopted, that kept content survived,
that dropped content and dropped tails are gone, and that a Jev outage leaves
the original history available. Assertions read the adopted summary window, not
fixture replay material, and the fake upstream answers verification turns
ordinarily so it cannot regenerate dropped content. Registered as `codex-e2e`;
it makes no real model or Jev call.

`codex/live-smoke.ts` is the separate live timing check: the primary runs it
with the existing key against one synthetic transcript and at most one real Jev
request, and it prints only JSON numeric metrics, structural counts, and a
PASS/failure class.

## D6 — Logs carry counts, not content

The proxy logs structural counts and fixed failure classifications only: no
transcript text, tool output, provider bodies, or credentials. Test diagnostics
follow the same rule and print synthetic markers or structural fields only.

## D7 — The installed proxy listens on the LAN (owner request 2026-09-18)

The product entrypoint binds `0.0.0.0:8787`; `startProxy` defaults remain
loopback. The gateway UI is reachable at `http://<mac-ip>:8787` from the local
network by explicit owner request. The gateway still applies its own
loopback-peer and Origin checks to forwarded requests, so behavior on the LAN
matches the existing proxy semantics. Run only on a trusted network.

## D8 — Same-origin Origin rewrite in passthrough (owner request 2026-09-18)

Browser clients reach the proxy on its own origin. The gateway grants local
trust only when `Origin` is absent or equals the origin it observes (the
loopback upstream); a phone at `http://<mac-ip>:8787` would otherwise get 401 on
every API call even though the UI page loads. The passthrough therefore rewrites
`Origin` to the upstream origin only when it exactly equals the proxy's own
request origin; absent and foreign origins are forwarded untouched and still
rejected upstream. Cross-site requests stay rejected.

## D9 — Compact-on-demand lives in an independent experimental client fork

The per-user-request working-set feature is developed in a separate fork worktree
of the Codex client (branch
`codex/completion-handoff-2026-09-18-m01-client-a788f68d68d`, base
`5c583fe89bbd3ab4dc9a05768299f94e52fe8452`), not in the shipping proxy, the
installed CLI, or an in-place `vendor/codex` edit. The parent repository owns the
pinned-client harness, tests, and docs; the `vendor/codex` gitlink advances only
after the fork tip is accepted and pushed.

The **implemented** selection manifest (schema version 2, kind
`compact-on-demand/selection-manifest`, append-only
`<rollout>.working-set.jsonl` sidecar, one selection per user request and one
turn record per upstream request) supersedes the M1 shadow-path manifest sketch:
selection is actually applied at the per-user-request boundary, and the recorded
seams in `docs/compact-on-demand/IMPLEMENTATION.md` are the description of
record. The older M0–M3 documents are kept as history with status pointers.

**Delivery status (2026-09-19).** The fork tip
`566761e77dbd44b6fd8fdb0be5c5a8e2b5306d04` is pushed to `origin`, and the
`vendor/codex` gitlink has been advanced to it. The parent branch
`codex/compact-on-demand-implementation` (`2bf5e68`) is pushed to `origin`. The
real pinned-client suite is green (10/10) with no test-only workaround; the
M3 live Luna inference re-check is externally blocked because the paid provider
that serves `gpt-5.6-luna` reports an exhausted wallet (HTTP 403
`local:insufficient_quota`), while `deepseek-flash` on the same endpoint returns
HTTP 200. That is an owner top-up action, not a code defect.

No product environment variable, secret, CLI flag, or config knob is added; the
installed CLI, the shipping `codex/` proxy, and host configuration are
unchanged.

