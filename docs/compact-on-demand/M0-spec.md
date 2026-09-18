# M0 — Specs, source pin, and cost policy

Module: `m00-spec-submodule`. Date: 2026-09-18. Status: M0 delivered; M1–M3 are
specified here but not implemented. Revision: 2026-09-18 adds the normative
model-aware cost policy (§4) and invariants I10–I15.

Labels used throughout `docs/compact-on-demand/`:

- `[VERIFIED]` — checked directly against the pinned source, this worktree, or a
  saved research artifact with a stated timestamp.
- `[PROPOSED]` — a design the M1–M3 implementer must follow or explicitly reject.
- `[RE-VERIFY]` — a fact that was true when recorded but must be re-checked
  before the milestone that depends on it.
- `[DISCREPANCY]` — conflicting facts that must not be silently reconciled.

## 1. Goal

Fork/adapt the Codex client so that **each user request can build a selective
working set from an append-only canonical history without targeting a fixed
token count**, then test that change against a mock Responses server (M2) and a
bounded real `gpt-5.6-luna` request at reasoning `none` first, falling back to
`low` only if `none` is rejected (the real-model objective).

Note: the real-model objective and M3's target are the exact provider slug
`gpt-5.6-luna`, with the `low` fallback only if `none` is rejected
(`M3-real-luna-spec.md`). `gpt-6-astra` is the unrelated context-window model and
is **not** M3. The two slugs are distinct live catalog entries.

M0 itself changes no product behavior. It fixes the source pin, the invariants
shared by M1–M3, the ownership boundaries, and the acceptance surface.

## 2. Source pin

`[VERIFIED]` in this worktree on 2026-09-18 (`git cat-file`, `git log`,
`git rev-parse origin/main` in `/Users/nv/repos/0x4007/codex`):

| Field | Value |
| --- | --- |
| Source repository | `https://github.com/0x4007/codex.git` (fork of `openai/codex`) |
| Local checkout used as the reference | `/Users/nv/repos/0x4007/codex` (clean) |
| Pinned commit (full) | `5c583fe89bbd3ab4dc9a05768299f94e52fe8452` |
| Commit subject / date | `feat: tweak onboarding strings (#3650)`, 2025-09-15 08:49:37 -0700 |
| Fork branch containing the pin | `origin/main` of the fork (local ref equals the pin) |
| `git describe` | `codex-rs-2925136536b06a324551627468d17e959afa18d4-1-rust-v0.2.0-alpha.2-774-g5c583fe89b` |
| Submodule path | `vendor/codex` |
| Submodule URL recorded in `.gitmodules` | `https://github.com/0x4007/codex.git` |
| Verification repo base (this repo) | `c1eab5fdbd6bde7d67f2da070116496558836884` (`main`) |
| Module worktree / branch | `.codex-worktrees/compact-on-demand-implementation` / `codex/compact-on-demand-implementation` |

Rule: **`vendor/codex` is read-only in every milestone.** Files under it are
never edited in place. A pin change is a deliberate event: update the gitlink,
update this table, update `.gitmodules` only if the URL changes, and record the
new SHA in the handback. The pinned revision is the only authoritative source of
symbol names in these specs; line numbers are from that revision.

### 2.1 `[DISCREPANCY]` D-1 — the assignment's source SHA does not exist

The M0 assignment states the source checkout is "clean at
`5c583fe89bde7d67f2da070116496558836884`". That string is **38 characters** (not
a valid 40-hex object name), and `git cat-file -t
5c583fe89bde7d67f2da070116496558836884` fails with `Not a valid object name`.
It is a splice of the real prefix `5c583fe89b` with the tail of this repo's base
SHA `c1eab5fdbd6bde7d67f2da070116496558836884`.

Resolution used here: the pin is the **actual clean checkout HEAD**,
`5c583fe89bbd3ab4dc9a05768299f94e52fe8452`, which is also `origin/main` of the
fork and matches the plan's own `5c583fe` short form. The nonexistent 38-char
string must never be written into a gitlink, doc, or config. If a future
reviewer believes a different commit was intended, that is a new decision and
requires a pin bump, not an edit.

