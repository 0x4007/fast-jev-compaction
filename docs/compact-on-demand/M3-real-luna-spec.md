# M3 — Real-model smoke test (specification)

Filename note: the historical name `M3-real-luna-spec.md` is retained for
continuity and is accurate: "luna" is the objective's target slug `gpt-5.6-luna`,
not an artifact and not a codename. The name is not renamed as part of this
correction.

Status: `[PROPOSED]`; no real model call is made in M0. Date: 2026-09-18.
Revision: 2026-09-18a adds provider-usage telemetry and the
no-billing-inference caveat (§7) per M0 §4.7. Revision: 2026-09-18b restored the
objective — M3 runs a real request — under a live-catalog gate (§2.1), but it
described that gate as resolving the target's slug from a catalog entry.
Revision: 2026-09-18c superseded the 2026-09-18b wording. Revision: 2026-09-18d
superseded 2026-09-18b/2026-09-18c: it removed the catalog-resolution framing and
the informal-alias text, but it also *mis-retargeted* the milestone — it carried
the slug `gpt-6-astra` from unrelated context-window work and made that the
target. Revision: 2026-09-18e supersedes 2026-09-18d and is the text of record:
the target is the exact provider slug `gpt-5.6-luna`, reasoning `none` first with
`low` as the only fallback, with no catalog-derived aliasing, no codename
reinterpretation, and no substitution of another model; the pre-inference
metadata query is a prerequisite gate for that exact slug, not a resolver of the
target.
Invariants I1–I15 in [`M0-spec.md`](M0-spec.md) are binding.

## 1. Goal

One or two tiny real requests against the existing UOS provider, using the
client under test, to confirm that the working-set path (or the unchanged client
in shadow mode) works end to end against a real endpoint: request accepted,
response parsed, **provider-reported usage captured**, no secrets leaked. It is
a smoke test against that exact slug only, not a quality benchmark and not a
billing measurement.

## 2. Target model and reasoning

Target (the user's authoritative objective):

**Authoritative objective (the sole target of record):** M3 runs the real
**gpt 5.6 Luna** target with reasoning **`none` first**, falling back to **`low`**
only if `none` is rejected by that same target. The objective's exact target is
the literal slug `gpt-5.6-luna`; M3 sends it verbatim. It is not re-derived from the
catalog, not aliased, and not substituted by any other model. Before inference, M3
queries the live provider metadata once and requires the **exact slug
`gpt-5.6-luna` to be present**; if it is absent, M3 stops **`BLOCKED`** with zero
inference requests and requires a user decision. This milestone changes no element
of the objective.

- Model: **exactly `gpt-5.6-luna`** — the literal provider slug, sent verbatim.
  It is not a catalog-derived alias, not resolved from any other catalog entry at
  run time, and not another model. A single pre-inference metadata query (§2.1)
  confirms its exact presence; it never selects or renames the target. Absent from
  the metadata ⇒ `BLOCKED` before inference. In any role or fallback, the only slug
  M3 ever sends is `gpt-5.6-luna`.
- Reasoning: **`none` first**; if the provider rejects or does not support
  `none`, fall back to **`low`** and record both attempts. No other level is
  used, and `medium` must not be inherited from the user's config.
- `[VERIFIED]` The user's live config selects a different model (`gpt-6-astra`,
  retained for unrelated context-window/session work) with
  `model_reasoning_effort = "medium"`. That selection is **not** M3's target and
  must not leak into M3. M3 must override both the model slug (`gpt-5.6-luna`)
  and the effort (`none`) explicitly, and prove the effective values from the
  request/telemetry rather than assume any config default. The overrides are
  required either way.
- `[VERIFIED 2026-09-17]` The user's saved research records that the local
  catalog lists reasoning levels `none, low, medium, high, xhigh, max`. That is a
  catalog claim about a level list, not a serving guarantee and not a statement
  about which model is the target; M3 must confirm `none` is accepted on the wire
  for `gpt-5.6-luna` before treating it as used.

`[DISCREPANCY — corrected 2026-09-18e]` Earlier drafts incorrectly carried the
slug `gpt-6-astra` into this spec from unrelated context-window work and made it
the target, at one point even framing the objective's "Luna" name as a codename
error. That was the drafting error, not the filename. The authoritative objective
("run unit tests against real gpt 5.6 Luna `none` (or low) reasoning") and the
live provider metadata both resolve M3 to the exact slug `gpt-5.6-luna`; the
objective text "gpt 5.6 Luna" is read as that literal catalog slug and nothing
else. No informal model name in any objective text is treated as the slug's
codename, alias, or substitute, and `gpt-6-astra` is not M3's target.
`[VERIFIED 2026-09-18, live]` the configured provider's `GET /v1/models`
(HTTP 200) currently returns `gpt-5.6-luna` and `gpt-6-astra` as two distinct
slugs, which is why the §2.1 gate is an exact-string presence check: the two
must never be merged.

