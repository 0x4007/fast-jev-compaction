/**
 * M3 guard regression tests — loopback-only, offline, no client binary, no real
 * credential, no live model call.
 *
 * These tests prove the enforcement layer of the guarded live smoke before it
 * is ever run:
 * - a request body naming any model other than the exact slug `gpt-5.6-luna`
 *   (including casing, whitespace, short forms, and nested alias fields) is
 *   rejected at the boundary and never reaches the upstream;
 * - `low` cannot be attempted until the upstream itself rejected `none` with an
 *   effort-specific error; a client-side config rejection is not enforcement
 *   and FAILs with zero upstream calls;
 * - only one fixed synthetic user prompt may travel as `input`; prior history,
 *   tool output, extra item fields, and unknown request fields are refused. The
 *   one allowance is off by default and, when the runner supplies the in-memory
 *   fixture, admits only the byte-exact canonical environment-context item the
 *   pinned `exec` injects ahead of the prompt (cwd equal to the harness temp
 *   cwd, configured `never`/`read-only`/`restricted` defaults, no arbitrary XML,
 *   path, extra field, extra text, or extra message);
 * - the attempt and metadata budgets are enforced before forwarding;
 * - the recorded structural state never contains the token;
 * - the guarded runner returns `BLOCKED` / `FAIL` / `PASS` for the exact
 *   conditions the live run must distinguish, and never PASSes on an upstream
 *   2xx alone: the completed response must name the exact model and report the
 *   successful terminal status, and the child must exit 0 with a parsed normal
 *   assistant message and no error event.
 *
 * The upstream here is a counting loopback mock; the real endpoint
 * (`http://127.0.0.1:7999/v1`) is never contacted.
 *
 * Run: deno test --allow-net=127.0.0.1 --allow-read=. --allow-read=$TMPDIR \
 *   --allow-write=$TMPDIR tests/compact-on-demand/luna-guard.test.ts
 */

import { assert, assertEquals } from "./assert.ts";
import {
  assertAllowedInferenceBody,
  evaluateSlugGate,
  type JsonObject,
  LUNA_EFFORT_FALLBACK,
  LUNA_EFFORT_FIRST,
  LUNA_MODEL,
  type LunaBoundary,
  type LunaEnvironmentContextFixture,
  LunaGuardViolation,
  MAX_INFERENCE_ATTEMPTS,
  MODELS_PATH,
  RESPONSES_PATH,
  startLunaBoundary,
} from "./luna-boundary.ts";
import {
  classifyNoneConfigRejection,
  type LiveSmokeClientResult,
  runLunaLiveSmoke,
} from "./m3-luna-live-smoke.ts";

/** Fake token for the guard tests; never a credential. */
const TEST_TOKEN = "m3-guard-test-token-not-a-credential";
const OTHER_MODEL = "gpt-6-astra";
/** The only `input` text the guard-test boundary may forward. */
const GUARD_PROMPT = "synthetic guard prompt";
/**
 * Fixed synthetic stand-in for the harness temp workdir. The boundary cannot
 * and does not check existence; it checks byte-equality against the in-memory
 * fixture, exactly as it does for the runner's real temp cwd.
 */
const GUARD_ENV_CONTEXT_CWD = "/tmp/m3-guard-env-context-workdir";
/**
 * Hand-written canonical fixture (not produced by the guard's own builder) so
 * the positive case proves acceptance of the pinned serialization:
 * `core/src/environment_context.rs:91-126` plus the smoke defaults.
 */
function canonicalEnvContextText(cwd: string = GUARD_ENV_CONTEXT_CWD): string {
  return [
    "<environment_context>",
    `  <cwd>${cwd}</cwd>`,
    "  <approval_policy>never</approval_policy>",
    "  <sandbox_mode>read-only</sandbox_mode>",
    "  <network_access>restricted</network_access>",
    "  <shell>bash</shell>",
    "</environment_context>",
  ].join("\n");
}

const GUARD_ENV_CONTEXT_FIXTURE: LunaEnvironmentContextFixture = {
  cwd: GUARD_ENV_CONTEXT_CWD,
  approvalPolicy: "never",
  sandboxMode: "read-only",
  networkAccess: "restricted",
};

interface SsePlan {
  status: number;
  body: string;
  contentType?: string;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface CountingUpstreamOptions {
  modelsBody?: unknown;
  modelsStatus?: number;
  respondInference?: (index: number, body: JsonObject) => SsePlan;
}

interface CountingUpstream {
  origin: string;
  baseUrl: string;
  metadataRequestCount(): number;
  inferenceBodies(): JsonObject[];
  inferenceRawBodies(): string[];
  stop(): Promise<void>;
}

/** The assistant item the pinned client maps to an `agent_message` event. */
function assistantItem(text = "ok"): JsonObject {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
}

function completedSse(id = "resp_guard_1"): SsePlan {
  return completedSseWith(
    {
      id,
      model: LUNA_MODEL,
      status: "completed",
      usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
    },
    id,
  );
}

/**
 * A successful SSE stream whose `response.completed` payload is supplied
 * verbatim, so a case can omit the model, name another model, or report a
 * failure status while the boundary still records a parsed completion.
 */
function completedSseWith(response: JsonObject, id = "resp_guard_1"): SsePlan {
  return {
    status: 200,
    body: [
      `event: response.created\ndata: ${
        JSON.stringify({
          type: "response.created",
          response: { id, model: LUNA_MODEL },
        })
      }\n\n`,
      `event: response.output_item.done\ndata: ${
        JSON.stringify({
          type: "response.output_item.done",
          item: assistantItem(),
        })
      }\n\n`,
      `event: response.completed\ndata: ${
        JSON.stringify({ type: "response.completed", response })
      }\n\n`,
    ].join(""),
  };
}

/** A `response.completed` event carrying no `response` object at all. */
function completedSseWithoutResponse(): SsePlan {
  return {
    status: 200,
    body: [
      `event: response.created\ndata: ${
        JSON.stringify({
          type: "response.created",
          response: { id: "resp_guard_malformed" },
        })
      }\n\n`,
      `event: response.output_item.done\ndata: ${
        JSON.stringify({
          type: "response.output_item.done",
          item: assistantItem(),
        })
      }\n\n`,
      `event: response.completed\ndata: ${
        JSON.stringify({ type: "response.completed" })
      }\n\n`,
    ].join(""),
  };
}

function noneRejectionSse(): SsePlan {
  return {
    status: 400,
    contentType: "application/json",
    body: JSON.stringify({
      error: {
        type: "invalid_request_error",
        param: "reasoning.effort",
        message:
          "Unsupported reasoning effort: none is not served for this model.",
      },
    }),
  };
}

function unrelatedError(): SsePlan {
  return {
    status: 400,
    contentType: "application/json",
    body: JSON.stringify({
      error: {
        type: "invalid_request_error",
        param: "input",
        message: "Malformed input item.",
      },
    }),
  };
}

async function startCountingUpstream(
  options: CountingUpstreamOptions = {},
): Promise<CountingUpstream> {
  const metadata = { count: 0 };
  const inference: JsonObject[] = [];
  const inferenceRaw: string[] = [];
  const modelsBody = options.modelsBody ?? {
    data: [{ id: LUNA_MODEL }, { id: OTHER_MODEL }],
  };
  const controller = new AbortController();
  let listenResolve: (port: number) => void;
  const listening = new Promise<number>((resolve) => {
    listenResolve = resolve;
  });

  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: controller.signal,
      onListen: ({ port }) => listenResolve(port),
    },
    async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === MODELS_PATH) {
        metadata.count += 1;
        return new Response(JSON.stringify(modelsBody), {
          status: options.modelsStatus ?? 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (request.method === "POST" && url.pathname === RESPONSES_PATH) {
        const raw = await request.text();
        const parsed: unknown = JSON.parse(raw);
        const body = parsed !== null && typeof parsed === "object"
          ? parsed as JsonObject
          : {};
        inference.push(body);
        inferenceRaw.push(raw);
        const plan = options.respondInference?.(inference.length, body) ??
          completedSse();
        return new Response(plan.body, {
          status: plan.status,
          headers: { "content-type": plan.contentType ?? "text/event-stream" },
        });
      }
      return new Response(
        JSON.stringify({ error: { class: "unknown-route" } }),
        {
          status: 404,
          headers: { "content-type": "application/json" },
        },
      );
    },
  );

  const port = await listening;
  return {
    origin: `http://127.0.0.1:${port}`,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    metadataRequestCount: () => metadata.count,
    inferenceBodies: () => inference,
    inferenceRawBodies: () => inferenceRaw,
    stop: async () => {
      controller.abort();
      await server.shutdown().catch(() => {});
    },
  };
}