## 3. Invariants (binding on M1–M3)

- **I1 — Append-only canonical log.** The canonical history (the recorded
  rollout / conversation items) is append-only. A working set is a *derived
  view* for one request; it is never written back as a replacement history.
- **I2 — Per-user-request selection, no token target.** A projection is computed
  once per user request. Token counts are accounting inputs only: never a
  relevance target, selection predicate, sort key, threshold, or arbitrary cap.
  Cost estimation (§4) must not reintroduce a token budget in disguise.
- **I3 — Active tool chain is never split.** The in-flight call/result chain of
  the current request is always present, whole.
- **I4 — No replay.** Historical tool calls and results are context only. No
  tool call is ever re-dispatched from history.
- **I5 — Deterministic selection.** Same canonical log + same request ⇒
  byte-identical projection and manifest (no clocks, random UUIDs, or map-order
  dependence).
- **I6 — Non-destructive fallback.** Any selection failure produces the
  canonical full-history request (native behavior) plus a recorded reason. Never
  a partial, truncated, or fabricated projection.
- **I7 — No secrets in artifacts.** Logs, manifests, telemetry, and evidence
  never contain tokens, `Authorization` headers, or private session content.
- **I8 — Mock phase is credential-free; real phase is bounded and synthetic.**
  M2 runs without provider credentials. M3 uses only existing variable names and
  synthetic prompts.
- **I9 — Pinned source is immutable.** See §2.
- **I10 — No invented prices.** A rate that is not present in the recorded,
  versioned catalog (§4.1) is `unknown`. It is never guessed, derived from
  another provider, or copied from a "similar" model. `gpt-6-astra` and the
  custom UOS provider have no price source recorded in this worktree; they must
  be treated as `unknown` until a real source is recorded.
- **I11 — Accounting never becomes relevance.** Cost appears only after the
  candidate set already satisfies relevance, closure (I3/C6), and task-coverage
  requirements. A cost estimate never adds or removes an item that relevance
  rules require or forbid.
- **I12 — Cost confidence is explicit.** Every costed decision records the
  catalog version, freshness, and a confidence level. Unknown or stale price or
  cache-eligibility data forces low confidence plus shadow/fallback behavior —
  never optimistic savings.
- **I13 — Cache reuse is honest.** Cache savings are claimed only when the
  request has a stable prefix within the recorded manifest epoch and matching
  provider usage evidence exists. A fresh or changed prefix is charged as
  cache-write or uncached, not cached.
- **I14 — Jev cost is internalized.** Jev/retrieval has its own expected cost and
  latency and must be included in the candidate comparison. Jev is avoided when
  deterministic retrieval (M1 C7) already suffices.
- **I15 — Usage evidence over estimates.** Cost-savings claims require
  provider-reported usage fields (§4.7). Estimates are labeled as estimates and
  are never reported as measured savings — including in M2/M3 artifacts.

## 4. Normative model-aware cost policy `[PROPOSED]`

Selection is **not token-count driven and has no fixed target** (not 50K, not any
other number). Cost estimation is a first-class part of selection, but it is a
*suffix* policy: relevance/coverage rules form the candidate set, and cost ranks
candidates that already satisfy them. The unit of comparison is money over a
request horizon, not tokens.

### 4.1 Versioned pricing catalog record

One record per (provider, model). Strict JSON, `additionalProperties: false`,
canonical JSON digest. A record is immutable once written; a refresh appends a
new version. It is never edited in place to make a result look good.

