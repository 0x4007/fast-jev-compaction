/**
 * Real pinned-client harness (M2-RC) — drives the compiled fork client, not a
 * TypeScript double.
 *
 * Scope and honesty rules:
 * - The binary is supplied by the caller (`binaryPath`); `forkBinaryPath()`
 *   returns the fixed path recorded in the completion handoff, resolved
 *   relative to this repository. This module never reads an environment
 *   variable, never adds a CLI flag, and never locates, downloads, or falls
 *   back to an installed `codex`; a missing binary is a hard error, never a
 *   silent skip.
 * - The child runs with a cleared environment containing only `PATH`, `HOME`,
 *   `TMPDIR`, `CODEX_HOME`, and the existing recognized `UOS_AI_TOKEN` holding
 *   the synthetic loopback sentinel (`TEST_SENTINEL`) — never a real
 *   credential. The loopback mock rejects every other authorization value,
 *   which is the positive credential-free proof.
 *
 * CLI contracts verified against the immutable pin
 * (`vendor/codex` @ 5c583fe89bbd3ab4dc9a05768299f94e52fe8452):
 * - `codex exec` / `codex-exec` accept `-c key=value` dotted overrides
 *   (`codex-rs/common/src/config_override.rs:19`), `-C`, `--skip-git-repo-check`,
 *   `--json`, and a positional prompt (`codex-rs/exec/src/cli.rs:8`).
 * - `exec resume <SESSION_ID> <PROMPT>` continues a recorded session
 *   (`codex-rs/exec/src/cli.rs:77`, `codex-rs/exec/tests/suite/resume.rs`).
 * - `resume <SESSION_ID>` resolves the rollout with a fuzzy file search over
 *   `<CODEX_HOME>/sessions` (`core/src/rollout/list.rs:345`,
 *   `file-search/src/lib.rs:124`). The fork's adjacent
 *   `<rollout>.working-set.jsonl` audit sidecar repeats the session UUID in its
 *   name, so that search can return the sidecar and `get_rollout_history` then
 *   fails with `failed to parse conversation ID from rollout file`
 *   (`core/src/rollout/recorder.rs:262`). That is a product defect in the
 *   fork's rollout lookup, fixed there by accepting only a canonical
 *   `rollout-<timestamp>-<uuid>.jsonl` whose embedded UUID equals the requested
 *   id (`core/src/rollout/list.rs`). This harness deliberately installs **no**
 *   `<CODEX_HOME>/sessions/.ignore` rule and no other exclusion: a harness-only
 *   ignore rule would mask the defect instead of exercising the product fix.
 *   The sidecar stays at its canonical adjacent path purely for observation,
 *   and a client that still resolves it makes the resume tests fail with the
 *   bounded diagnosis below. The pin consumes `session_configured` in
 *   `ConversationManager::finalize_spawn` and never prints it
 *   (`core/src/conversation_manager.rs:77-86`), so harness reads never guess a
 *   lexicographic newest path either: the rollout is selected by validated
 *   discovery, where exactly one discovered rollout must carry a full-UUID
 *   `session_meta.payload.id` and any ambiguity is a hard error naming every
 *   candidate path and structural id.
 * - A provider with `env_key` + `requires_openai_auth = false` sends
 *   `Authorization: Bearer <env value>` (`core/src/model_provider_info.rs:100`).
 * - `CODEX_HOME` isolates rollouts under `<home>/sessions/YYYY/MM/DD/*.jsonl`
 *   (`core/src/rollout/recorder.rs:314`, `core/src/config.rs:1127`).
 * - A turn error emits `error` then `task_complete` and `exec` still exits 0
 *   (`core/src/codex.rs:1866`, `codex-rs/exec/src/lib.rs:295`), so callers must
 *   assert the error event and preserved history, and only record the exit code.
 */

import { assert } from "./assert.ts";
import { PIN_SHA, TEST_SENTINEL } from "./fixtures.ts";
import {
  type MockResponsesServer,
  type Scenario,
  startMockResponsesServer,
} from "./mock-responses-server.ts";

/** Synthetic model slug sent to the mock. Never a real provider model. */
export const HARNESS_MODEL = "m2-harness-synthetic-model";
/** Synthetic provider id used by the `-c` overrides. */
export const HARNESS_PROVIDER = "m2_harness";
/**
 * Existing recognized credential variable — no new interface is added. The
 * child receives it only in the cleared environment and only holding the
 * synthetic loopback sentinel.
 */