function syntheticUserItem(text: string = GUARD_PROMPT): JsonObject {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

/** The pinned client's environment-context message shape. */
function environmentContextItem(text: string): JsonObject {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

/** `[canonical env-context, synthetic prompt]`, the pinned first-request input. */
function pinnedInput(
  envText: string = canonicalEnvContextText(),
  prompt: string = GUARD_PROMPT,
): unknown[] {
  return [environmentContextItem(envText), syntheticUserItem(prompt)];
}

function inferenceBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    model: LUNA_MODEL,
    instructions: "synthetic instructions",
    input: [syntheticUserItem()],
    stream: true,
    reasoning: { effort: LUNA_EFFORT_FIRST },
    ...overrides,
  };
}

async function postInference(
  origin: string,
  body: unknown,
): Promise<{ status: number; json: JsonObject | null }> {
  const response = await fetch(`${origin}${RESPONSES_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return {
    status: response.status,
    json: parsed !== null && typeof parsed === "object"
      ? parsed as JsonObject
      : null,
  };
}

function errorClass(json: JsonObject | null): string {
  const error = json?.error;
  if (error !== null && typeof error === "object" && !Array.isArray(error)) {
    const value = (error as JsonObject).class;
    if (typeof value === "string") return value;
  }
  return "none";
}

/** Violation class of a refused pure-guard call, or `none` when it passed. */
function violationClassOf(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    return error instanceof LunaGuardViolation
      ? error.violationClass
      : "not-luna-guard";
  }
  return "none";
}

async function withBoundary(
  options: CountingUpstreamOptions,
  body: (
    boundary: LunaBoundary,
    upstream: CountingUpstream,
  ) => Promise<void>,
  environmentContext?: LunaEnvironmentContextFixture,
): Promise<void> {
  const upstream = await startCountingUpstream(options);
  const boundary = await startLunaBoundary({
    upstreamBaseUrl: upstream.baseUrl,
    token: TEST_TOKEN,
    allowedInputTexts: [GUARD_PROMPT],
    environmentContext,
  });
  try {
    await body(boundary, upstream);
  } finally {
    await boundary.stop();
    await upstream.stop();
  }
}

Deno.test("M3-G01 wrong model, alias, casing, and nested model fields never reach upstream", async () => {
  await withBoundary({}, async (boundary, upstream) => {
    const variants: { body: unknown; expected: string }[] = [
      {
        body: inferenceBody({ model: OTHER_MODEL }),
        expected: "model-not-exact-luna",
      },
      {
        body: inferenceBody({ model: "GPT-5.6-LUNA" }),
        expected: "model-not-exact-luna",
      },
      {
        body: inferenceBody({ model: "gpt-5.6-luna " }),
        expected: "model-not-exact-luna",
      },
      {
        body: inferenceBody({ model: "gpt-5.6-luna\n" }),
        expected: "model-not-exact-luna",
      },
      {
        body: inferenceBody({ model: "gpt-5.6" }),
        expected: "model-not-exact-luna",
      },
      {
        body: inferenceBody({ model: "luna" }),
        expected: "model-not-exact-luna",
      },
      { body: inferenceBody({ model: 42 }), expected: "model-missing" },
      {
        body: inferenceBody({
          input: [{
            type: "message",
            role: "user",
            content: [{
              type: "input_text",
              text: "synthetic",
              model: OTHER_MODEL,
            }],
          }],
        }),
        expected: "nested-model-alias",
      },
    ];
    for (const variant of variants) {
      const result = await postInference(boundary.origin, variant.body);
      assertEquals(result.status, 403, `expected 403 for ${variant.expected}`);
      assertEquals(errorClass(result.json), variant.expected);
    }
    assertEquals(
      upstream.inferenceBodies().length,
      0,
      "no rejected body may reach upstream",
    );
    assertEquals(
      upstream.metadataRequestCount(),
      0,
      "no metadata request in this test",
    );
    assertEquals(boundary.state.inferenceRequests, 0);
  });
});

Deno.test("M3-G02 low is refused first and after a non-rejection; low before none rejection cannot reach upstream", async () => {
  await withBoundary({
    respondInference: () => ({
      status: 500,
      contentType: "application/json",
      body: "{}",
    }),
  }, async (boundary, upstream) => {
    const lowFirst = await postInference(
      boundary.origin,
      inferenceBody({ reasoning: { effort: LUNA_EFFORT_FALLBACK } }),
    );
    assertEquals(lowFirst.status, 403);
    assertEquals(errorClass(lowFirst.json), "effort-not-none-on-first-attempt");
    assertEquals(upstream.inferenceBodies().length, 0);

    const noneAttempt = await postInference(boundary.origin, inferenceBody());
    assertEquals(noneAttempt.status, 500);
    assertEquals(upstream.inferenceBodies().length, 1);
    assertEquals(
      boundary.state.noneRejected,
      false,
      "a 500 is not an explicit none rejection",
    );

    const lowAfter = await postInference(
      boundary.origin,
      inferenceBody({ reasoning: { effort: LUNA_EFFORT_FALLBACK } }),
    );
    assertEquals(lowAfter.status, 403);
    assertEquals(errorClass(lowAfter.json), "effort-low-before-none-rejection");
    assertEquals(
      upstream.inferenceBodies().length,
      1,
      "low must not reach upstream",
    );
  });
});

Deno.test("M3-G03 every other effort value is rejected before upstream", async () => {
  await withBoundary({}, async (boundary, upstream) => {
    const efforts: unknown[] = [
      "medium",
      "high",
      "minimal",
      "auto",
      "",
      null,
      3,
    ];
    for (const effort of efforts) {
      const result = await postInference(
        boundary.origin,
        inferenceBody({ reasoning: { effort } }),
      );
      assertEquals(
        result.status,
        403,
        `effort ${JSON.stringify(effort)} must be rejected`,
      );
      assertEquals(errorClass(result.json), "effort-not-allowed");
    }
    const missingReasoning = await postInference(
      boundary.origin,
      inferenceBody({ reasoning: undefined }),
    );
    assertEquals(errorClass(missingReasoning.json), "effort-not-allowed");
    const missingInput = await postInference(
      boundary.origin,
      inferenceBody({ input: undefined }),
    );
    assertEquals(errorClass(missingInput.json), "input-not-array");
    const notStreaming = await postInference(
      boundary.origin,
      inferenceBody({ stream: false }),
    );
    assertEquals(errorClass(notStreaming.json), "stream-not-true");
    assertEquals(upstream.inferenceBodies().length, 0);
  });
});

Deno.test("M3-G04 none is forwarded once, an explicit rejection unlocks exactly one low attempt", async () => {
  await withBoundary({
    respondInference: (index) =>
      index === 1 ? noneRejectionSse() : completedSse("resp_guard_low"),
  }, async (boundary, upstream) => {
    const noneAttempt = await postInference(boundary.origin, inferenceBody());
    assertEquals(noneAttempt.status, 400);
    assertEquals(boundary.state.noneRejected, true);
    assertEquals(boundary.state.noneRejectionClass, "provider-rejected-none");

    const lowAttempt = await postInference(
      boundary.origin,
      inferenceBody({ reasoning: { effort: LUNA_EFFORT_FALLBACK } }),
    );
    assertEquals(lowAttempt.status, 200);

    const bodies = upstream.inferenceBodies();
    assertEquals(
      bodies.length,
      2,
      "exactly two inference requests may reach upstream",
    );
    assertEquals(bodies[0].model, LUNA_MODEL);
    assertEquals((bodies[0].reasoning as JsonObject).effort, LUNA_EFFORT_FIRST);
    assertEquals(bodies[1].model, LUNA_MODEL);
    assertEquals(
      (bodies[1].reasoning as JsonObject).effort,
      LUNA_EFFORT_FALLBACK,
    );

    assertEquals(boundary.state.attempts.length, 2);
    assertEquals(boundary.state.attempts[0].outgoingEffort, LUNA_EFFORT_FIRST);
    assertEquals(boundary.state.attempts[0].completed, false);
    assertEquals(
      boundary.state.attempts[0].noneRejectionClass,
      "provider-rejected-none",
    );
    assertEquals(
      boundary.state.attempts[1].outgoingEffort,
      LUNA_EFFORT_FALLBACK,
    );
    assertEquals(boundary.state.attempts[1].completed, true);
    assertEquals(boundary.state.attempts[1].responseModel, LUNA_MODEL);
    assertEquals(boundary.state.attempts[1].usage, {
      input_tokens: 5,
      output_tokens: 1,
      total_tokens: 6,
      cached_tokens: "unavailable",
      cache_write_tokens: "unavailable",
      reasoning_tokens: "unavailable",
    });
  });
});

Deno.test("M3-G05 a third inference attempt is refused at the boundary", async () => {
  await withBoundary({
    respondInference: (index) =>
      index === 1 ? noneRejectionSse() : completedSse(),
  }, async (boundary, upstream) => {
    await postInference(boundary.origin, inferenceBody());
    await postInference(
      boundary.origin,
      inferenceBody({ reasoning: { effort: LUNA_EFFORT_FALLBACK } }),
    );
    const third = await postInference(
      boundary.origin,
      inferenceBody({ reasoning: { effort: LUNA_EFFORT_FALLBACK } }),
    );
    assertEquals(third.status, 403);
    assertEquals(errorClass(third.json), "inference-budget-exhausted");
    assertEquals(upstream.inferenceBodies().length, MAX_INFERENCE_ATTEMPTS);
    assertEquals(boundary.state.inferenceRequests, MAX_INFERENCE_ATTEMPTS);
  });
});

Deno.test("M3-G06 metadata budget is exactly one GET /v1/models", async () => {
  await withBoundary({}, async (boundary, upstream) => {
    const first = await fetch(`${boundary.origin}${MODELS_PATH}`);
    assertEquals(first.status, 200);
    const slugs = (await first.json() as { data: { id: string }[] }).data.map((
      entry,
    ) => entry.id);
    assertEquals(slugs, [LUNA_MODEL, OTHER_MODEL]);
    assertEquals(upstream.metadataRequestCount(), 1);

    const second = await fetch(`${boundary.origin}${MODELS_PATH}`);
    assertEquals(second.status, 403);
    assertEquals(
      upstream.metadataRequestCount(),
      1,
      "a second metadata GET must not be forwarded",
    );
    assertEquals(boundary.state.slugGate, "present");
  });
});

Deno.test("M3-G07 exact-slug gate accepts only the verbatim slug", async () => {
  assertEquals(evaluateSlugGate([LUNA_MODEL, OTHER_MODEL]), "present");
  assertEquals(evaluateSlugGate([OTHER_MODEL]), "absent");
  assertEquals(evaluateSlugGate(["GPT-5.6-LUNA"]), "absent");
  assertEquals(evaluateSlugGate(["gpt-5.6-luna "]), "absent");
  assertEquals(evaluateSlugGate(["gpt-5.6"]), "absent");
  assertEquals(evaluateSlugGate([]), "absent");

  await withBoundary(
    { modelsBody: { data: [{ id: OTHER_MODEL }] } },
    async (boundary, upstream) => {
      await fetch(`${boundary.origin}${MODELS_PATH}`);
      assertEquals(boundary.state.slugGate, "absent");
      assertEquals(upstream.inferenceBodies().length, 0);
    },
  );
});

Deno.test("M3-G08 recorded guard state never contains the token", async () => {
  await withBoundary({
    respondInference: (index) =>
      index === 1 ? noneRejectionSse() : completedSse(),
  }, async (boundary) => {
    await fetch(`${boundary.origin}${MODELS_PATH}`);
    await postInference(boundary.origin, inferenceBody());
    await postInference(
      boundary.origin,
      inferenceBody({ reasoning: { effort: LUNA_EFFORT_FALLBACK } }),
    );
    const serialized = JSON.stringify(boundary.state);
    assert(
      !serialized.includes(TEST_TOKEN),
      "token leaked into recorded boundary state",
    );
    assertEquals(boundary.tokenAbsentFromState(), true);
  });
});

/* ------------------------------------------------------------------ */
/* Guarded live-smoke runner (fakes only; the real endpoint is untouched) */
/* ------------------------------------------------------------------ */

function argValue(args: string[], key: string): string | null {
  const prefix = `${key}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  if (found === undefined) return null;
  const raw = found.slice(prefix.length);
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : raw;
  } catch {
    return raw;
  }
}