```jsonc
{
  "schema_version": 1,
  "kind": "compact-on-demand/pricing-catalog",
  "catalog_version": "2026-09-18.1",
  "model": "…",                  // exact wire slug; never an alias of convenience
  "provider": "…",
  "price_source": "…",           // URL/path + revision, or null
  "fetched_at": "…",             // ISO-8601 UTC of retrieval; null if never fetched
  "currency": "USD",             // null when unknown
  "unit": "per_1m_tokens",       // null when unknown
  "uncached_input_rate": null,   // number | null
  "cached_input_rate": null,
  "cache_write_rate": null,      // null when provider has no such line item
  "output_rate": null,           // reasoning billed as output ⇒ included here
  "reasoning_in_output": null,   // true | false | null
  "min_cacheable_prefix_tokens": null,
  "cache_eligibility": { "rules": [], "confidence": "low" },
  "long_context_multipliers": [],  // [{ "threshold_tokens": N, "multiplier": M, "applies_to": [...] }]
  "unknown_fields": ["…"]        // names of fields above that are unknown
}
```

- `null` means **unknown**, not zero and not free (I10).
- The catalog is data read at runtime; this spec records no concrete price for
  any model, and M1–M3 must not invent one. Test-only synthetic rate tables are
  permitted for fixtures but must be explicitly labeled synthetic and must never
  be applied to `gpt-6-astra` or the UOS provider (I10).
- `[RE-VERIFY]` Before any milestone that consumes a record, re-check its
  `price_source` and `fetched_at`; a stale record degrades confidence (§4.4).

### 4.2 Expected cost

For a candidate working set `c` on model `m` over horizon `h`:

```text
expected_cost(c, m, h) =
    uncached_input_tokens(c, h) * rate(uncached_input_rate)
  + cached_input_tokens(c, h)   * rate(cached_input_rate)
  + cache_write_tokens(c, h)    * rate(cache_write_rate)
  + expected_output_tokens(c, h)* rate(output_rate)        # reasoning included iff billed as output
  + long_context_surcharge(c, m)                            # multipliers above threshold
  + retrieval_cost(c, m, h)                                 # deterministic retrieval
  + jev_cost(c, m, h)                                       # model + tokens + latency
```

Data contract:

| Field | Type | Rule |
| --- | --- | --- |
| Inputs | token count estimates per class, reuse probability `p` over `h`, catalog version | Estimates use the same deterministic plan as the manifest; no clock/random input (I5). |
| `h` | `H1` (next request) or `H2(k)` (next `k` requests) | Reuse probability amortizes cache writes across expected reuse. |
| `jev_cost` | own model rate, its own input/output tokens, retry cost, latency penalty | Zero only when deterministic retrieval suffices (I14). |
| Output | `{ currency, unit, amount, confidence, catalog_version, breakdown }` | `amount: null` when any required rate is unknown; never a partial number. |
| `confidence` | `high` \| `medium` \| `low` | §4.4. |

A **no-selection baseline** `baseline(m, h)` is the canonical full-history
request with the same equation and the same catalog. Every candidate is compared
against that baseline, not against another candidate's token count.

### 4.3 Decision rule

Rank candidates that already satisfy relevance, coverage, closure, and pinning by
`net = task_coverage − expected_cost`. Coverage is a first-class term, so a
cheaper candidate that drops required context loses. Then:

- Choose the candidate with the best net expected cost **and** adequate coverage.
- A token-count ordering is never a substitute for this comparison: a large
  mostly-cached stable prefix can be cheaper than a tiny uncached request
  (§4.6b), so the policy must not default to maximum compression.
- Jev is used only when its `jev_cost` plus its decision quality beats
  deterministic retrieval (I14).

### 4.4 Cost confidence and safe behavior

| Confidence | Condition | Permitted behavior |
| --- | --- | --- |
| `high` | Rates present, source recorded, `fetched_at` fresh, cache eligibility known, epoch stable | Cost may inform selection. |
| `medium` | Rates present but stale or cache eligibility partial | Shadow only: compute and record the estimate; do not change the sent request. |
| `low` | Any required rate unknown, or cache behavior unknown, or baseline incomparable | No cost-driven selection. Record `amount: null` + `unknown_fields`, keep canonical-history behavior, and treat the estimate as non-authoritative. |

Absence of a price is normal (provider metadata may omit prices). It is never a
reason to guess (I10) and never a reason to claim savings (I15).

### 4.5 Cache-stable prefixes and manifest epochs