export const HARNESS_AUTH_ENV = "UOS_AI_TOKEN";
export const HARNESS_TURN_TIMEOUT_MS = 90_000;

/**
 * Adjacent append-only working-set audit sidecar suffix. The sidecar shares its
 * base name with the rollout it belongs to and is never a rollout, a
 * conversation, or a resumable session file.
 */
export const WORKING_SET_SIDECAR_SUFFIX = ".working-set.jsonl";

/**
 * Client error when its fuzzy `resume <id>` lookup picked a non-rollout file
 * such as the adjacent working-set sidecar (`core/src/rollout/recorder.rs:262`).
 */
const RESUME_ROLLOUT_PARSE_ERROR =
  "failed to parse conversation ID from rollout file";

/**
 * Fixed repo-relative path recorded for the compiled fork binary:
 * `codex-exec` of the m01-client fork worktree
 * (`.codex-worktrees/completion-handoff-2026-09-18-m01-client-a788f68d68d`),
 * built from `vendor/codex` @ `PIN_SHA`. No environment variable and no CLI
 * flag selects it.
 */
export const FORK_BINARY_REPO_RELATIVE_PATH =
  "../../codex/.codex-worktrees/completion-handoff-2026-09-18-m01-client-a788f68d68d/codex-rs/target/debug/codex-exec";

/** Repository root derived from this module's own URL (no env, no cwd). */
const REPO_ROOT_URL = new URL("../../", import.meta.url);

/** Absolute path of the fixed recorded fork binary. */
export function forkBinaryPath(): string {
  return decodeURIComponent(
    new URL(FORK_BINARY_REPO_RELATIVE_PATH, REPO_ROOT_URL).pathname,
  );
}

const FALLBACK_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export class PinnedClientHarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinnedClientHarnessError";
  }
}

export interface JsonObject {
  [key: string]: unknown;
}

export interface RolloutRecord {
  raw: string;
  parsed: JsonObject | null;
}

/** Sidecar record tags: every line is `{record:"selection"|"turn",...}`. */
export type WorkingSetSidecarTag = "selection" | "turn";

/**
 * One parsed line of the append-only working-set sidecar the real client writes
 * beside its rollout (`<rollout>.working-set.jsonl`). The reader keeps the
 * verbatim line and never skips an unusable one.
 */
export interface WorkingSetSidecarEntry {
  /** Zero-based position among parsed records, in file order. */
  index: number;
  /** 1-based physical line number in the sidecar file. */
  line: number;
  raw: string;
  tag: WorkingSetSidecarTag;
  record: JsonObject;
}

export interface TurnResult {
  argv: string[];
  exitCode: number | null;
  success: boolean;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** Parsed `--json` event lines only; the config summary lines are excluded. */
  events: JsonObject[];
  errorEvents: { type: string; message: string }[];
}

export interface PinnedClientHarness {
  readonly binaryPath: string;
  readonly mock: MockResponsesServer;
  readonly home: string;
  readonly cwd: string;
  /** Names only; values are never read back out of the child environment. */
  readonly childEnvNames: string[];
  runTurn(prompt: string): Promise<TurnResult>;
  resumeTurn(sessionId: string, prompt: string): Promise<TurnResult>;
  rolloutPaths(): Promise<string[]>;
  /** Validated exact rollout path; never a lexicographic newest guess. */
  selectedRolloutPath(): Promise<string>;
  rolloutBytes(): Promise<string>;
  rolloutRecords(): Promise<RolloutRecord[]>;
  /** Adjacent `<rollout>.working-set.jsonl` path for the selected rollout. */
  sidecarPath(): Promise<string>;
  sidecarBytes(): Promise<string>;
  sidecarEntries(): Promise<WorkingSetSidecarEntry[]>;
  sessionId(): Promise<string>;
  stop(): Promise<void>;
}