/** The provider value is a TOML inline table; read only its `base_url`. */
function providerBaseUrl(providerValue: string | null): string | null {
  if (providerValue === null) return null;
  const match = /base_url\s*=\s*"([^"]+)"/.exec(providerValue);
  return match === null ? null : match[1];
}

/**
 * Fake client that behaves like the compiled CLI on the wire: it reads the
 * boundary base URL, the model/effort overrides, and the synthetic prompt from
 * its own argv, so the test exercises the same config surface and the same
 * payload whitelist the real run uses.
 *
 * `mode: "config-rejects-none"` models a pinned enum without a `none` variant:
 * that invocation fails before any request. It is never provider enforcement,
 * so the runner must FAIL it with zero upstream calls; every other invocation
 * goes to the wire.
 *
 * The wire modes reproduce the pin's `--json` contract: the config-summary and
 * prompt lines first, then one `Event` line per parsed event
 * (`exec/src/event_processor_with_json_output.rs`). A `response.output_item.done`
 * assistant item becomes a non-empty `agent_message`; an upstream failure
 * becomes an `error` event and still exits 0, exactly as the pin does on a turn
 * error (`core/src/codex.rs:1866`, `exec/src/lib.rs:295`).
 */
type FakeClientMode =
  | "wire"
  | "config-rejects-none"
  /** Upstream 2xx and normal stdout, but the child exits non-zero. */
  | "post-wire-exit-nonzero"
  /** Upstream 2xx and exit 0, but no parsed assistant event at all. */
  | "post-wire-no-assistant"
  /** Upstream 2xx and exit 0, but an `error` event was emitted. */
  | "post-wire-error-event";