- Selection preserves a stable prefix (instructions, tools, pinned/stable
  history) so successive requests land in the same provider cache.
- A **manifest epoch** is identified by the digest of (model, instructions,
  tools, stable-prefix digest, catalog version, reasoning settings). Any change
  starts a new epoch.
- In a new epoch, the first request is charged cache-write-or-uncached, never
  cached. `projected_cached_tokens > 0` with a changed epoch is a spec violation
  (I13).
- The manifest records `epoch_id` and `cache_disposition` so reuse claims are
  auditable.

### 4.6 Acceptance fixtures (structural, no invented prices)

Fixtures assert the *decision structure* using synthetic labeled rates and
example token volumes, so they fail if a token count is used as the ranking key.
Volumes are illustrative structure, not targets, and never hints for selection.

| Fixture | Shape | Expected decision |
| --- | --- | --- |
| (a) large stable mostly-cached | Long unchanged prefix, epoch stable, high cache rate evidence | Cheaper than baseline at `H2(k)`; selected despite high token count |
| (b) tiny uncached | Few hundred new tokens, no cache reuse, low `p` | May be *more* expensive than (a); must not win merely by being small |
| (c) medium with cache write | New stable prefix, cache write amortized over `H2(k)` | Wins only when `p` makes amortization favorable; otherwise baseline/shadow |
| (d) unknown pricing | Catalog rates `null` | `confidence: low`, no cost-driven change, shadow/fallback, no claimed savings |

Each fixture also asserts the counterfactual: ranking by token count alone
produces a *different* winner in at least cases (a)/(b). That is the regression
guard for "not token-count driven".

### 4.7 Provider-reported usage vs estimates

After every real request (M3; M2 for the mock contract), record the provider's
own fields separately from estimates: `input_tokens`, `cached_tokens`,
`cache_write_tokens` (only if the provider exposes it), `output_tokens`,
reasoning/output token details, and response/model metadata (response id,
served model slug, status).

- Estimates live in `estimated`; provider values live in `usage`. They are never
  merged into one number.
- Exposed field names vary by provider and may be absent; absence is recorded as
  `unavailable`, not as zero.
- Cost-savings claims require usage evidence (I15). Without it the manifest says
  `savings_claim: none`.
- `[VERIFIED 2026-09-18]` the UOS provider catalog currently may not expose price
  fields. M3 therefore captures usage and must **not** infer billing or convert
  usage into money for `gpt-6-astra`.

### 4.8 Enforcement points

These are normative seams for M1–M3, not implementation instructions: the
projection path consults the catalog and cost function; the manifest carries
`catalog_version`, `confidence`, `epoch_id`, and the estimate breakdown; the
usage recorder writes provider fields after each response; and any `medium`/`low`
confidence result is recorded as shadow-only. M0 itself creates no such code.

## 5. Boundaries

Owned by this module (writes allowed): `docs/compact-on-demand/**`,
`.gitmodules`, the `vendor/codex` gitlink, `vendor/codex` working-tree content at
the pin, and a minimal root `README.md` pointer.

Prohibited for this module: `src/**`, `codex/**` (the existing shipping proxy),
`tests/**`, `DECISIONS.md`, host `~/.codex/**`, host config/services, and any
edit inside `/Users/nv/repos/0x4007/codex`. This module does not commit or push;
the primary reviews and commits owned paths.

`[PROPOSED]` M2 will need `tests/compact-on-demand/**` (or an equivalent
test-only path) assigned explicitly; M0 deliberately creates no test files.

## 6. Non-goals

Destructive replacement of the canonical log; compaction after every internal
tool follow-up; changing the shipping `codex/` proxy or the live gateway;
sending private history to Jev in the mock phase; broad real-model workloads.

## 7. Acceptance (M0)

1. The four specs exist with concrete, testable contracts:
   `M0-spec.md`, `M1-working-set-spec.md`, `M2-mock-test-spec.md`,
   `M3-real-luna-spec.md`.
2. Specs define per-request selection, active-chain pinning, append-only source,
   fallback, observability, rollback, and the cost policy in §4: no-selection
   baseline, confidence gating, cache-epoch honesty, Jev internalization, and
   provider-usage/estimate separation.