### 2.1 Pre-inference exact-slug gate on live provider metadata

The target is fixed before the run: the exact provider slug **`gpt-5.6-luna`**. What
§2.1 adds is a single live confirmation that the configured provider still serves
that exact slug. The gate confirms presence; it never resolves, selects, renames,
or reinterprets the target, and it is not a slug-discovery step.

The gate must happen **immediately before M3** — before any inference request, in
the same run:

- The query is exactly one provider-metadata `GET /v1/models` against the
  configured provider, and its result and timestamp are recorded as-is.
- The gate is **exact-slug presence**: the returned slug list must contain the
  string `gpt-5.6-luna` verbatim (exact string match; no case folding, no prefix
  or alias matching, no "closest" entry).
- If the metadata response does not contain the exact slug `gpt-5.6-luna`, M3 stops
  **before inference** and reports **`BLOCKED`**, naming the required exact slug
  (`gpt-5.6-luna`) and the metadata result, with **zero inference requests**, and
  requires an explicit user decision before any further attempt. No
  substitution: not an alias, not a catalog-derived entry, not a different
  casing, not another slug, not another provider.
- If the metadata does contain the exact slug `gpt-5.6-luna`, M3 proceeds with
  `gpt-5.6-luna` and §5's mechanism.
- Zero inference requests occur before this gate returns. A `BLOCKED` gate is a
  terminal outcome for the run, not a prompt to search for an equivalent model.

Two independently recorded catalog facts remain in tension and are not merged:

- `[VERIFIED 2026-09-17]` a saved probe of the live gateway
  (`GET http://127.0.0.1:8000/v1/models`, HTTP 200) listed seven slugs, and it is
  consistent with the `[VERIFIED 2026-09-18, live]` result above in showing
  `gpt-5.6-luna` and `gpt-6-astra` as distinct entries.
- `[VERIFIED 2026-09-18, assignment]` the M0 assignment states the current
  provider catalog only exposes `gpt-6-astra`. That statement is a stale
  single-slug claim about the catalog; it is not the objective and does not
  retarget M3.

Either record may be stale by the time M3 runs, which is exactly why the
immediate pre-run metadata query is normative and why the absence of the exact
slug is a `BLOCKED` outcome rather than a guess. Absent or renamed slugs are never
inferred, never "best guessed", and never supplied from a saved probe or another
model's name.

## 3. Authentication

- Existing variable name only: **`UOS_AI_TOKEN`**, read in-process by the
  existing provider auth command (`/bin/bash -lc printf '%s' "$UOS_AI_TOKEN"`;
  provider `uos`, `base_url = "http://127.0.0.1:8000/v1"`,
  `wire_api = "responses"`, `requires_openai_auth = false`) — `[VERIFIED]` from
  the saved configuration research.
- No new variables, flags, files, or secrets. The token is never printed, never
  passed in argv, never written to a worktree or `.env`, and never included in
  evidence. Only a credential-presence boolean may be reported.
- Any missing-credential precondition is reported by variable *name*, and the
  test fails rather than substituting another provider or credential. A
  `BLOCKED` outcome from the §2.1 exact-slug gate is likewise reported as
  `BLOCKED` and is not a credential failure.

## 4. Prompts

Synthetic only. Fixed literal strings authored for the test; no repository
content, no session history, no user text, no tool output, no personal data.
Each prompt is short (`≤ 64` words) and self-contained, e.g. `Reply with the
single word ok.` Prompts may be recorded verbatim because they are synthetic;
telemetry and evidence reasons use digests.

## 5. Mechanism `[RE-VERIFY before running]`

Preferred: the client under test driven by its own CLI, with the provider
inherited from existing config and only model/effort overridden. The model slug
below is the literal target `gpt-5.6-luna`, which §2.1's exact-slug gate must have
confirmed as present in the live provider metadata before this command runs:

```sh
codex exec --skip-git-repo-check -C "$TMPDIR/<run>" --json \
  -c 'model="gpt-5.6-luna"' \
  -c 'model_reasoning_effort="none"' \
  "Reply with the single word ok."
```

