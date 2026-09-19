/**
 * M3 Luna live-smoke guard — test-only, loopback-only boundary.
 *
 * This module implements the enforcement layer that sits between the client
 * under test and the existing configured UOS endpoint
 * (`http://127.0.0.1:7999/v1`, spec §3). It is not the shipping
 * `codex/` proxy: it is an ephemeral in-test listener that
 *
 * - allows exactly one `GET /v1/models` and at most two `POST /v1/responses`,
 * - hard-checks every inference body *before* any upstream socket is opened:
 *   the model must be exactly `gpt-5.6-luna`, the reasoning effort must be
 *   `none` (attempt 1) or `low` (attempt 2, only after the upstream itself
 *   rejected `none` with an effort-specific error), only known request fields
 *   may appear, and every `input` item must be a user message whose text is one
 *   of the fixed synthetic prompts — prior history, tool output, or any other
 *   private material is refused and never forwarded. One exception exists and
 *   is disabled by default: when the guarded runner passes an in-memory fixture
 *   (`environmentContext`), exactly one canonical environment-context item —
 *   the item the pinned `codex exec` always injects ahead of the prompt — is
 *   accepted byte-for-byte, its `<cwd>` must equal the freshly created harness
 *   temp cwd, and the approval/sandbox/network values must equal the smoke's
 *   configured defaults. Arbitrary XML, extra fields, extra text, other paths,
 *   extra messages, and any fixture mismatch stay refused,
 * - forwards the client's original bytes unchanged (the parsed copy exists only
 *   for the guard), so the guard cannot rewrite a body into passing,
 * - injects the credential read in-process by the caller and never records it,
 *   and exposes no client-side hook that could unlock the `low` attempt,
 * - records only allowlisted structural fields (model, effort, status,
 *   response id/model/status, usage numbers, fixed rejection classes).
 *
 * No price, rate, currency, token value, prompt text, or raw error body is
 * stored or printed anywhere here.
 */

export const LUNA_MODEL = "gpt-5.6-luna";
export const LUNA_EFFORT_FIRST = "none";
export const LUNA_EFFORT_FALLBACK = "low";
export const UOS_ENDPOINT_DEFAULT = "http://127.0.0.1:7999/v1";
export const MODELS_PATH = "/v1/models";
export const RESPONSES_PATH = "/v1/responses";
export const MAX_METADATA_REQUESTS = 1;
export const MAX_INFERENCE_ATTEMPTS = 2;
export const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Environment-context values the pinned `codex exec` derives from this smoke's
 * configured defaults. Headless `exec` forces `approval_policy = never`
 * (`exec/src/lib.rs:154`); without `--sandbox`, `--full-auto`, or
 * `--dangerously-bypass-approvals-and-sandbox` the sandbox mode keeps its
 * default `read-only` (`protocol/src/config_types.rs:51-54`); a read-only
 * policy maps to `network_access = restricted`
 * (`core/src/environment_context.rs:44-60`). No config file, CLI flag, or
 * environment variable may move these values.
 */
export const ENV_CONTEXT_APPROVAL_POLICY = "never";
export const ENV_CONTEXT_SANDBOX_MODE = "read-only";
export const ENV_CONTEXT_NETWORK_ACCESS = "restricted";
/**
 * The only unix account-shell names the pin can put in `<shell>`; any other
 * account shell collapses to `Shell::Unknown` and omits the element entirely.
 */
export const ENV_CONTEXT_SHELLS = ["zsh", "bash"] as const;

/**
 * Every top-level field the pinned client's `ResponsesApiRequest` can serialize
 * (`core/src/client_common.rs:121`). Any other field is refused before a socket
 * is opened; `input` is additionally restricted to fixed synthetic prompts.
 */
export const ALLOWED_REQUEST_FIELDS = new Set([
  "model",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "store",
  "stream",
  "include",
  "prompt_cache_key",
  "text",
]);

export type LunaEffort = "none" | "low";
export type SlugGate = "present" | "absent" | "not-run";
export type UsageValue = number | "unavailable";

