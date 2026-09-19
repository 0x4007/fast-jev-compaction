/**
 * M3 Luna guarded live smoke — IMPLEMENTED BUT NOT RUN in the M2-RC assignment.
 *
 * There is no ambient execution path: nothing runs on import, and the module
 * acts only when it is the explicit process entrypoint (`import.meta.main`),
 * which the primary invokes deliberately. No opt-in environment variable is
 * read or added.
 *
 * What it is allowed to do when the primary later runs it:
 * - exactly one `GET /v1/models` immediately before inference, exact-slug gate
 *   for `gpt-5.6-luna` (§2.1); absent ⇒ `BLOCKED` with zero inference requests;
 * - at most two inference requests through the guard boundary: `none` first,
 *   and `low` only after the upstream itself rejected `none` with an
 *   effort-specific error. A client that cannot parse `none` is NOT provider
 *   enforcement: that run FAILs with zero upstream inference requests;
 * - the boundary forwards the client's original bytes, refuses unknown request
 *   fields, and refuses any `input` item that is not one of the fixed synthetic
 *   prompts (no prior history, tool output, or private material). The one
 *   pinned exception is validated byte-for-byte against an in-memory fixture
 *   built from this run's fresh temp cwd: the single canonical
 *   environment-context item `exec` injects ahead of the prompt, with only the
 *   configured `never`/`read-only`/`restricted` defaults;
 * - retries disabled, 120 s per request, synthetic prompts of ≤ 64 words, a
 *   fresh temp `CODEX_HOME`/cwd, existing `UOS_AI_TOKEN` only, direct existing
 *   endpoint `http://127.0.0.1:7999/v1` (no shipping proxy);
 * - acceptance is exact and two-sided: the recorded attempt must be an HTTP 2xx
 *   whose parsed `response.completed` names exactly `gpt-5.6-luna` with the
 *   successful terminal status, and the child itself must have exited 0 without
 *   timing out after printing a parsed non-empty `agent_message` event and no
 *   `error` event. A missing or mismatched returned model, a malformed
 *   completed event without a response object, a failure status, and a failed
 *   child are explicit FAILs with no retry — `low` stays reachable only after
 *   the upstream itself rejected `none`;
 * - allowlisted structural output only: model, effort, HTTP status, response
 *   id/model/status, usage numbers or `"unavailable"`, fixed rejection classes,
 *   credential-presence boolean, and a token-absence proof. No prompt text,
 *   token value, raw body, price, rate, or savings figure is printed.
 *
 * The client under test is the compiled pinned fork binary at the fixed recorded
 * path (`forkBinaryPath()`, the m01-client worktree); the smoke never
 * substitutes a TypeScript HTTP client. A fresh temp cwd plus fresh
 * `CODEX_HOME` means no repository or global instructions are injected.
 */

import {
  ENV_CONTEXT_APPROVAL_POLICY,
  ENV_CONTEXT_NETWORK_ACCESS,
  ENV_CONTEXT_SANDBOX_MODE,
  type InferenceAttemptRecord,
  LUNA_EFFORT_FALLBACK,
  LUNA_EFFORT_FIRST,
  LUNA_MODEL,
  type LunaBoundary,
  type LunaBoundaryState,
  type LunaEnvironmentContextFixture,
  MAX_INFERENCE_ATTEMPTS,
  MAX_METADATA_REQUESTS,
  MODELS_PATH,
  REQUEST_TIMEOUT_MS,
  startLunaBoundary,
  UOS_ENDPOINT_DEFAULT,
} from "./luna-boundary.ts";
import { forkBinaryPath } from "./pinned-client-harness.ts";

export const CREDENTIAL_ENV = "UOS_AI_TOKEN";

/** Fixed synthetic prompt; self-contained, no repository or session content. */
export const SYNTHETIC_PROMPT = "Reply with the single word ok.";
/** Fallback prompt kept equally synthetic and short (≤ 64 words). */
export const SYNTHETIC_PROMPT_FALLBACK = "Reply with the single word low.";

const CHILD_TIMEOUT_MARGIN_MS = 15_000;

export type SmokeStatus = "PASS" | "FAIL" | "BLOCKED";