3. `.gitmodules` records `path = vendor/codex` and
   `url = https://github.com/0x4007/codex.git`, and the recorded gitlink SHA
   equals the pin in §2 exactly (`git ls-files -s vendor/codex` →
   `160000 <sha> 0 vendor/codex`).
4. `git submodule status vendor/codex` reports the pin with a clean, exact
   checkout, and the working tree inside `vendor/codex` is clean.
5. No file outside the owned paths is modified.
6. `git diff --check` (and `--cached` once staged) is clean.
7. Each of M1–M3 carries its share of the cost policy: M1 the costed selection
   contract and fixtures (a)–(d); M2 the usage/cache-accounting mock assertions
   and the unknown-pricing row; M3 the provider-usage telemetry and the
   no-billing-inference caveat. No milestone records a price for
   `gpt-6-astra`/UOS (I10).

### 7.1 Delivery state at handback (2026-09-18)

`[VERIFIED]` at handback time:

- Specs 1, 2 written; `.gitmodules` written; `vendor/codex` present at the pin
  as an unregistered checkout.
- **Acceptance 3 is not yet satisfiable inside the worker sandbox:** recording a
  gitlink requires an index write in the shared git directory
  (`/Users/nv/repos/0x4007/fast-jev-compaction/.git`), which is outside the
  `workspace-write` sandbox. The denial was confirmed
  (`[sandbox: file access denied under workspace-write mode]`) and the one-shot
  escalation to `danger-full-access` was **rejected by the user**, so no
  workaround was attempted.
- Pending primary action (owns the git directory):
  `git add .gitmodules vendor/codex && git submodule absorbgitdirs vendor/codex`
  then re-run acceptance 3–4. `absorbgitdirs` moves the embedded
  `vendor/codex/.git` into `.git/modules/vendor/codex`, which is the state
  `git submodule add` would have produced.

## 8. Verification commands

```sh
# identity / base
pwd && git rev-parse --show-toplevel && git branch --show-current && git status --short --branch

# pin equivalence
git -C vendor/codex rev-parse HEAD          # expect 5c583fe89bbd3ab4dc9a05768299f94e52fe8452
git -C vendor/codex status --porcelain      # expect empty

# gitlink (after the primary stages it)
git ls-files -s vendor/codex                # expect 160000 <pin> 0 vendor/codex
git submodule status vendor/codex           # expect " <pin> vendor/codex (…)" with no leading '-' or '+'

# hygiene
git diff --check && git diff --cached --check
git status --porcelain | grep -vE '^(A|M|\?\?) (docs/compact-on-demand/|\.gitmodules|vendor/codex|README\.md)' # expect empty
```

## 9. Rollback

Revert the owned paths only: delete `docs/compact-on-demand/**`, restore
`README.md`, remove the `vendor/codex` entry from `.gitmodules`, and unstage the
gitlink (`git rm --cached vendor/codex`); optionally
`git submodule deinit -f vendor/codex` before removal. The shipping proxy, the
gateway, and the source checkout are untouched by M0, so no service rollback
exists or is needed.

## 10. Provenance

Rule revisions read in full before work (`[VERIFIED]` by SHA-256):
`deepseek-harness.md` `42f312a2643aca5b1243ff4e7c9a468f1933d99845e826a0a9f941ca6750e73e`,
`git-coordination.md` `028bcc0e20b1b1275b4f86c32ac64ab533ef1131cf910ab1f945af79317a0187`,
`test-evidence.md` `db26c20c7a2090fdf039f660dcf17e057579875a2a2721b21b485f5ac21bcd7f`,
`deno.md` `16a9cbfac83927fbe832692ec4c8a731460572965ea7e2f79d96a1bd9faa10ca` (no
expected hash was supplied for this file; the value is recorded as computed).
Plan: `/Users/nv/Documents/Codex/2026-09-17/set-this-up-https-github-com/.setup/compact-on-demand-plan.md`.