/**
 * The canonical environment context the pinned client injects ahead of the
 * synthetic prompt. It is built only by the guarded runner, in memory, from the
 * freshly created temp cwd — never from the environment, a CLI flag, or the
 * request body. Supplying it enables the single environment-context allowance;
 * omitting it keeps the pure single-prompt rule.
 */
export interface LunaEnvironmentContextFixture {
  /**
   * Absolute cwd of the harness temp workdir after symlink resolution; the
   * pinned client canonicalizes `-C` (`exec/src/lib.rs:156`).
   */
  cwd: string;
  approvalPolicy: string;
  sandboxMode: string;
  networkAccess: string;
}

export interface JsonObject {
  [key: string]: unknown;
}

export interface InferenceAttemptRecord {
  attempt: number;
  outgoingModel: string;
  outgoingEffort: string;
  upstreamStatus: number | null;
  forwarded: boolean;
  /** True only when the upstream body carried a parsed `response.completed`. */
  completed: boolean;
  responseId: string | null;
  responseModel: string | null;
  responseStatus: string | null;
  usage: Record<string, UsageValue> | "unavailable";
  noneRejectionClass: string | null;
}

export interface LunaBoundaryState {
  metadataRequests: number;
  metadataStatus: number | null;
  metadataSlugs: string[];
  slugGate: SlugGate;
  inferenceRequests: number;
  attempts: InferenceAttemptRecord[];
  violations: string[];
  noneRejected: boolean;
  noneRejectionClass: string | null;
}

export interface LunaBoundaryOptions {
  upstreamBaseUrl?: string;
  token: string;
  /**
   * The only `input` texts this boundary may forward (the fixed synthetic
   * prompts). Required: the guard fails closed without an explicit whitelist.
   */
  allowedInputTexts: readonly string[];
  /**
   * In-memory expectation of the single canonical environment-context item the
   * pinned client injects ahead of the prompt. Disabled when omitted. Values
   * must match the configured smoke defaults exactly or the boundary refuses to
   * start.
   */
  environmentContext?: LunaEnvironmentContextFixture;
  fetchImpl?: typeof fetch;
  maxInferenceAttempts?: number;
  maxMetadataRequests?: number;
  requestTimeoutMs?: number;
}

export interface LunaBoundary {
  readonly origin: string;
  readonly baseUrl: string;
  readonly state: LunaBoundaryState;
  readonly tokenPresent: boolean;
  /** True when the recorded state provably contains no copy of the token. */
  tokenAbsentFromState(): boolean;
  stop(): Promise<void>;
}

export class LunaGuardViolation extends Error {
  readonly violationClass: string;
  constructor(violationClass: string, detail: string) {
    super(`${violationClass}: ${detail}`);
    this.name = "LunaGuardViolation";
    this.violationClass = violationClass;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fail(violationClass: string, detail: string): never {
  throw new LunaGuardViolation(violationClass, detail);
}

function nestedModelSlugs(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) nestedModelSlugs(entry, found);
    return found;
  }
  if (!isJsonObject(value)) return found;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "model" && typeof entry === "string" && entry !== LUNA_MODEL) {
      found.push(entry);
    }
    nestedModelSlugs(entry, found);
  }
  return found;
}

/** Every string value carried under an `effort` key anywhere in the body. */
function nestedEffortValues(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) nestedEffortValues(entry, found);
    return found;
  }
  if (!isJsonObject(value)) return found;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "effort" && typeof entry === "string") found.push(entry);
    nestedEffortValues(entry, found);
  }
  return found;
}

const ALLOWED_INPUT_ITEM_FIELDS = new Set(["type", "role", "content"]);
const ALLOWED_INPUT_PART_FIELDS = new Set(["type", "text"]);

/**
 * The exact canonical environment-context texts this boundary accepts when the
 * runner supplies a fixture: the pinned serialization
 * (`core/src/environment_context.rs:91-126`) with the configured defaults and
 * the fixture cwd, optionally followed by the single `<shell>` line the pin can
 * emit on unix. Everything else — other paths, extra fields, extra text, other
 * shells — differs byte-for-byte and is refused.
 */