export interface LiveSmokeClientResult {
  argv: string[];
  exitCode: number | null;
  timedOut: boolean;
  stdoutText: string;
  stderrText: string;
}

export interface LiveSmokeResult {
  status: SmokeStatus;
  reason: string;
  model: string;
  metadata: {
    requests: number;
    status: number | null;
    slugs: string[];
    gate: LunaBoundaryState["slugGate"];
  };
  attempts: LunaBoundaryState["attempts"];
  client: { binaryPath: string; mode: string; invocations: number };
  credentialPresence: Record<string, boolean>;
  redaction: { tokenAbsentFromState: boolean };
  budgets: {
    maxMetadataRequests: number;
    maxInferenceAttempts: number;
    retries: number;
    requestTimeoutMs: number;
  };
}

export interface LiveSmokeOptions {
  token: string;
  binaryPath: string;
  upstreamBaseUrl?: string;
  requestTimeoutMs?: number;
  /** Test seam: replaces the boundary's upstream transport, never the client. */
  boundaryFetchImpl?: typeof fetch;
  /** Test seam: runs one client invocation with post-`--json` args. */
  runClientImpl?: (
    args: string[],
    env: Record<string, string>,
    cwd: string,
  ) => Promise<LiveSmokeClientResult>;
}

function isExecOnlyBinary(binaryPath: string): boolean {
  const base = binaryPath.split("/").pop() ?? binaryPath;
  return base.startsWith("codex-exec");
}

function binaryPrefix(binaryPath: string): string[] {
  return isExecOnlyBinary(binaryPath) ? [binaryPath] : [binaryPath, "exec"];
}

/**
 * Classifies a client-side config rejection of `none` for diagnostics only.
 * This is NOT provider enforcement: the runner FAILs with zero upstream
 * inference requests when it appears, and it never unlocks the `low` attempt.
 */
export function classifyNoneConfigRejection(childText: string): string | null {
  const unknownVariant =
    /unknown variant|expected one of|not one of the expected|invalid enum/i;
  if (unknownVariant.test(childText) && /none/i.test(childText)) {
    return "client-config-rejected-none";
  }
  return null;
}

function attemptsForwarded(state: LunaBoundaryState): number {
  return state.attempts.filter((attempt) => attempt.forwarded).length;
}

/** The only `response.completed` status that proves a normal successful turn. */
const SUCCESSFUL_RESPONSE_STATUS = "completed";

/**
 * Why the last recorded upstream attempt cannot be accepted. Acceptance is
 * exact and structural: forwarded, HTTP 2xx, a parsed `response.completed`, the
 * returned model equal to `gpt-5.6-luna` (no alias, casing, or fallback), and
 * the successful terminal status. A missing or mismatched model, a completed
 * event without a response object, and a failure status all stay rejected.
 */
function attemptRejectionReason(
  attempt: InferenceAttemptRecord | undefined,
): string | null {
  if (attempt === undefined) return "attempt-missing";
  if (!attempt.forwarded) return "attempt-not-forwarded";
  if (attempt.upstreamStatus === null) return "upstream-status-missing";
  if (attempt.upstreamStatus < 200 || attempt.upstreamStatus >= 300) {
    return "upstream-not-2xx";
  }
  if (!attempt.completed) return "response-completed-missing";
  if (attempt.responseModel === null) return "response-model-missing";
  if (attempt.responseModel !== LUNA_MODEL) return "response-model-mismatch";
  if (attempt.responseStatus === null) return "response-status-missing";
  if (attempt.responseStatus !== SUCCESSFUL_RESPONSE_STATUS) {
    return "response-status-not-successful";
  }
  return null;
}

function phaseFailure(phase: "none" | "low", detail: string): string {
  return `${phase}-attempt-${detail}`;
}

interface ClientEvent {
  type: string;
  message: string;
}

/**
 * Parses the pinned `exec --json` stdout, which prints one `Event` per line
 * (`{"id":…,"msg":{"type":…}}`; `exec/src/event_processor_with_json_output.rs`).
 * The config-summary and prompt lines carry no `msg.type` and are ignored, as
 * are non-JSON lines.
 */