export interface PinnedClientHarnessOptions {
  binaryPath: string;
  scenario: Scenario;
  turnTimeoutMs?: number;
  /** Keep the temp home/cwd for inspection instead of deleting it. */
  keepArtifacts?: boolean;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Full conversation UUID shape required by the pin's `resume <id>` lookup. */
const CONVERSATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True only for a full UUID. `resume <SESSION_ID>` resolves a rollout only when
 * `Uuid::parse_str` accepts the id (`core/src/rollout/list.rs:345-352`) and the
 * rollout's `session_meta.payload.id` is that same UUID; a truncated or
 * rewritten id can never name a recorded session.
 */
export function isFullConversationId(value: unknown): value is string {
  return typeof value === "string" && CONVERSATION_ID_PATTERN.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inheritedPath(): string {
  try {
    return Deno.env.get("PATH") ?? FALLBACK_PATH;
  } catch {
    return FALLBACK_PATH;
  }
}

/**
 * Resolve the compiled binary from the explicit argument (the test entry passes
 * the fixed recorded `forkBinaryPath()`). Never reads an environment variable
 * and never resolves an installed `codex`.
 */
export function resolvePinnedClientBinaryPath(explicitPath?: string): string {
  if (explicitPath !== undefined && explicitPath.trim() !== "") {
    return explicitPath;
  }
  throw new PinnedClientHarnessError(
    "no pinned client binary supplied: pass the fixed recorded fork path from forkBinaryPath() " +
      `(${FORK_BINARY_REPO_RELATIVE_PATH}) built from vendor/codex @ ${PIN_SHA}. ` +
      "This harness never reads an environment variable, never substitutes an installed codex, and never substitutes a TypeScript double.",
  );
}

function assertExecutableFile(path: string): void {
  let stat: Deno.FileInfo;
  try {
    stat = Deno.statSync(path);
  } catch (error) {
    throw new PinnedClientHarnessError(
      `client binary not found at ${path}: ${errorMessage(error)}`,
    );
  }
  if (!stat.isFile) {
    throw new PinnedClientHarnessError(
      `client binary is not a regular file: ${path}`,
    );
  }
}

/** `codex-exec` is the exec-only binary and takes no `exec` subcommand. */
function isExecOnlyBinary(binaryPath: string): boolean {
  const base = binaryPath.split("/").pop() ?? binaryPath;
  return base.startsWith("codex-exec");
}

function binaryPrefix(binaryPath: string): string[] {
  return isExecOnlyBinary(binaryPath) ? [binaryPath] : [binaryPath, "exec"];
}

/**
 * `-c key=value` parses `<value>` as TOML, not JSON
 * (`common/src/config_override.rs:65,135`), so provider tables use TOML inline
 * syntax. Zero retries and a short stream idle timeout keep every case bounded.
 */
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

function configArgs(
  mock: MockResponsesServer,
  extraConfig: string[],
): string[] {
  const provider = tomlInlineTable({
    name: HARNESS_PROVIDER,
    base_url: mock.baseUrl,
    env_key: HARNESS_AUTH_ENV,
    wire_api: "responses",
    requires_openai_auth: false,
    request_max_retries: 0,
    stream_max_retries: 0,
    stream_idle_timeout_ms: 5_000,
  });
  return [
    "-c",
    `model_provider=${JSON.stringify(HARNESS_PROVIDER)}`,
    "-c",
    `model=${JSON.stringify(HARNESS_MODEL)}`,
    "-c",
    `model_providers.${HARNESS_PROVIDER}=${provider}`,
    ...extraConfig,
  ];
}

/** Parses `--json` stdout, keeping only real event lines (config summary excluded). */
export function parseEventLines(stdout: string): JsonObject[] {
  const events: JsonObject[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isJsonObject(parsed)) continue;
    const msg = parsed.msg;
    if (isJsonObject(msg) && typeof msg.type === "string") events.push(parsed);
  }
  return events;
}

function errorEventsOf(
  events: JsonObject[],
): { type: string; message: string }[] {
  const found: { type: string; message: string }[] = [];
  for (const event of events) {
    const msg = event.msg;
    if (!isJsonObject(msg) || msg.type !== "error") continue;
    found.push({
      type: "error",
      message: typeof msg.message === "string" ? msg.message : "",
    });
  }
  return found;
}

/**
 * Recursively lists rollout `.jsonl` files under `<home>/sessions`, excluding
 * the adjacent `<rollout>.working-set.jsonl` sidecars.
 */
export async function rolloutPathsIn(home: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const entry of Deno.readDir(dir)) entries.push(entry);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(path);
      } else if (
        entry.isFile && entry.name.endsWith(".jsonl") &&
        // The working-set sidecar is adjacent to its rollout and also ends in
        // `.jsonl`; it is never a rollout and must never be selected as one.
        !entry.name.endsWith(WORKING_SET_SIDECAR_SUFFIX)
      ) {
        found.push(path);
      }
    }
  }
  await walk(`${home}/sessions`);
  return found.sort();
}