function canonicalEnvironmentContextTexts(
  fixture: LunaEnvironmentContextFixture,
): string[] {
  const lines = [
    "<environment_context>",
    `  <cwd>${fixture.cwd}</cwd>`,
    `  <approval_policy>${fixture.approvalPolicy}</approval_policy>`,
    `  <sandbox_mode>${fixture.sandboxMode}</sandbox_mode>`,
    `  <network_access>${fixture.networkAccess}</network_access>`,
  ];
  const texts = [`${lines.join("\n")}\n</environment_context>`];
  for (const shell of ENV_CONTEXT_SHELLS) {
    texts.push(
      `${lines.join("\n")}\n  <shell>${shell}</shell>\n</environment_context>`,
    );
  }
  return texts;
}

/**
 * A fixture is trusted only when it is well-formed, cannot inject XML, and
 * carries exactly the configured smoke defaults. A mismatch is a programming
 * error in the runner, so the boundary refuses to start rather than weaken.
 */
function assertEnvironmentContextFixture(
  fixture: LunaEnvironmentContextFixture,
): void {
  const cwd = fixture.cwd;
  const wellFormedCwd = typeof cwd === "string" && cwd.startsWith("/") &&
    cwd.length > 1 && !/[<>&]/.test(cwd) && !/\p{Cc}/u.test(cwd);
  if (!wellFormedCwd) {
    fail(
      "environment-context-fixture-invalid",
      "fixture cwd must be an absolute, XML-safe harness temp path",
    );
  }
  if (fixture.approvalPolicy !== ENV_CONTEXT_APPROVAL_POLICY) {
    fail(
      "environment-context-fixture-invalid",
      "fixture approvalPolicy must equal the configured smoke default",
    );
  }
  if (fixture.sandboxMode !== ENV_CONTEXT_SANDBOX_MODE) {
    fail(
      "environment-context-fixture-invalid",
      "fixture sandboxMode must equal the configured smoke default",
    );
  }
  if (fixture.networkAccess !== ENV_CONTEXT_NETWORK_ACCESS) {
    fail(
      "environment-context-fixture-invalid",
      "fixture networkAccess must equal the configured smoke default",
    );
  }
}

/**
 * Exactly one fixed synthetic user prompt item; prior assistant turns, tool
 * calls/outputs, extra text, or extra item fields are refused. The optional
 * environment-context item is handled separately and only when enabled.
 */
function assertSyntheticPromptItem(
  item: unknown,
  allowedInputTexts: readonly string[],
): void {
  if (!isJsonObject(item)) {
    fail("input-item-not-object", "input item must be a JSON object");
  }
  if (item.type !== "message" || item.role !== "user") {
    fail(
      "input-item-not-synthetic-user-message",
      "only a synthetic user message item may be forwarded",
    );
  }
  for (const key of Object.keys(item)) {
    if (!ALLOWED_INPUT_ITEM_FIELDS.has(key)) {
      fail(
        "unexpected-input-item-field",
        `input item field ${JSON.stringify(key)} is not permitted`,
      );
    }
  }
  const content = item.content;
  if (!Array.isArray(content) || content.length === 0) {
    fail(
      "input-item-content-empty",
      "a synthetic user message must carry non-empty content",
    );
  }
  for (const part of content) {
    if (!isJsonObject(part) || part.type !== "input_text") {
      fail(
        "input-item-content-not-allowed",
        "only input_text content parts may be forwarded",
      );
    }
    if (
      typeof part.text !== "string" || !allowedInputTexts.includes(part.text)
    ) {
      fail(
        "input-text-not-allowed",
        "input text is not one of the fixed synthetic prompts",
      );
    }
  }
}

/**
 * The pinned client's environment-context item: a user message carrying exactly
 * one `input_text` part whose text must be the canonical fixture byte-for-byte.
 * Any other structure, field, or text is refused.
 */