/** One `exec --json` stdout event line: the pin's `Event` shape. */
function jsonEventLine(type: string, fields: JsonObject): string {
  return JSON.stringify({ id: "m3-guard-event", msg: { type, ...fields } });
}

/** The assistant text of a `response.output_item.done` item, as the pin maps it. */
function assistantTextFromSse(text: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed.slice("data:".length).trim());
    } catch {
      continue;
    }
    if (!isJsonObject(parsed) || parsed.type !== "response.output_item.done") {
      continue;
    }
    const item = parsed.item;
    if (
      !isJsonObject(item) || item.role !== "assistant" ||
      !Array.isArray(item.content)
    ) {
      continue;
    }
    for (const part of item.content) {
      if (
        isJsonObject(part) && part.type === "output_text" &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
    }
  }
  return null;
}

function fakeLunaClient(mode: FakeClientMode): {
  run: (
    args: string[],
    env: Record<string, string>,
    cwd: string,
  ) => Promise<LiveSmokeClientResult>;
  invocations: string[];
  cwds: string[];
  resolvedCwds: string[];
} {
  const invocations: string[] = [];
  const cwds: string[] = [];
  const resolvedCwds: string[] = [];
  const configError =
    "Error parsing -c overrides: unknown variant `none`, expected one of `minimal`, `low`, `medium`, `high`";
  return {
    invocations,
    cwds,
    resolvedCwds,
    run: async (args, _env, cwd) => {
      const effort = argValue(args, "model_reasoning_effort") ?? "";
      const model = argValue(args, "model") ?? "";
      const prompt = args[args.length - 1] ?? "";
      invocations.push(effort);
      if (mode === "config-rejects-none" && effort === LUNA_EFFORT_FIRST) {
        return {
          argv: args,
          exitCode: 1,
          timedOut: false,
          stdoutText: "",
          stderrText: configError,
        };
      }
      const providerBase = providerBaseUrl(
        argValue(args, "model_providers.luna_smoke"),
      );
      if (providerBase === null) {
        throw new Error("fake client: provider base_url missing from argv");
      }
      cwds.push(cwd);
      // The client appends `/responses` to the configured base URL, exactly as
      // the pinned client does (`core/src/model_provider_info.rs:159`),
      // records the environment context ahead of the prompt, and canonicalizes
      // `-C` (`exec/src/lib.rs:156`).
      // The runner removes this temp workdir before it returns, so the resolved
      // path must be recorded here, while the directory still exists.
      const envCwd = await Deno.realPath(cwd);
      resolvedCwds.push(envCwd);
      const envText = [
        "<environment_context>",
        `  <cwd>${envCwd}</cwd>`,
        "  <approval_policy>never</approval_policy>",
        "  <sandbox_mode>read-only</sandbox_mode>",
        "  <network_access>restricted</network_access>",
        "</environment_context>",
      ].join("\n");
      const response = await fetch(`${providerBase}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          inferenceBody({
            model,
            reasoning: { effort },
            input: [environmentContextItem(envText), syntheticUserItem(prompt)],
          }),
        ),
      });
      const text = await response.text();
      const assistantText = assistantTextFromSse(text);
      const summaryLines = [
        // Config summary and prompt lines: JSON, but no `msg.type`.
        JSON.stringify({ model, provider: "luna_smoke" }),
        JSON.stringify({ prompt }),
      ];
      const eventLines = response.status < 300 && assistantText !== null
        ? [jsonEventLine("agent_message", { message: assistantText })]
        : [jsonEventLine("error", { message: "synthetic upstream failure" })];
      let stdoutLines = [...summaryLines, ...eventLines];
      let exitCode = 0;
      let stderrText = "";
      switch (mode) {
        case "post-wire-exit-nonzero":
          // Only the process status is wrong; stdout is fully normal.
          exitCode = 1;
          stderrText = "synthetic post-upstream child failure";
          break;
        case "post-wire-no-assistant":
          stdoutLines = summaryLines;
          break;
        case "post-wire-error-event":
          stdoutLines = [
            ...summaryLines,
            jsonEventLine("error", { message: "synthetic client error" }),
          ];
          break;
        default:
          break;
      }
      return {
        argv: args,
        exitCode,
        timedOut: false,
        stdoutText: `${stdoutLines.join("\n")}\n`,
        stderrText,
      };
    },
  };
}

Deno.test("M3-G09 runner reports BLOCKED with zero inference when the exact slug is absent", async () => {
  const upstream = await startCountingUpstream({
    modelsBody: { data: [{ id: OTHER_MODEL }] },
  });
  try {
    const client = fakeLunaClient("wire");
    const result = await runLunaLiveSmoke({
      token: TEST_TOKEN,
      binaryPath: "/nonexistent/m3-luna-smoke-binary",
      upstreamBaseUrl: upstream.baseUrl,
      runClientImpl: client.run,
    });
    assertEquals(result.status, "BLOCKED");
    assertEquals(result.reason, "exact-slug-absent");
    assertEquals(result.model, LUNA_MODEL);
    assertEquals(result.metadata.slugs, [OTHER_MODEL]);
    assertEquals(result.attempts.length, 0);
    assertEquals(
      client.invocations.length,
      0,
      "no client may run before the gate passes",
    );
    assertEquals(upstream.inferenceBodies().length, 0);
    assertEquals(JSON.stringify(result).includes(TEST_TOKEN), false);
  } finally {
    await upstream.stop();
  }
});

Deno.test("M3-G10 runner takes none → explicit rejection → low and records both attempts", async () => {
  const upstream = await startCountingUpstream({
    respondInference: (index) =>
      index === 1 ? noneRejectionSse() : completedSse("resp_guard_low"),
  });
  try {
    const client = fakeLunaClient("wire");
    const result = await runLunaLiveSmoke({
      token: TEST_TOKEN,
      binaryPath: "/nonexistent/m3-luna-smoke-binary",
      upstreamBaseUrl: upstream.baseUrl,
      runClientImpl: client.run,
    });
    assertEquals(result.status, "PASS");
    assertEquals(result.reason, "low-accepted-after-none-rejection");
    assertEquals(client.invocations, [LUNA_EFFORT_FIRST, LUNA_EFFORT_FALLBACK]);
    assertEquals(result.attempts.length, 2);
    assertEquals(result.attempts[0].outgoingModel, LUNA_MODEL);
    assertEquals(result.attempts[0].outgoingEffort, LUNA_EFFORT_FIRST);
    assertEquals(result.attempts[1].outgoingEffort, LUNA_EFFORT_FALLBACK);
    assertEquals(result.attempts[1].noneRejectionClass, null);
    assertEquals(result.metadata.gate, "present");
    assertEquals(result.redaction.tokenAbsentFromState, true);
    assertEquals(JSON.stringify(result).includes(TEST_TOKEN), false);
  } finally {
    await upstream.stop();
  }
});

Deno.test("M3-G11 client-config rejection of none FAILs with zero upstream calls and no low fallback", async () => {
  const upstream = await startCountingUpstream();
  try {
    const client = fakeLunaClient("config-rejects-none");
    const result = await runLunaLiveSmoke({
      token: TEST_TOKEN,
      binaryPath: "/nonexistent/m3-luna-smoke-binary",
      upstreamBaseUrl: upstream.baseUrl,
      runClientImpl: client.run,
    });
    assertEquals(result.status, "FAIL");
    assertEquals(result.reason, "client-config-rejected-none");
    assertEquals(
      client.invocations,
      [LUNA_EFFORT_FIRST],
      "a client-side refusal must never trigger the low attempt",
    );
    assertEquals(
      upstream.inferenceBodies().length,
      0,
      "client inability to parse none is not provider enforcement",
    );
    assertEquals(
      result.attempts.length,
      0,
      "no attempt may be recorded when nothing reached upstream",
    );
    assertEquals(JSON.stringify(result).includes(TEST_TOKEN), false);
  } finally {
    await upstream.stop();
  }
});

Deno.test("M3-G12 runner FAILs and does not attempt low when none is rejected without an explicit signal", async () => {
  const upstream = await startCountingUpstream({
    respondInference: () => unrelatedError(),
  });
  try {
    const client = fakeLunaClient("wire");
    const result = await runLunaLiveSmoke({
      token: TEST_TOKEN,
      binaryPath: "/nonexistent/m3-luna-smoke-binary",
      upstreamBaseUrl: upstream.baseUrl,
      runClientImpl: client.run,
    });
    assertEquals(result.status, "FAIL");
    assertEquals(result.reason, "none-rejected-without-explicit-signal");
    assertEquals(client.invocations, [LUNA_EFFORT_FIRST]);
    assertEquals(upstream.inferenceBodies().length, 1);
  } finally {
    await upstream.stop();
  }
});

Deno.test("M3-G13 runner FAILs when no inference request is made and no rejection is observable", async () => {
  const upstream = await startCountingUpstream();
  try {
    const silent = {
      invocations: [] as string[],
      run: async (args: string[]): Promise<LiveSmokeClientResult> => {
        silent.invocations.push("invoked");
        return {
          argv: args,
          exitCode: 1,
          timedOut: false,
          stdoutText: "",
          stderrText: "unrelated failure",
        };
      },
    };
    const result = await runLunaLiveSmoke({
      token: TEST_TOKEN,
      binaryPath: "/nonexistent/m3-luna-smoke-binary",
      upstreamBaseUrl: upstream.baseUrl,
      runClientImpl: silent.run,
    });
    assertEquals(result.status, "FAIL");
    assertEquals(result.reason, "no-inference-request");
    assertEquals(
      upstream.inferenceBodies().length,
      0,
      "no model request may be emitted",
    );
  } finally {
    await upstream.stop();
  }
});

Deno.test("M3-G14 config-rejection classifier is diagnostic only and names none", () => {
  assertEquals(
    classifyNoneConfigRejection(
      "unknown variant `none`, expected one of `minimal`, `low`, `medium`, `high`",
    ),
    "client-config-rejected-none",
  );
  assertEquals(classifyNoneConfigRejection("invalid value: none"), null);
  assertEquals(
    classifyNoneConfigRejection("unknown variant `seven`, expected one of `a`"),
    null,
  );
  assertEquals(classifyNoneConfigRejection("connection refused"), null);
});

Deno.test("M3-G15 pure guard accepts the exact body and rejects aliases with fixed classes", () => {
  assertEquals(
    assertAllowedInferenceBody(inferenceBody(), {
      attemptIndex: 1,
      noneRejected: false,
      allowedInputTexts: [GUARD_PROMPT],
    }),
    {
      model: LUNA_MODEL,
      effort: LUNA_EFFORT_FIRST,
    },
  );
  let thrown: unknown = null;
  try {
    assertAllowedInferenceBody(inferenceBody({ model: OTHER_MODEL }), {
      attemptIndex: 1,
      noneRejected: false,
      allowedInputTexts: [GUARD_PROMPT],
    });
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof LunaGuardViolation, "expected LunaGuardViolation");
  assertEquals(thrown.violationClass, "model-not-exact-luna");
});

Deno.test("M3-G16 payload whitelist forwards only the fixed synthetic user prompt", async () => {
  await withBoundary({}, async (boundary, upstream) => {
    const variants: { body: unknown; expected: string }[] = [
      {
        body: inferenceBody({
          input: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: GUARD_PROMPT }],
            },
          ],
        }),
        expected: "input-item-not-synthetic-user-message",
      },
      {
        body: inferenceBody({
          input: [
            {
              type: "function_call_output",
              call_id: "call_private_1",
              output: "private tool output",
            },
          ],
        }),
        expected: "input-item-not-synthetic-user-message",
      },
      {
        body: inferenceBody({
          input: [syntheticUserItem("private repository prompt")],
        }),
        expected: "input-text-not-allowed",
      },
      {
        body: inferenceBody({
          input: [
            {
              ...syntheticUserItem(),
              previous_response_id: "resp_private",
            },
          ],
        }),
        expected: "unexpected-input-item-field",
      },
      {
        body: inferenceBody({
          input: [syntheticUserItem(), syntheticUserItem()],
        }),
        expected: "input-item-count",
      },
      {
        body: inferenceBody({ input: [] }),
        expected: "input-item-count",
      },
      {
        body: inferenceBody({ previous_response_id: "resp_private" }),
        expected: "unexpected-request-field",
      },
    ];
    for (const variant of variants) {
      const result = await postInference(boundary.origin, variant.body);
      assertEquals(result.status, 403, `expected 403 for ${variant.expected}`);
      assertEquals(errorClass(result.json), variant.expected);
    }
    assertEquals(
      upstream.inferenceBodies().length,
      0,
      "no non-whitelisted payload may reach upstream",
    );
    assertEquals(boundary.state.inferenceRequests, 0);
  });
});

Deno.test("M3-G17 boundary exposes no client-side none unlock and keeps low refused", async () => {
  await withBoundary({}, async (boundary, upstream) => {
    assert(
      !Object.hasOwn(boundary, "noteNoneRejection"),
      "the boundary must not expose a client-side none-rejection unlock",
    );
    const lowOnly = await postInference(
      boundary.origin,
      inferenceBody({ reasoning: { effort: LUNA_EFFORT_FALLBACK } }),
    );
    assertEquals(lowOnly.status, 403);
    assertEquals(
      errorClass(lowOnly.json),
      "effort-not-none-on-first-attempt",
    );
    assertEquals(upstream.inferenceBodies().length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* Pinned environment-context allowance (remedy i; disabled by default) */
/* ------------------------------------------------------------------ */

Deno.test("M3-G18 canonical pinned env-context plus prompt is forwarded byte-identically", async () => {
  await withBoundary({}, async (boundary, upstream) => {
    const raw = JSON.stringify(inferenceBody({ input: pinnedInput() }));
    const response = await fetch(`${boundary.origin}${RESPONSES_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });
    assertEquals(response.status, 200);
    assertEquals(upstream.inferenceBodies().length, 1);
    assertEquals(
      upstream.inferenceRawBodies()[0],
      raw,
      "the client's original bytes must be forwarded unchanged",
    );
    const input = upstream.inferenceBodies()[0].input as JsonObject[];
    assertEquals(input.length, 2);
    assertEquals(
      (input[0].content as JsonObject[])[0].text,
      canonicalEnvContextText(),
    );
    assertEquals((input[1].content as JsonObject[])[0].text, GUARD_PROMPT);
    assertEquals(boundary.state.attempts.length, 1);
    assertEquals(boundary.state.attempts[0].forwarded, true);
    assertEquals(boundary.state.violations, []);
  }, GUARD_ENV_CONTEXT_FIXTURE);
});