/** Rollout lines: `{"timestamp":…,"type":…,"payload":…}` (RolloutLine, flattened). */
export function parseRollout(text: string): RolloutRecord[] {
  const records: RolloutRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: JsonObject | null = null;
    try {
      const candidate: unknown = JSON.parse(line);
      parsed = isJsonObject(candidate) ? candidate : null;
    } catch {
      parsed = null;
    }
    records.push({ raw: line, parsed });
  }
  return records;
}

export function sessionMetaId(records: RolloutRecord[]): string | null {
  for (const record of records) {
    if (record.parsed?.type !== "session_meta") continue;
    const payload = record.parsed.payload;
    if (isJsonObject(payload) && typeof payload.id === "string") {
      return payload.id;
    }
  }
  return null;
}

export function responseItems(records: RolloutRecord[]): unknown[] {
  const items: unknown[] = [];
  for (const record of records) {
    if (record.parsed?.type !== "response_item") continue;
    items.push(record.parsed.payload);
  }
  return items;
}

/**
 * The sidecar is adjacent to its rollout and shares the base name, with the
 * trailing `.jsonl` replaced by `.working-set.jsonl`.
 */
export function workingSetSidecarPath(rolloutPath: string): string {
  if (!rolloutPath.endsWith(".jsonl")) {
    throw new PinnedClientHarnessError(
      `rollout path does not end in .jsonl: ${rolloutPath}`,
    );
  }
  return `${
    rolloutPath.slice(0, -".jsonl".length)
  }${WORKING_SET_SIDECAR_SUFFIX}`;
}

/**
 * Parses the append-only `{record:"selection"|"turn",...}` JSONL sidecar.
 * Malformed, non-object, and untagged lines are hard errors: the reader never
 * skips a line into a false pass.
 */
export function parseWorkingSetSidecar(text: string): WorkingSetSidecarEntry[] {
  const entries: WorkingSetSidecarEntry[] = [];
  const lines = text.split("\n");
  for (let position = 0; position < lines.length; position++) {
    const raw = lines[position];
    if (raw.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new PinnedClientHarnessError(
        `working-set sidecar line ${position + 1} is not JSON: ${
          errorMessage(error)
        }`,
      );
    }
    if (!isJsonObject(parsed)) {
      throw new PinnedClientHarnessError(
        `working-set sidecar line ${position + 1} is not a JSON object`,
      );
    }
    const tag = parsed.record;
    if (tag !== "selection" && tag !== "turn") {
      throw new PinnedClientHarnessError(
        `working-set sidecar line ${position + 1} has no known record tag: ${
          JSON.stringify(tag)
        }`,
      );
    }
    entries.push({
      index: entries.length,
      line: position + 1,
      raw,
      tag,
      record: parsed,
    });
  }
  return entries;
}

/** Selection records in file (append) order. */
export function sidecarSelections(
  entries: WorkingSetSidecarEntry[],
): WorkingSetSidecarEntry[] {
  return entries.filter((entry) => entry.tag === "selection");
}

/** Turn records in file (append) order. */
export function sidecarTurns(
  entries: WorkingSetSidecarEntry[],
): WorkingSetSidecarEntry[] {
  return entries.filter((entry) => entry.tag === "turn");
}