function assertEnvironmentContextItem(
  item: unknown,
  fixture: LunaEnvironmentContextFixture,
): void {
  if (!isJsonObject(item)) {
    fail(
      "environment-context-item-not-object",
      "environment-context item must be a JSON object",
    );
  }
  if (item.type !== "message" || item.role !== "user") {
    fail(
      "environment-context-item-not-user-message",
      "environment-context item must be a user message",
    );
  }
  for (const key of Object.keys(item)) {
    if (!ALLOWED_INPUT_ITEM_FIELDS.has(key)) {
      fail(
        "environment-context-unexpected-field",
        `environment-context item field ${
          JSON.stringify(key)
        } is not permitted`,
      );
    }
  }
  const content = item.content;
  if (!Array.isArray(content) || content.length !== 1) {
    fail(
      "environment-context-content-invalid",
      "environment-context item must carry exactly one input_text part",
    );
  }
  const part = content[0];
  if (!isJsonObject(part)) {
    fail(
      "environment-context-content-invalid",
      "environment-context content must be a single input_text part",
    );
  }
  if (part.type !== "input_text") {
    fail(
      "environment-context-content-invalid",
      "environment-context content must be a single input_text part",
    );
  }
  const text = part.text;
  if (typeof text !== "string") {
    fail(
      "environment-context-content-invalid",
      "environment-context content must be a single input_text part",
    );
  }
  for (const key of Object.keys(part)) {
    if (!ALLOWED_INPUT_PART_FIELDS.has(key)) {
      fail(
        "environment-context-content-unexpected-field",
        `environment-context content field ${
          JSON.stringify(key)
        } is not permitted`,
      );
    }
  }
  if (!canonicalEnvironmentContextTexts(fixture).includes(text)) {
    fail(
      "environment-context-text-not-canonical",
      "environment-context text is not the canonical fixture for this run",
    );
  }
}

/**
 * The `input` array rule. Without a runner-supplied fixture: exactly one fixed
 * synthetic user prompt. With one: exactly the canonical environment-context
 * item ahead of that prompt; no other count, order, or payload is forwarded.
 */
function assertSyntheticUserInput(
  items: unknown[],
  allowedInputTexts: readonly string[],
  environmentContext?: LunaEnvironmentContextFixture,
): void {
  if (environmentContext === undefined) {
    if (items.length !== 1) {
      fail(
        "input-item-count",
        `exactly one synthetic user prompt item may be forwarded, got ${items.length}`,
      );
    }
    assertSyntheticPromptItem(items[0], allowedInputTexts);
    return;
  }
  if (items.length !== 2) {
    fail(
      "input-item-count",
      `exactly one canonical environment-context item followed by one synthetic ` +
        `user prompt may be forwarded, got ${items.length}`,
    );
  }
  assertEnvironmentContextItem(items[0], environmentContext);
  assertSyntheticPromptItem(items[1], allowedInputTexts);
}

export interface InferenceBodyContext {
  attemptIndex: number;
  noneRejected: boolean;
  /** Fixed synthetic prompt texts this body may carry; nothing else is forwarded. */
  allowedInputTexts: readonly string[];
  /**
   * Disabled by default. When the guarded runner supplies the in-memory
   * fixture, exactly one canonical environment-context item is allowed ahead of
   * the synthetic prompt; no other extra message is.
   */
  environmentContext?: LunaEnvironmentContextFixture;
}

/**
 * Boundary allowlist. Returns the values that will be recorded when the body
 * is admissible; throws `LunaGuardViolation` (before any network call) for
 * every other model, alias, casing, effort, request field, or input payload.
 */