- `[RE-VERIFY]` Confirm the `-c key="value"` syntax and the effort level name
  against the pinned revision's config loader (`codex-rs/core/src/config.rs`)
  and a no-inference `--help`/config preflight before spending a request.
- `[RE-VERIFY before running]` Run the §2.1 metadata query **immediately before**
  the first inference request, in the same run, and record its result and
  timestamp. The target is already fixed as `gpt-5.6-luna`; the gate only confirms
  it: exact slug absent ⇒ `BLOCKED`, zero inference requests; present ⇒ the
  request above may be composed, still with `gpt-5.6-luna` as the only slug sent.
- Record the client provenance: binary path, version, and whether it was built
  from the pin `5c583fe89bbd3ab4dc9a05768299f94e52fe8452` or is the installed
  client (a version gap must be stated, not hidden).
- Alternative: a focused submodule test binary. Same budgets, same redaction,
  and it must not add provider configuration that the existing config lacks.
- Do not use `--model` model-selection tricks beyond the documented override;
  do not silently substitute a provider or model if the target is unavailable —
  report the exact blocker (harness policy). Only the slug `gpt-5.6-luna` may
  appear in the request of this run; catalog aliases and every other slug must
  never be sent, in any role, attempt, or fallback.

## 6. Budgets

| Bound | Value |
| --- | --- |
| Inference requests, total | ≤ 2 (attempt 1 `none`; attempt 2 `low` only if `none` is rejected) |
| Metadata requests | 1 (`GET /v1/models`, the §2.1 exact-slug gate — not an inference request) |
| Retries | 0 (`request_max_retries = 0`, `stream_max_retries = 0` for the test run) |
| Wall clock per request | ≤ 120 s, then stop the exact process and FAIL |
| Prompt length | ≤ 64 words, synthetic literal |
| Hosts contacted | The configured provider only (loopback unless policy says otherwise) |
| History sent | None: synthetic prompt only, fresh temp `CODEX_HOME`/`-C` dir |

## 7. Provider-reported usage and cost confidence

M3 is the first milestone with real usage, so it must record it — and must not
turn it into money.

### 7.1 Usage capture (after each request)

| Field | Handling |
| --- | --- |
| `input_tokens`, `output_tokens`, `total_tokens` | Recorded raw as reported. |
| `cached_tokens` (`input_tokens_details` or equivalent) | Recorded if exposed; `unavailable` otherwise — never inferred from `input_tokens`. |
| `cache_write_tokens` | Recorded only if the provider exposes it; `unavailable` otherwise. |
| `reasoning_tokens` (`output_tokens_details` or equivalent) | Recorded if exposed; noted as included in `output_tokens` only when the provider says so. |
| Response/model metadata | Response id, served model slug, status, effective reasoning effort. |

Rules: the field names above are the *expected* names, not a guarantee — a
provider that omits them yields `unavailable` (I15), and an absent field is never
zero. Estimates from the M1 manifest are recorded in a separate `estimated`
block; the two are never merged. The mock proves the same field set in M2 §3.4.

### 7.2 No billing inference `[VERIFIED 2026-09-18]`

The UOS provider's model metadata currently may not expose price fields, and this
worktree records no price for `gpt-5.6-luna` or any other UOS slug. Therefore:

- M3 records usage and **must not** convert it to money, apply a rate, or report
  a savings/dollar figure for `gpt-5.6-luna` (I10/I15).
- The M1 cost block for this run is expected to be `confidence: low` with
  `amount: null` and a non-empty `unknown_fields`. That is the *correct* result,
  not a failure; it is recorded as `pricing_unknown`.
- Any temptation to fill the gap with another provider's rate is prohibited.
- If a future catalog record with a real `price_source` exists before M3 runs,
  the estimate may be computed and labeled an estimate — but observed savings
  still require the usage fields above.

## 8. Redaction and capture

Allowlisted observed fields: timestamp, model, effective reasoning effort, HTTP
status, response id, the §7.1 usage fields and their `unavailable` markers, the
§2.1 catalog query result and timestamp, the exact-slug gate outcome, the target
slug `gpt-5.6-luna`, the absent-slug `BLOCKED` report when the run is `BLOCKED`,
selection manifest digest and selected/omitted counts, cost `confidence` /
`catalog_version` / `unknown_fields` (no monetary value for `gpt-5.6-luna`),
canonical-history digest before/after, client binary path/version, submodule
revision, duration, `PASS`/`FAIL`/`BLOCKED`, and the credential-presence boolean.