function parseClientEvents(stdoutText: string): ClientEvent[] {
  const events: ClientEvent[] = [];
  for (const line of stdoutText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    ) {
      continue;
    }
    const msg = (parsed as Record<string, unknown>).msg;
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) continue;
    const type = (msg as Record<string, unknown>).type;
    if (typeof type !== "string") continue;
    const message = (msg as Record<string, unknown>).message;
    events.push({ type, message: typeof message === "string" ? message : "" });
  }
  return events;
}

/**
 * Why the child process itself does not prove a normal successful turn. The
 * pinned `exec` exits 0 even when a turn fails (`core/src/codex.rs:1866`,
 * `exec/src/lib.rs:295`), so the exit code alone is never sufficient: stdout
 * must carry a parsed non-empty `agent_message` and no `error` event.
 */
function clientFailureReason(client: LiveSmokeClientResult): string | null {
  if (client.timedOut) return "client-timeout";
  if (client.exitCode !== 0) return "client-exit-not-zero";
  const events = parseClientEvents(client.stdoutText);
  if (events.some((event) => event.type === "error")) {
    return "client-error-event";
  }
  const hasAssistant = events.some((event) =>
    event.type === "agent_message" && event.message.trim() !== ""
  );
  if (!hasAssistant) return "client-no-assistant-message";
  return null;
}

/** Provider auth is the existing `env_key` mechanism: the value stays in-process. */
function clientEnv(
  home: string,
  tmpRoot: string,
  token: string,
): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    TMPDIR: tmpRoot,
    CODEX_HOME: home,
    [CREDENTIAL_ENV]: token,
  };
}

/** `-c` values are TOML (`common/src/config_override.rs:65,135`), not JSON. */
function tomlInlineTable(
  entries: Record<string, string | number | boolean>,
): string {
  const parts = Object.entries(entries).map(([key, value]) =>
    typeof value === "string"
      ? `${key} = ${JSON.stringify(value)}`
      : `${key} = ${String(value)}`
  );
  return `{ ${parts.join(", ")} }`;
}

function configArgs(boundary: LunaBoundary, effort: string): string[] {
  const provider = tomlInlineTable({
    name: "luna_smoke",
    base_url: boundary.baseUrl,
    env_key: CREDENTIAL_ENV,
    wire_api: "responses",
    requires_openai_auth: false,
    request_max_retries: 0,
    stream_max_retries: 0,
    stream_idle_timeout_ms: 120_000,
  });
  return [
    "-c",
    `model_provider=${JSON.stringify("luna_smoke")}`,
    "-c",
    `model=${JSON.stringify(LUNA_MODEL)}`,
    "-c",
    `model_reasoning_effort=${JSON.stringify(effort)}`,
    "-c",
    `model_providers.luna_smoke=${provider}`,
  ];
}