export async function createPinnedClientHarness(
  options: PinnedClientHarnessOptions,
): Promise<PinnedClientHarness> {
  assertExecutableFile(options.binaryPath);

  const mock = await startMockResponsesServer(options.scenario);
  const tmpRoot = await Deno.makeTempDir({ prefix: "m2-real-client-" });
  const home = `${tmpRoot}/codex-home`;
  const cwd = `${tmpRoot}/workdir`;
  await Deno.mkdir(home, { recursive: true });
  await Deno.mkdir(cwd, { recursive: true });
  // The fork's append-only audit sidecar stays at its canonical adjacent path
  // under this sessions dir, so tests observe exactly what the client wrote.
  // No `.ignore` rule, rename, or relocation is installed: the fuzzy
  // `resume <uuid>` lookup must itself select the canonical rollout, never the
  // same-UUID sidecar (`file-search/src/lib.rs:153`).
  await Deno.mkdir(`${home}/sessions`, { recursive: true });

  const childEnv: Record<string, string> = {
    PATH: inheritedPath(),
    HOME: home,
    TMPDIR: tmpRoot,
    CODEX_HOME: home,
    [HARNESS_AUTH_ENV]: TEST_SENTINEL,
  };
  assert(
    childEnv[HARNESS_AUTH_ENV] === TEST_SENTINEL,
    "the child credential variable must hold only the synthetic loopback sentinel",
  );
  const turnTimeoutMs = options.turnTimeoutMs ?? HARNESS_TURN_TIMEOUT_MS;

  async function runProcess(argv: string[]): Promise<TurnResult> {
    const command = new Deno.Command(argv[0], {
      args: argv.slice(1),
      cwd,
      env: childEnv,
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
        // The process already exited; the collected status stays the real one.
      }
    }, turnTimeoutMs);
    try {
      const output = await child.output();
      const stdout = new TextDecoder().decode(output.stdout);
      const stderr = new TextDecoder().decode(output.stderr);
      const events = parseEventLines(stdout);
      return {
        argv,
        exitCode: output.code,
        success: output.success,
        timedOut,
        stdout,
        stderr,
        events,
        errorEvents: errorEventsOf(events),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Bounded, text-free diagnosis of every discovered rollout candidate: exact
   * paths plus their `session_meta.payload.id`. It never includes prompts,
   * assistant text, or any file body.
   */
  async function rolloutDiagnosis(): Promise<string> {
    const paths = await rolloutPathsIn(home);
    if (paths.length === 0) {
      return `no rollout .jsonl file under ${home}/sessions`;
    }
    const parts: string[] = [];
    for (const path of paths) {
      let id: string | null = null;
      try {
        id = sessionMetaId(parseRollout(await Deno.readTextFile(path)));
      } catch {
        parts.push(`${path} (unreadable)`);
        continue;
      }
      parts.push(`${path} session_meta.payload.id=${JSON.stringify(id)}`);
    }
    return parts.join("; ");
  }

  /**
   * The exact rollout path of this harness's session.
   *
   * Never a lexicographic newest guess. Discovery collects every rollout
   * `.jsonl` that is not a working-set sidecar, and the selection is accepted
   * only when exactly one candidate carries a full UUID
   * `session_meta.payload.id`. Zero candidates (no rollout yet, or only empty
   * or malformed files) and several valid sessions are both hard errors naming
   * every candidate path and structural id.
   */
  async function selectedRolloutPath(): Promise<string> {
    const candidates: string[] = [];
    for (const path of await rolloutPathsIn(home)) {
      let id: string | null;
      try {
        id = sessionMetaId(parseRollout(await Deno.readTextFile(path)));
      } catch {
        // Unreadable candidates cannot carry a validated id; the diagnosis
        // below still reports them explicitly as unreadable.
        continue;
      }
      if (isFullConversationId(id)) candidates.push(path);
    }
    if (candidates.length === 1) return candidates[0];
    throw new PinnedClientHarnessError(
      `expected exactly one recorded session rollout: found ` +
        `${candidates.length} rollout(s) carrying a full session_meta.payload.id; ` +
        `candidates: ${await rolloutDiagnosis()}`,
    );
  }

  async function rolloutBytes(): Promise<string> {
    return await Deno.readTextFile(await selectedRolloutPath());
  }

  async function rolloutRecords(): Promise<RolloutRecord[]> {
    return parseRollout(await rolloutBytes());
  }

  async function sidecarPath(): Promise<string> {
    return workingSetSidecarPath(await selectedRolloutPath());
  }

  async function sidecarBytes(): Promise<string> {
    const path = await sidecarPath();
    try {
      return await Deno.readTextFile(path);
    } catch (error) {
      throw new PinnedClientHarnessError(
        `no readable working-set sidecar at ${path}: ${errorMessage(error)}`,
      );
    }
  }

  async function sidecarEntries(): Promise<WorkingSetSidecarEntry[]> {
    return parseWorkingSetSidecar(await sidecarBytes());
  }

  async function sessionId(): Promise<string> {
    const path = await selectedRolloutPath();
    const id = sessionMetaId(parseRollout(await Deno.readTextFile(path)));
    if (!isFullConversationId(id)) {
      throw new PinnedClientHarnessError(
        `rollout ${JSON.stringify(path)} has no full session_meta.payload.id: ${
          JSON.stringify(id)
        }`,
      );
    }
    return id;
  }

  /**
   * Bounded pre-flight for `resume <SESSION_ID>`: the exact selected rollout,
   * its structural id, and the adjacent sidecar path are checked before the
   * client runs. Any mismatch throws a bounded diagnosis carrying those exact
   * paths and ids (never prompt or assistant text). No sidecar-exclusion rule
   * is installed, so the resume itself exercises the product lookup: a client
   * that resolves the sidecar fails in `resumeTurn` with the same diagnosis.
   */
  async function assertResumeTarget(requested: string): Promise<void> {
    const path = await selectedRolloutPath();
    const id = sessionMetaId(parseRollout(await Deno.readTextFile(path)));
    const sidecar = workingSetSidecarPath(path);
    let sidecarPresent = false;
    try {
      sidecarPresent = (await Deno.stat(sidecar)).isFile;
    } catch {
      sidecarPresent = false;
    }
    const diagnosis = `selected rollout=${JSON.stringify(path)}, ` +
      `session_meta.payload.id=${JSON.stringify(id)}, ` +
      `requested session=${JSON.stringify(requested)}, ` +
      `adjacent sidecar=${
        JSON.stringify(sidecar)
      } present=${sidecarPresent}, ` +
      `candidates: ${await rolloutDiagnosis()}`;
    if (!isFullConversationId(requested) || id !== requested) {
      throw new PinnedClientHarnessError(
        `resume target diagnosis failed: ${diagnosis}`,
      );
    }
  }

  return {
    binaryPath: options.binaryPath,
    mock,
    home,
    cwd,
    childEnvNames: Object.keys(childEnv).sort(),
    runTurn: (prompt: string): Promise<TurnResult> =>
      runProcess([
        ...binaryPrefix(options.binaryPath),
        "--skip-git-repo-check",
        "-C",
        cwd,
        "--json",
        ...configArgs(mock, []),
        prompt,
      ]),
    resumeTurn: async (
      sessionIdValue: string,
      prompt: string,
    ): Promise<TurnResult> => {
      await assertResumeTarget(sessionIdValue);
      const result = await runProcess([
        ...binaryPrefix(options.binaryPath),
        "--skip-git-repo-check",
        "-C",
        cwd,
        "--json",
        ...configArgs(mock, []),
        "resume",
        sessionIdValue,
        prompt,
      ]);
      // Bounded post-failure diagnosis: if the client still resolved a
      // non-rollout file (the product lookup defect this harness deliberately
      // does not mask), surface the exact candidate paths and structural ids
      // (never prompt or assistant text) instead of only the raw stderr.
      if (
        result.stderr.includes(RESUME_ROLLOUT_PARSE_ERROR) ||
        result.stdout.includes(RESUME_ROLLOUT_PARSE_ERROR)
      ) {
        throw new PinnedClientHarnessError(
          `resume ${JSON.stringify(sessionIdValue)} could not resolve its ` +
            `recorded rollout; client stderr: ` +
            `${JSON.stringify(result.stderr.trim())}; candidates: ` +
            `${await rolloutDiagnosis()}`,
        );
      }
      return result;
    },
    rolloutPaths: () => rolloutPathsIn(home),
    selectedRolloutPath,
    rolloutBytes,
    rolloutRecords,
    sidecarPath,
    sidecarBytes,
    sidecarEntries,
    sessionId,
    stop: async () => {
      await mock.stop();
      if (!options.keepArtifacts) {
        await Deno.remove(tmpRoot, { recursive: true }).catch(() => {});
      }
    },
  };
}

/**
 * Asserts the child environment carries no credential-shaped variable other
 * than the recognized sentinel holder, whose value is asserted to be the
 * synthetic `TEST_SENTINEL` when the child environment is built.
 */
export function assertCredentialFreeEnv(names: string[]): void {
  const allowed = new Set([
    "PATH",
    "HOME",
    "TMPDIR",
    "CODEX_HOME",
    HARNESS_AUTH_ENV,
  ]);
  for (const name of names) {
    assert(
      allowed.has(name),
      `child environment carries unexpected variable ${name}`,
    );
  }
  for (const name of names) {
    const credentialShaped = /TOKEN|SECRET|API_KEY|PASSWORD/i.test(name);
    assert(
      !credentialShaped || name === HARNESS_AUTH_ENV,
      `child environment carries credential-shaped variable ${name}`,
    );
  }
}