Deno.test("M3-G19 the allowance accepts only the canonical fixture byte-for-byte", () => {
  const context = {
    attemptIndex: 1,
    noneRejected: false,
    allowedInputTexts: [GUARD_PROMPT],
    environmentContext: GUARD_ENV_CONTEXT_FIXTURE,
  };
  const noShell = canonicalEnvContextText().replace(
    "\n  <shell>bash</shell>",
    "",
  );
  const zshShell = canonicalEnvContextText().replace(
    "<shell>bash</shell>",
    "<shell>zsh</shell>",
  );
  for (const envText of [noShell, canonicalEnvContextText(), zshShell]) {
    assertEquals(
      assertAllowedInferenceBody(
        inferenceBody({ input: pinnedInput(envText) }),
        context,
      ),
      { model: LUNA_MODEL, effort: LUNA_EFFORT_FIRST },
    );
  }

  const extraWritableRoots = canonicalEnvContextText().replace(
    "  <network_access>restricted</network_access>\n",
    "  <network_access>restricted</network_access>\n" +
      "  <writable_roots>\n    <root>/private/secret</root>\n  </writable_roots>\n",
  );
  const rejected: { input: unknown[]; expected: string }[] = [
    {
      input: pinnedInput(canonicalEnvContextText("/tmp/m3-other-workdir")),
      expected: "environment-context-text-not-canonical",
    },
    {
      input: pinnedInput(extraWritableRoots),
      expected: "environment-context-text-not-canonical",
    },
    {
      input: pinnedInput(`${canonicalEnvContextText()}\nprivate trailing text`),
      expected: "environment-context-text-not-canonical",
    },
    {
      input: [
        syntheticUserItem("private repository prompt"),
        syntheticUserItem(),
      ],
      expected: "environment-context-text-not-canonical",
    },
    {
      input: [
        syntheticUserItem(),
        environmentContextItem(canonicalEnvContextText()),
      ],
      expected: "environment-context-text-not-canonical",
    },
    {
      input: [
        environmentContextItem(canonicalEnvContextText()),
        syntheticUserItem(),
        syntheticUserItem("private history"),
      ],
      expected: "input-item-count",
    },
    {
      input: [
        {
          ...environmentContextItem(canonicalEnvContextText()),
          previous_response_id: "resp_private",
        },
        syntheticUserItem(),
      ],
      expected: "environment-context-unexpected-field",
    },
    {
      input: [
        {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: canonicalEnvContextText(),
            extra: "private",
          }],
        },
        syntheticUserItem(),
      ],
      expected: "environment-context-content-unexpected-field",
    },
    {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "output_text", text: canonicalEnvContextText() }],
        },
        syntheticUserItem(),
      ],
      expected: "environment-context-content-invalid",
    },
    {
      input: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "input_text", text: canonicalEnvContextText() }],
        },
        syntheticUserItem(),
      ],
      expected: "environment-context-item-not-user-message",
    },
    {
      input: pinnedInput(
        canonicalEnvContextText(),
        "private repository prompt",
      ),
      expected: "input-text-not-allowed",
    },
  ];
  for (const variant of rejected) {
    assertEquals(
      violationClassOf(() =>
        assertAllowedInferenceBody(
          inferenceBody({ input: variant.input }),
          context,
        )
      ),
      variant.expected,
    );
  }

  assertEquals(
    violationClassOf(() =>
      assertAllowedInferenceBody(
        inferenceBody({ model: OTHER_MODEL, input: pinnedInput() }),
        context,
      )
    ),
    "model-not-exact-luna",
  );
  assertEquals(
    violationClassOf(() =>
      assertAllowedInferenceBody(
        inferenceBody({
          reasoning: { effort: "medium" },
          input: pinnedInput(),
        }),
        context,
      )
    ),
    "effort-not-allowed",
  );
});

