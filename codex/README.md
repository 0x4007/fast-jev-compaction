# Codex adapter (local compaction through Jev)

A loopback Responses proxy that answers Codex's **local** compaction request with
a text memory rendered from the library's Jev decisions, and forwards every
other request unchanged. Architecture decisions: [`../DECISIONS.md`](../DECISIONS.md).

## Start

```sh
npm run build   # codex/ imports the built dist/ output
deno run --allow-net=0.0.0.0:8787,127.0.0.1,api.typesafe.ai --allow-env=TYPESAFE_API_KEY codex/jev-compaction-proxy.ts
```

Product defaults are fixed: bind `0.0.0.0:8787`, upstream
`http://127.0.0.1:8000`, Jev key `TYPESAFE_API_KEY`. The network allowlist must
cover both the loopback upstream and the TypeSafe endpoint
(`https://api.typesafe.ai/v1/systemone`); `TYPESAFE_API_KEY` is the only
environment variable any imported code reads, so the env allowlist stays at
that one name. There are no new environment variables, CLI flags, or secrets.
Point the Codex provider at the proxy while leaving the real gateway upstream:

```toml
[model_providers.local]
name = "local"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
```

`GET /healthz` answers a plain status line (never a JSON `ok` body).

## Boundary

Interception is header-only: `POST /v1/responses` whose `x-codex-turn-metadata`
has `"request_kind":"compaction"` **and** `"compaction":{"implementation":
"responses"}`. No prompt or body matching, so ordinary turns never reach Jev.

- Ordinary requests are forwarded byte-for-byte (method, query, status, auth,
  streaming) to `http://127.0.0.1:8000`.
- An explicit compaction with another implementation (or malformed/absent
  metadata) is forwarded untouched and never claimed as handled.
- Codex's injected compaction prompt is excluded from the Jev state; earlier
  real user content is not.

## Privacy

A compaction request sends the conversation text and truncated tool inputs to
the TypeSafe Jev endpoint using the existing key. Tool results are **not**
uploaded: each one is replaced in the Jev state by a size note (`ok, 4213 chars
(omitted)`), and long texts are abridged only when the state exceeds its token
budget. The proxy logs only structural counts (`items`, `kept`,
`results_dropped`, `calls_dropped`, `chars_*`) and fixed failure
classifications; never transcript text, tool output, provider bodies, or keys.
The incoming `Authorization` header is not forwarded to Jev, which uses its own
key only.

## Non-destructive failure

Every failure returns an explicit non-success (HTTP 400) instead of installing a
memory, so Codex keeps its original history:

- unreadable/unparsable body, missing input, empty transcript;
- no unpinned tool-call/result pairs to decide (no Jev request is made);
- Jev HTTP error, a 30 s timeout, or malformed/missing answers;
- nothing dropped (no reduction), render failure, or an empty summary;
- summary over the 400,000-character cap: it fails rather than truncating
  Jev-kept content silently.

A failed attempt is remembered briefly (4 entries, 120 s) so identical input
cannot pay for the same failure repeatedly; a Jev timeout is a failure like any
other and is cached the same way.

## Text-summary fidelity

The memory is text: kept messages and kept tool results stay verbatim, a
`drop_result` keeps the call with its input and a bounded head of the result,
and a `drop_call` removes the call and its paired output. Structured tool-call
replay and opaque/encrypted items (encrypted reasoning, compaction payloads) are
represented as bounded notices, not restored; unmatched calls or outputs are
rendered safely rather than deleted.

## Acceptance

```sh
deno run --allow-read --allow-write --allow-env --allow-net=127.0.0.1 \
  --allow-run=/Users/nv/.codex/bin/codex codex/smoke.ts
```

`codex/smoke.ts` runs entirely on loopback with a fake upstream, a fake Jev, and
an isolated `CODEX_HOME`: no credentials, real models, or Jev calls. It drives
the installed `codex app-server` (`thread/start`, `turn/start`,
`thread/compact/start`, then a verification turn) and asserts that Codex adopted
the Jev summary, that the kept result survived, that dropped content is gone,
and that a Jev outage leaves the original history intact.

`codex/live-smoke.ts` is the live timing check, run by the primary only with the
existing key: one loopback proxy, a fake upstream that must see zero requests,
one synthetic transcript with three obsolete tool pairs, and at most one real
Jev request (30 s bound, 45 s whole-smoke bound, no retries). It prints one JSON
object with `jev_request_ms`, `total_compaction_ms`, `request_count`, input and
summary sizes, the reduction ratio, dropped/kept counts, the structural header,
and a PASS/failure class.

```sh
deno run --allow-env=TYPESAFE_API_KEY --allow-net=127.0.0.1,api.typesafe.ai \
  codex/live-smoke.ts
```

## Rollback

Stop the proxy and point the provider `base_url` back at the real gateway (or
remove the provider block). The adapter keeps no on-disk state and modifies no
Codex or host configuration; a compaction only takes effect while the proxy
answers successfully, so reverting the provider restores Codex's own behaviour.

## Limitations

- The summary replaces structured tool-call replay with text; a resumed session
  can re-run a tool but cannot reconstruct exact call items.
- Token accounting is the library's estimate; Codex's own usage numbers are not
  invented.

## Testing the installed proxy

`codex/test-cli.ts` exercises the **installed** proxy at
`http://127.0.0.1:8787` end to end: it sends exactly one header-marked
compaction request (`x-codex-turn-metadata` with
`{"request_kind":"compaction","compaction":{"implementation":"responses"}}`),
parses the SSE summary, and reports timings, sizes, the reduction ratio, the
structural counts from the `x-fast-jev-compaction` header, and a clear PASS/FAIL
line. The synthetic fixture transcript carries three obsolete tool pairs and one
goal marker; the run passes only when the summary keeps the goal marker, drops
all three obsolete markers, and the response carries the structural header.

```sh
deno run --allow-net=127.0.0.1 codex/test-cli.ts
deno run --allow-net=127.0.0.1 --allow-read="$HOME/.codex/sessions" codex/test-cli.ts --rollout latest
deno run --allow-net=127.0.0.1 --allow-read="$HOME/.codex/sessions" codex/test-cli.ts --rollout latest --send
```

`--send` is rollout-only; without it the run is a strict dry run that prints the
extracted item counts, sizes, matched tool pairs, and a bounded excerpt, and
makes no network or Jev call. Privacy boundary: `--send` sends the extracted
transcript to the TypeSafe endpoint through the installed proxy; the dry run
sends nothing. The CLI never reads the API key and never prints a request
payload body; `--json` prints one object instead of the human report, and the
exit code is 0 on pass, 1 on fail or error.