Never captured: `Authorization` headers, the token value, the full environment,
raw provider error bodies beyond a bounded safe excerpt, real user history, or
any unrelated user data. Session logs are not dumped; if a session log must be
inspected, follow the harness rule of one selected file with redaction.

## 9. Acceptance criteria for M3

| Id | Check |
| --- | --- |
| C1 | Explicit `PASS`/`FAIL` with a non-zero exit status on `FAIL`; a `BLOCKED` outcome (C13) is reported as `BLOCKED` with a non-zero exit status, never softened into `PASS` or `FAIL`. |
| C2 | The model actually used and the reasoning actually used are recorded; the run targets exactly `gpt-5.6-luna`, reasoning `none` first with `low` only if `none` was rejected, and both attempts are recorded when the fallback occurs. |
| C3 | Usage/schema telemetry captured, including the selection manifest digest and selected/omitted counts when the M1 shadow path is present. |
| C4 | Canonical history digest is unchanged by the smoke run (I1). |
| C5 | A redaction check over the captured artifacts finds no token, no `Authorization` value, and no non-synthetic content. |
| C6 | At most two inference requests and one metadata request were made; no retries occurred. |
| C7 | Evidence reference returned (host tool, registered target, mode, reason, revision, outcome, cached/executed status). |
| C8 | The recorded `/v1/models` result and the exact-slug presence check are the only model-selection evidence; the catalog contained `gpt-5.6-luna` verbatim, the slug sent was exactly `gpt-5.6-luna`, no alias or catalog-derived slug was used, and every other catalog slug is recorded as-is without being treated as a target. |
| C9 | Each request's provider usage is recorded as reported (or `unavailable` per field), separate from the estimate; `total_tokens` is accounted for as provider-reported, not derived. |
| C10 | No monetary value, rate, or savings claim is emitted for `gpt-5.6-luna`; the cost block records `confidence: low` + `unknown_fields` (or, if a real price source exists, an explicitly labeled estimate). |
| C11 | The run makes no cache-savings claim; `savings_claim` is `none` unless the captured usage proves cached tokens on an unchanged epoch (I13/I15). |
| C12 | `/v1/models` metadata is recorded as-is, including the absence of price fields; no inferred price is written anywhere. |
| C13 | The §2.1 catalog query ran immediately before the first inference request in the same run, is recorded with its timestamp, and required the exact slug `gpt-5.6-luna` to be present verbatim. If present, the run sent exactly `gpt-5.6-luna` and C2 binds. If the exact slug was absent, the run reports `BLOCKED` naming `gpt-5.6-luna` and the catalog result, with **zero** inference requests, **zero** substitutions, and a required user decision. |

## 10. Prohibited for M3

Real private history or tool output in prompts; token in argv/logs/evidence; new
credential variables or files; editing `~/.codex` config or host services;
switching provider or model silently; sending any model other than
`gpt-5.6-luna` in M3 in any role, including as a fallback or substitution;
treating a catalog-derived slug as the target or reinterpreting any informal
model name as a codename for another model; making an inference request before the
§2.1 exact-slug gate confirms `gpt-5.6-luna` is present, or continuing past its
absence instead of reporting `BLOCKED`; more than the budgeted requests;
treating a provider or model catalog discrepancy as license to guess a slug;
claiming quality results from a two-request smoke test; inventing a price or
rate for `gpt-5.6-luna`/UOS or converting usage into a monetary/savings figure
(I10/I15); asserting a cache hit without the provider's cached-token field.

## 11. Policy note (flag, do not resolve silently)

`agents/deepseek-harness.md` is reported to designate `gpt-6-astra` for planning
and orchestration, while execution legwork runs on `deepseek-flash`. That file is
not present in this worktree, so this note is a flag, not a verified claim; the
report does not change M3's target. M3's **system under test** is the real
provider slug `gpt-5.6-luna`, which the authoritative objective fixes. The
planning model and the M3 target are not to be conflated
with any informal objective wording (§2 discrepancy note): the target of record
is the literal slug `gpt-5.6-luna`, and §2.1's exact-slug gate exists precisely
because that slug must be present in the verified live metadata before inference.
The gate is a presence check only: it does not resolve, rename, or reinterpret
the target, and no informal model name in any objective text is treated as a
codename for that model or for any other. The M3 worker must not select,
substitute, or invent models on its own, and real model calls require explicit
authorization at M3 time — M0 makes none.