Deno.test("M3-G20 non-canonical env-context never reaches upstream when the allowance is enabled", async () => {
  await withBoundary({}, async (boundary, upstream) => {
    const variants: { body: unknown; expected: string }[] = [
      {
        body: inferenceBody({
          input: pinnedInput(canonicalEnvContextText("/tmp/m3-other-workdir")),
        }),
        expected: "environment-context-text-not-canonical",
      },
      {
        body: inferenceBody({
          input: pinnedInput(
            `${canonicalEnvContextText()}\nprivate trailing text`,
          ),
        }),
        expected: "environment-context-text-not-canonical",
      },
      {
        body: inferenceBody({
          input: [
            environmentContextItem(canonicalEnvContextText()),
            syntheticUserItem(),
            syntheticUserItem("private history"),
          ],
        }),
        expected: "input-item-count",
      },
      {
        body: inferenceBody({
          input: [
            {
              ...environmentContextItem(canonicalEnvContextText()),
              previous_response_id: "resp_private",
            },
            syntheticUserItem(),
          ],
        }),
        expected: "environment-context-unexpected-field",
      },
      {
        body: inferenceBody({
          model: OTHER_MODEL,
          input: pinnedInput(),
        }),
        expected: "model-not-exact-luna",
      },
      {
        body: inferenceBody({
          reasoning: { effort: "medium" },
          input: pinnedInput(),
        }),
        expected: "effort-not-allowed",
      },
      {
        body: inferenceBody({ input: [syntheticUserItem()] }),
        expected: "input-item-count",
      },
    ];
    for (const variant of variants) {
      const result = await postInference(boundary.origin, variant.body);
      assertEquals(result.status, 403, `expected 403 for ${variant.expected}`);
      assertEquals(errorClass(result.json), variant.expected);
    }
    assertEquals(
      upstream.inferenceBodies().length,
      0,
      "no non-canonical env-context payload may reach upstream",
    );
    assertEquals(boundary.state.inferenceRequests, 0);
  }, GUARD_ENV_CONTEXT_FIXTURE);
});