export function assertAllowedInferenceBody(
  body: unknown,
  context: InferenceBodyContext,
): { model: string; effort: LunaEffort } {
  if (!isJsonObject(body)) {
    fail("body-not-object", "request body must be a JSON object");
  }

  for (const key of Object.keys(body)) {
    if (!ALLOWED_REQUEST_FIELDS.has(key)) {
      fail(
        "unexpected-request-field",
        `request field ${JSON.stringify(key)} is not permitted`,
      );
    }
  }

  if (typeof body.model !== "string") {
    fail("model-missing", "body.model must be a string");
  }
  if (body.model !== LUNA_MODEL) {
    fail(
      "model-not-exact-luna",
      `refusing to forward model ${JSON.stringify(body.model)}`,
    );
  }
  const aliases = nestedModelSlugs(body);
  if (aliases.length > 0) {
    fail(
      "nested-model-alias",
      `refusing nested model value(s) ${JSON.stringify(aliases)}`,
    );
  }

  if (body.stream !== true) fail("stream-not-true", "stream must be true");
  if (!Array.isArray(body.input)) {
    fail("input-not-array", "input must be an array");
  }
  if (
    body.instructions !== undefined && typeof body.instructions !== "string"
  ) {
    fail(
      "instructions-not-string",
      "instructions must be a string when present",
    );
  }
  if (body.tools !== undefined) {
    if (
      !Array.isArray(body.tools) ||
      body.tools.some((tool) => !isJsonObject(tool))
    ) {
      fail("tools-not-array", "tools must be an array of objects when present");
    }
  }
  assertSyntheticUserInput(
    body.input,
    context.allowedInputTexts,
    context.environmentContext,
  );

  const reasoning = body.reasoning;
  const rawEffort = isJsonObject(reasoning) ? reasoning.effort : undefined;
  const allowedEffort: LunaEffort | null = rawEffort === LUNA_EFFORT_FIRST
    ? LUNA_EFFORT_FIRST
    : rawEffort === LUNA_EFFORT_FALLBACK
    ? LUNA_EFFORT_FALLBACK
    : null;
  if (allowedEffort === null) {
    fail(
      "effort-not-allowed",
      `reasoning effort ${JSON.stringify(rawEffort)} is not permitted`,
    );
  }
  for (const effort of nestedEffortValues(body)) {
    if (effort !== allowedEffort) {
      fail(
        "effort-mismatch-elsewhere",
        "every effort value in the body must equal the permitted effort",
      );
    }
  }
  if (context.attemptIndex === 1 && allowedEffort !== LUNA_EFFORT_FIRST) {
    fail(
      "effort-not-none-on-first-attempt",
      "attempt 1 must use reasoning none",
    );
  }
  if (context.attemptIndex > 1) {
    if (allowedEffort !== LUNA_EFFORT_FALLBACK) {
      fail(
        "effort-not-low-on-fallback",
        "the only permitted fallback effort is low",
      );
    }
    if (!context.noneRejected) {
      fail(
        "effort-low-before-none-rejection",
        "low requires an observed upstream rejection of none",
      );
    }
  }
  return { model: body.model, effort: allowedEffort };
}

/** Exact-string presence check; no case folding, prefixing, or aliasing. */
export function evaluateSlugGate(slugs: string[]): SlugGate {
  return slugs.includes(LUNA_MODEL) ? "present" : "absent";
}

const USAGE_NUMERIC_FIELDS = [
  "input_tokens",
  "output_tokens",
  "total_tokens",
] as const;
const USAGE_DETAIL_FIELDS = [
  "cached_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
] as const;

/**
 * Extracts only allowlisted structural fields from an SSE body. Free text is
 * never returned; absent numbers become `"unavailable"`, never `0`.
 */
export function extractStructuralFields(text: string): {
  completed: boolean;
  responseId: string | null;
  responseModel: string | null;
  responseStatus: string | null;
  usage: Record<string, UsageValue> | "unavailable";
} {
  let completed = false;
  let responseId: string | null = null;
  let responseModel: string | null = null;
  let responseStatus: string | null = null;
  let usage: Record<string, UsageValue> | "unavailable" = "unavailable";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed.slice("data:".length).trim());
    } catch {
      continue;
    }
    if (!isJsonObject(parsed) || parsed.type !== "response.completed") continue;
    completed = true;
    const response = parsed.response;
    if (!isJsonObject(response)) continue;
    if (typeof response.id === "string") responseId = response.id;
    if (typeof response.model === "string") responseModel = response.model;
    if (typeof response.status === "string") responseStatus = response.status;
    const rawUsage = response.usage;
    if (!isJsonObject(rawUsage)) {
      usage = "unavailable";
      continue;
    }
    const recorded: Record<string, UsageValue> = {};
    for (const field of USAGE_NUMERIC_FIELDS) {
      recorded[field] = typeof rawUsage[field] === "number"
        ? rawUsage[field]
        : "unavailable";
    }
    const details = [
      rawUsage.input_tokens_details,
      rawUsage.output_tokens_details,
    ];
    for (const field of USAGE_DETAIL_FIELDS) {
      const holder = details.find((entry) =>
        isJsonObject(entry) && field in entry
      );
      const value = isJsonObject(holder) ? holder[field] : undefined;
      recorded[field] = typeof value === "number" ? value : "unavailable";
    }
    usage = recorded;
  }
  return { completed, responseId, responseModel, responseStatus, usage };
}