async function runClient(
  binaryPath: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number,
): Promise<LiveSmokeClientResult> {
  const argv = [
    ...binaryPrefix(binaryPath),
    "--skip-git-repo-check",
    "-C",
    cwd,
    "--json",
    ...args,
  ];
  const command = new Deno.Command(argv[0], {
    args: argv.slice(1),
    cwd,
    env,
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited; the real status is preserved below.
    }
  }, timeoutMs);
  try {
    const output = await child.output();
    return {
      argv,
      exitCode: output.code,
      timedOut,
      stdoutText: new TextDecoder().decode(output.stdout),
      stderrText: new TextDecoder().decode(output.stderr),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs the bounded smoke. Returns only allowlisted structural data; the caller
 * decides how to print it. Never throws for a blocked or failed run.
 */
export async function runLunaLiveSmoke(
  options: LiveSmokeOptions,
): Promise<LiveSmokeResult> {
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const upstreamBaseUrl = options.upstreamBaseUrl ?? UOS_ENDPOINT_DEFAULT;
  const tmpRoot = await Deno.makeTempDir({ prefix: "m3-luna-smoke-" });
  const home = `${tmpRoot}/codex-home`;
  const cwd = `${tmpRoot}/workdir`;
  await Deno.mkdir(home, { recursive: true });
  await Deno.mkdir(cwd, { recursive: true });

  async function openBoundary(): Promise<LunaBoundary> {
    // The pinned client canonicalizes `-C` (`exec/src/lib.rs:156`), so the
    // expected `<cwd>` is the real path of this run's freshly created temp
    // workdir. This fixture is built here, in memory only: no environment
    // variable, CLI flag, or request body can supply or change it.
    const expectedEnvironmentContext: LunaEnvironmentContextFixture = {
      cwd: await Deno.realPath(cwd),
      approvalPolicy: ENV_CONTEXT_APPROVAL_POLICY,
      sandboxMode: ENV_CONTEXT_SANDBOX_MODE,
      networkAccess: ENV_CONTEXT_NETWORK_ACCESS,
    };
    try {
      return await startLunaBoundary({
        upstreamBaseUrl,
        token: options.token,
        allowedInputTexts: [SYNTHETIC_PROMPT, SYNTHETIC_PROMPT_FALLBACK],
        environmentContext: expectedEnvironmentContext,
        fetchImpl: options.boundaryFetchImpl,
        requestTimeoutMs,
      });
    } catch (error) {
      await Deno.remove(tmpRoot, { recursive: true }).catch(() => {});
      throw error;
    }
  }

  const boundary = await openBoundary();

  const result: LiveSmokeResult = {
    status: "FAIL",
    reason: "not-run",
    model: LUNA_MODEL,
    metadata: {
      requests: boundary.state.metadataRequests,
      status: boundary.state.metadataStatus,
      slugs: boundary.state.metadataSlugs,
      gate: boundary.state.slugGate,
    },
    attempts: boundary.state.attempts,
    client: {
      binaryPath: options.binaryPath,
      mode: isExecOnlyBinary(options.binaryPath) ? "exec-only" : "multitool",
      invocations: 0,
    },
    credentialPresence: { [CREDENTIAL_ENV]: options.token.length > 0 },
    redaction: { tokenAbsentFromState: boundary.tokenAbsentFromState() },
    budgets: {
      maxMetadataRequests: MAX_METADATA_REQUESTS,
      maxInferenceAttempts: MAX_INFERENCE_ATTEMPTS,
      retries: 0,
      requestTimeoutMs,
    },
  };

  const env = clientEnv(home, tmpRoot, options.token);
  const run = options.runClientImpl ??
    ((args: string[], childEnv: Record<string, string>, childCwd: string) =>
      runClient(
        options.binaryPath,
        args,
        childEnv,
        childCwd,
        requestTimeoutMs + CHILD_TIMEOUT_MARGIN_MS,
      ));

  async function invoke(args: string[]): Promise<LiveSmokeClientResult | null> {
    result.client.invocations += 1;
    try {
      return await run(args, env, cwd);
    } catch {
      return null;
    }
  }

  try {
    /* §2.1 exact-slug gate: one metadata GET, immediately before inference. */
    const metadataResponse = await fetch(`${boundary.origin}${MODELS_PATH}`, {
      signal: AbortSignal.timeout(requestTimeoutMs),
    }).catch(() => null);
    if (metadataResponse === null) {
      result.reason = "metadata-transport-error";
      result.status = "BLOCKED";
      return result;
    }
    result.metadata = {
      requests: boundary.state.metadataRequests,
      status: boundary.state.metadataStatus,
      slugs: boundary.state.metadataSlugs,
      gate: boundary.state.slugGate,
    };
    if (boundary.state.slugGate !== "present") {
      result.status = "BLOCKED";
      result.reason = boundary.state.metadataStatus === 200
        ? "exact-slug-absent"
        : "metadata-not-ok";
      return result;
    }

    /* Attempt 1: reasoning none. */
    const first = await invoke([
      ...configArgs(boundary, LUNA_EFFORT_FIRST),
      SYNTHETIC_PROMPT,
    ]);
    result.attempts = boundary.state.attempts;
    if (first === null) {
      result.status = "FAIL";
      result.reason = "client-spawn-error";
      return result;
    }

    if (attemptsForwarded(boundary.state) === 0) {
      // A client that cannot parse `none` is not provider enforcement. Report
      // the classification, FAIL, and leave the `low` phase locked.
      const clientRejection = classifyNoneConfigRejection(
        first.stdoutText + first.stderrText,
      );
      result.status = "FAIL";
      result.reason = clientRejection ??
        (first.timedOut
          ? "attempt-1-timeout-no-request"
          : "no-inference-request");
      return result;
    }

    const firstAttempt =
      boundary.state.attempts[boundary.state.attempts.length - 1];
    const firstAttemptRejection = attemptRejectionReason(firstAttempt);
    if (firstAttemptRejection === null) {
      // The upstream accepted `none` with the exact model; PASS still requires
      // the child itself to prove a normal successful turn.
      const clientRejection = clientFailureReason(first);
      if (clientRejection === null) {
        result.status = "PASS";
        result.reason = "none-accepted";
      } else {
        result.status = "FAIL";
        result.reason = phaseFailure("none", clientRejection);
      }
      return result;
    }

    if (!boundary.state.noneRejected) {
      // No provider enforcement of `none`: FAIL here and never attempt `low`.
      // A 2xx that is not an exact successful completion gets its explicit
      // structural reason (missing/mismatched model, malformed completed
      // event, failure status) instead of a generic rejection class.
      const upstreamAnswered = firstAttempt !== undefined &&
        firstAttempt.upstreamStatus !== null &&
        firstAttempt.upstreamStatus >= 200 &&
        firstAttempt.upstreamStatus < 300;
      result.status = "FAIL";
      result.reason =
        boundary.state.violations.includes("upstream-transport-error")
          ? "none-attempt-transport-error"
          : upstreamAnswered
          ? phaseFailure("none", firstAttemptRejection)
          : "none-rejected-without-explicit-signal";
      return result;
    }

    /* Attempt 2: reasoning low, only after the upstream itself rejected none. */
    if (
      !boundary.state.noneRejected ||
      boundary.state.noneRejectionClass !== "provider-rejected-none"
    ) {
      result.status = "FAIL";
      result.reason = "low-without-provider-none-rejection";
      return result;
    }
    const second = await invoke([
      ...configArgs(boundary, LUNA_EFFORT_FALLBACK),
      SYNTHETIC_PROMPT_FALLBACK,
    ]);
    result.attempts = boundary.state.attempts;
    if (second === null) {
      result.status = "FAIL";
      result.reason = "client-spawn-error";
      return result;
    }

    const secondAttempt =
      boundary.state.attempts[boundary.state.attempts.length - 1];
    if (attemptsForwarded(boundary.state) < 2 || secondAttempt?.attempt !== 2) {
      result.status = "FAIL";
      result.reason = "low-attempt-not-forwarded";
      return result;
    }
    const lowAttemptRejection = attemptRejectionReason(secondAttempt);
    if (lowAttemptRejection !== null) {
      result.status = "FAIL";
      result.reason = phaseFailure("low", lowAttemptRejection);
      return result;
    }
    const lowClientRejection = clientFailureReason(second);
    if (lowClientRejection !== null) {
      result.status = "FAIL";
      result.reason = phaseFailure("low", lowClientRejection);
      return result;
    }
    result.status = "PASS";
    result.reason = "low-accepted-after-none-rejection";
    return result;
  } finally {
    result.attempts = boundary.state.attempts;
    result.redaction = {
      tokenAbsentFromState: boundary.tokenAbsentFromState(),
    };
    await boundary.stop();
    await Deno.remove(tmpRoot, { recursive: true }).catch(() => {});
  }
}

if (import.meta.main) {
  // Explicit invocation only: importing this module never runs the smoke.
  const token = Deno.env.get(CREDENTIAL_ENV);
  if (token === undefined || token.length === 0) {
    console.log(
      JSON.stringify({
        status: "BLOCKED",
        reason: "missing-credential",
        variable: CREDENTIAL_ENV,
      }),
    );
    Deno.exit(2);
  }
  const outcome = await runLunaLiveSmoke({
    token,
    binaryPath: forkBinaryPath(),
  });
  console.log(JSON.stringify(outcome));
  Deno.exit(
    outcome.status === "PASS" ? 0 : outcome.status === "BLOCKED" ? 2 : 1,
  );
}