Deno.test("M3-G21 the env-context allowance stays disabled unless the runner supplies the fixture", async () => {
  await withBoundary({}, async (boundary, upstream) => {
    const withEnv = await postInference(
      boundary.origin,
      inferenceBody({ input: pinnedInput() }),
    );
    assertEquals(withEnv.status, 403);
    assertEquals(errorClass(withEnv.json), "input-item-count");

    const single = await postInference(boundary.origin, inferenceBody());
    assertEquals(single.status, 200);
    assertEquals(upstream.inferenceBodies().length, 1);
    assertEquals(boundary.state.inferenceRequests, 1);
  });
});

Deno.test("M3-G22 a fixture that does not match the configured defaults refuses to start", async () => {
  const upstream = await startCountingUpstream();
  try {
    const badFixtures: LunaEnvironmentContextFixture[] = [
      { ...GUARD_ENV_CONTEXT_FIXTURE, approvalPolicy: "on-request" },
      { ...GUARD_ENV_CONTEXT_FIXTURE, sandboxMode: "workspace-write" },
      { ...GUARD_ENV_CONTEXT_FIXTURE, networkAccess: "enabled" },
      { ...GUARD_ENV_CONTEXT_FIXTURE, cwd: "relative/workdir" },
      { ...GUARD_ENV_CONTEXT_FIXTURE, cwd: "/" },
      {
        ...GUARD_ENV_CONTEXT_FIXTURE,
        cwd: `${GUARD_ENV_CONTEXT_CWD}</cwd><cwd>/private`,
      },
      { ...GUARD_ENV_CONTEXT_FIXTURE, cwd: "/tmp/m3-guard\nworkdir" },
    ];
    for (const fixture of badFixtures) {
      let thrown: unknown = null;
      try {
        const boundary = await startLunaBoundary({
          upstreamBaseUrl: upstream.baseUrl,
          token: TEST_TOKEN,
          allowedInputTexts: [GUARD_PROMPT],
          environmentContext: fixture,
        });
        await boundary.stop();
      } catch (error) {
        thrown = error;
      }
      assert(
        thrown instanceof LunaGuardViolation,
        `expected LunaGuardViolation for fixture ${JSON.stringify(fixture)}`,
      );
      assertEquals(
        thrown.violationClass,
        "environment-context-fixture-invalid",
      );
    }
    assertEquals(upstream.inferenceBodies().length, 0);
    assertEquals(upstream.metadataRequestCount(), 0);
  } finally {
    await upstream.stop();
  }
});

Deno.test("M3-G23 the runner builds the env-context fixture in memory from the fresh temp cwd", async () => {
  const upstream = await startCountingUpstream();
  try {
    const client = fakeLunaClient("wire");
    const result = await runLunaLiveSmoke({
      token: TEST_TOKEN,
      binaryPath: "/nonexistent/m3-luna-smoke-binary",
      upstreamBaseUrl: upstream.baseUrl,
      runClientImpl: client.run,
    });
    assertEquals(result.status, "PASS");
    assertEquals(result.reason, "none-accepted");
    assertEquals(result.attempts.length, 1);
    assertEquals(result.attempts[0].forwarded, true);
    assertEquals(client.cwds.length, 1);
    assertEquals(client.resolvedCwds.length, 1);

    // The runner deletes its temp root before returning, so the fake client
    // records the resolved cwd while the workdir exists; resolving it here
    // would fail with NotFound. This also pins the cleanup behavior itself.
    let cwdCleanedUp = false;
    try {
      await Deno.stat(client.cwds[0]);
    } catch (error) {
      cwdCleanedUp = error instanceof Deno.errors.NotFound;
    }
    assertEquals(
      cwdCleanedUp,
      true,
      "runner must remove its temp workdir before returning",
    );
    const expectedCwd = client.resolvedCwds[0];
    const bodies = upstream.inferenceBodies();
    assertEquals(bodies.length, 1);
    const input = bodies[0].input as JsonObject[];
    assertEquals(input.length, 2);
    const envText = (input[0].content as JsonObject[])[0].text;
    assertEquals(
      envText,
      [
        "<environment_context>",
        `  <cwd>${expectedCwd}</cwd>`,
        "  <approval_policy>never</approval_policy>",
        "  <sandbox_mode>read-only</sandbox_mode>",
        "  <network_access>restricted</network_access>",
        "</environment_context>",
      ].join("\n"),
    );
    assertEquals(
      (input[1].content as JsonObject[])[0].text,
      "Reply with the single word ok.",
    );
  } finally {
    await upstream.stop();
  }
});