/**
 * True only when a non-success upstream answer explicitly names the reasoning
 * effort value `none` as rejected/unsupported. A 500, transport error, a 200,
 * an unrelated 400, or a client-side config failure leaves `noneRejected`
 * false, so `low` is never attempted from those conditions.
 */
export function isExplicitNoneRejection(status: number, text: string): boolean {
  if (status < 400 || status >= 500) return false;
  const mentionsEffort = /reasoning|effort/i.test(text);
  const namesNoneValue =
    /[`"']none[`"']|:\s*none\b|=\s*none\b|\bnone\s+(?:is|not|unsupported)\b/i
      .test(text);
  return mentionsEffort && namesNoneValue;
}

function upstreamUrl(upstreamBaseUrl: string, incomingPath: string): string {
  const suffix = incomingPath.startsWith("/v1")
    ? incomingPath.slice(3)
    : incomingPath;
  return `${upstreamBaseUrl.replace(/\/+$/, "")}${suffix}`;
}

export async function startLunaBoundary(
  options: LunaBoundaryOptions,
): Promise<LunaBoundary> {
  const upstreamBaseUrl = options.upstreamBaseUrl ?? UOS_ENDPOINT_DEFAULT;
  const token = options.token;
  const allowedInputTexts = options.allowedInputTexts;
  const environmentContext = options.environmentContext;
  if (environmentContext !== undefined) {
    assertEnvironmentContextFixture(environmentContext);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxInference = options.maxInferenceAttempts ?? MAX_INFERENCE_ATTEMPTS;
  const maxMetadata = options.maxMetadataRequests ?? MAX_METADATA_REQUESTS;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  const state: LunaBoundaryState = {
    metadataRequests: 0,
    metadataStatus: null,
    metadataSlugs: [],
    slugGate: "not-run",
    inferenceRequests: 0,
    attempts: [],
    violations: [],
    noneRejected: false,
    noneRejectionClass: null,
  };

  const controller = new AbortController();
  /**
   * Attempt phase counter: advances only when a request is actually forwarded
   * upstream, so a client-side refusal can never consume the `none` phase and
   * unlock `low`.
   */
  let consumedAttempts = 0;
  let listenResolve: (port: number) => void;
  const listening = new Promise<number>((resolve) => {
    listenResolve = resolve;
  });

  async function forward(
    target: string,
    init: RequestInit,
  ): Promise<{ status: number; text: string; contentType: string }> {
    const response = await fetchImpl(target, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      contentType: response.headers.get("content-type") ?? "text/event-stream",
    };
  }

  async function handleMetadata(): Promise<Response> {
    if (state.metadataRequests >= maxMetadata) {
      state.violations.push("metadata-budget-exhausted");
      return jsonResponse(403, {
        error: { class: "metadata-budget-exhausted" },
      });
    }
    state.metadataRequests += 1;
    let result: { status: number; text: string; contentType: string };
    try {
      result = await forward(upstreamUrl(upstreamBaseUrl, MODELS_PATH), {
        method: "GET",
      });
    } catch (error) {
      state.violations.push("metadata-transport-error");
      return jsonResponse(502, {
        error: {
          class: "metadata-transport-error",
          detail: String(error instanceof Error ? error.name : "unknown"),
        },
      });
    }
    state.metadataStatus = result.status;
    state.metadataSlugs = parseModelSlugs(result.text);
    state.slugGate = evaluateSlugGate(state.metadataSlugs);
    return new Response(result.text, {
      status: result.status,
      headers: { "content-type": result.contentType },
    });
  }

  async function handleInference(request: Request): Promise<Response> {
    if (state.inferenceRequests >= maxInference) {
      state.violations.push("inference-budget-exhausted");
      return jsonResponse(403, {
        error: { class: "inference-budget-exhausted" },
      });
    }
    const rawBody = await request.text();
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      state.violations.push("invalid-json-body");
      return jsonResponse(400, { error: { class: "invalid-json-body" } });
    }

    const attemptIndex = consumedAttempts + 1;
    let outgoing: { model: string; effort: LunaEffort };
    try {
      outgoing = assertAllowedInferenceBody(body, {
        attemptIndex,
        noneRejected: state.noneRejected,
        allowedInputTexts,
        environmentContext,
      });
    } catch (error) {
      const violationClass = error instanceof LunaGuardViolation
        ? error.violationClass
        : "guard-error";
      state.violations.push(violationClass);
      return jsonResponse(403, { error: { class: violationClass } });
    }

    state.inferenceRequests += 1;
    consumedAttempts += 1;
    const attempt: InferenceAttemptRecord = {
      attempt: attemptIndex,
      outgoingModel: outgoing.model,
      outgoingEffort: outgoing.effort,
      upstreamStatus: null,
      forwarded: true,
      completed: false,
      responseId: null,
      responseModel: null,
      responseStatus: null,
      usage: "unavailable",
      noneRejectionClass: null,
    };
    state.attempts.push(attempt);

    let result: { status: number; text: string; contentType: string };
    try {
      // The client's original bytes are forwarded unchanged; the guard only
      // reads the parsed copy above and can never rewrite a body into passing.
      result = await forward(upstreamUrl(upstreamBaseUrl, RESPONSES_PATH), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rawBody,
      });
    } catch (error) {
      state.violations.push("upstream-transport-error");
      return jsonResponse(502, {
        error: {
          class: "upstream-transport-error",
          detail: String(error instanceof Error ? error.name : "unknown"),
        },
      });
    }

    attempt.upstreamStatus = result.status;
    const structural = extractStructuralFields(result.text);
    attempt.completed = structural.completed;
    attempt.responseId = structural.responseId;
    attempt.responseModel = structural.responseModel;
    attempt.responseStatus = structural.responseStatus;
    attempt.usage = structural.usage;

    if (
      attemptIndex === 1 && outgoing.effort === LUNA_EFFORT_FIRST &&
      !(result.status >= 200 && result.status < 300) &&
      isExplicitNoneRejection(result.status, result.text)
    ) {
      state.noneRejected = true;
      state.noneRejectionClass = "provider-rejected-none";
      attempt.noneRejectionClass = "provider-rejected-none";
    }

    return new Response(result.text, {
      status: result.status,
      headers: { "content-type": result.contentType },
    });
  }

  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: controller.signal,
      onListen: ({ port }) => listenResolve(port),
    },
    (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === MODELS_PATH) {
        return handleMetadata();
      }
      if (request.method === "POST" && url.pathname === RESPONSES_PATH) {
        return handleInference(request);
      }
      return jsonResponse(404, { error: { class: "unknown-route" } });
    },
  );

  const port = await listening;
  return {
    origin: `http://127.0.0.1:${port}`,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    state,
    tokenPresent: token.length > 0,
    tokenAbsentFromState: () =>
      token.length > 0 && !JSON.stringify(state).includes(token),
    stop: async () => {
      controller.abort();
      await server.shutdown().catch(() => {});
    },
  };
}

/** Reads `data[].id` only; other catalog fields are neither recorded nor needed. */
export function parseModelSlugs(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isJsonObject(parsed) || !Array.isArray(parsed.data)) return [];
  const slugs: string[] = [];
  for (const entry of parsed.data) {
    if (isJsonObject(entry) && typeof entry.id === "string") {
      slugs.push(entry.id);
    }
  }
  return slugs;
}