Deno.test("M3-G24 only an exact-model successful completion can PASS; missing, mismatched, malformed, and failed completions FAIL without fallback", async () => {
  const cases: {
    name: string;
    plan: SsePlan;
    status: "PASS" | "FAIL";
    reason: string;
    /** The boundary still records a parsed `response.completed` event. */
    completedEventParsed?: boolean;
  }[] = [
    {
      name: "missing returned model",
      plan: completedSseWith({
        id: "resp_guard_missing_model",
        status: "completed",
        usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
      }),
      status: "FAIL",
      reason: "none-attempt-response-model-missing",
    },
    {
      name: "mismatched returned model",
      plan: completedSseWith({
        id: "resp_guard_other_model",
        model: OTHER_MODEL,
        status: "completed",
      }),
      status: "FAIL",
      reason: "none-attempt-response-model-mismatch",
    },
    {
      name: "malformed completed event without a response object",
      plan: completedSseWithoutResponse(),
      status: "FAIL",
      reason: "none-attempt-response-model-missing",
      completedEventParsed: true,
    },
    {
      name: "failure status",
      plan: completedSseWith({
        id: "resp_guard_failed",
        model: LUNA_MODEL,
        status: "failed",
      }),
      status: "FAIL",
      reason: "none-attempt-response-status-not-successful",
    },
    {
      name: "exact model and completed status",
      plan: completedSse(),
      status: "PASS",
      reason: "none-accepted",
    },
  ];
  for (const testCase of cases) {
    const upstream = await startCountingUpstream({
      respondInference: () => testCase.plan,
    });
    try {
      const client = fakeLunaClient("wire");
      const result = await runLunaLiveSmoke({
        token: TEST_TOKEN,
        binaryPath: "/nonexistent/m3-luna-smoke-binary",
        upstreamBaseUrl: upstream.baseUrl,
        runClientImpl: client.run,
      });
      assertEquals(result.status, testCase.status, testCase.name);
      assertEquals(result.reason, testCase.reason, testCase.name);
      assertEquals(
        client.invocations,
        [LUNA_EFFORT_FIRST],
        `${testCase.name}: a non-exact completion must not retry or fall back`,
      );
      assertEquals(
        upstream.inferenceBodies().length,
        1,
        `${testCase.name}: exactly one upstream request`,
      );
      assertEquals(result.attempts.length, 1, testCase.name);
      assertEquals(result.attempts[0].upstreamStatus, 200, testCase.name);
      if (testCase.completedEventParsed === true) {
        // The boundary's `completed` flag alone is not acceptance: the malformed
        // event is recorded, yet the runner must still FAIL.
        assertEquals(result.attempts[0].completed, true, testCase.name);
        assertEquals(result.attempts[0].responseModel, null, testCase.name);
      }
      if (testCase.status === "PASS") {
        assertEquals(
          result.attempts[0].responseModel,
          LUNA_MODEL,
          testCase.name,
        );
        assertEquals(
          result.attempts[0].responseStatus,
          "completed",
          testCase.name,
        );
      }
    } finally {
      await upstream.stop();
    }
  }
});

Deno.test("M3-G25 a valid upstream 200 cannot PASS when the child process fails or emits no normal assistant message", async () => {
  const cases: { mode: FakeClientMode; reason: string }[] = [
    {
      mode: "post-wire-exit-nonzero",
      reason: "none-attempt-client-exit-not-zero",
    },
    {
      mode: "post-wire-no-assistant",
      reason: "none-attempt-client-no-assistant-message",
    },
    {
      mode: "post-wire-error-event",
      reason: "none-attempt-client-error-event",
    },
  ];
  for (const testCase of cases) {
    const upstream = await startCountingUpstream();
    try {
      const client = fakeLunaClient(testCase.mode);
      const result = await runLunaLiveSmoke({
        token: TEST_TOKEN,
        binaryPath: "/nonexistent/m3-luna-smoke-binary",
        upstreamBaseUrl: upstream.baseUrl,
        runClientImpl: client.run,
      });
      assertEquals(result.status, "FAIL", testCase.mode);
      assertEquals(result.reason, testCase.reason, testCase.mode);
      assertEquals(result.attempts.length, 1, testCase.mode);
      // The upstream answer itself looked perfect...
      assertEquals(result.attempts[0].upstreamStatus, 200, testCase.mode);
      assertEquals(result.attempts[0].responseModel, LUNA_MODEL, testCase.mode);
      assertEquals(
        result.attempts[0].responseStatus,
        "completed",
        testCase.mode,
      );
      // ...and the runner still must not retry or fall back.
      assertEquals(client.invocations, [LUNA_EFFORT_FIRST], testCase.mode);
      assertEquals(upstream.inferenceBodies().length, 1, testCase.mode);
      assertEquals(JSON.stringify(result).includes(TEST_TOKEN), false);
    } finally {
      await upstream.stop();
    }
  }
});

Deno.test("M3-G26 a mismatched model on the low fallback FAILs explicitly after a provider none rejection", async () => {
  const upstream = await startCountingUpstream({
    respondInference: (index) => {
      if (index === 1) return noneRejectionSse();
      return completedSseWith({
        id: "resp_guard_low_other_model",
        model: OTHER_MODEL,
        status: "completed",
      });
    },
  });
  try {
    const client = fakeLunaClient("wire");
    const result = await runLunaLiveSmoke({
      token: TEST_TOKEN,
      binaryPath: "/nonexistent/m3-luna-smoke-binary",
      upstreamBaseUrl: upstream.baseUrl,
      runClientImpl: client.run,
    });
    assertEquals(result.status, "FAIL");
    assertEquals(result.reason, "low-attempt-response-model-mismatch");
    assertEquals(
      client.invocations,
      [LUNA_EFFORT_FIRST, LUNA_EFFORT_FALLBACK],
      "the provider rejection of none unlocks exactly one low attempt",
    );
    assertEquals(result.attempts.length, 2);
    assertEquals(result.attempts[1].outgoingEffort, LUNA_EFFORT_FALLBACK);
    assertEquals(result.attempts[1].responseModel, OTHER_MODEL);
    assertEquals(upstream.inferenceBodies().length, 2);
  } finally {
    await upstream.stop();
  }
});
