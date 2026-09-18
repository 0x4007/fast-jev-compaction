/**
 * Installer-facing end-to-end check for the *installed* Codex Jev adapter.
 *
 * Run against the already-running proxy (fixture transcript):
 *   deno run --allow-net=127.0.0.1 codex/test-cli.ts
 *
 * Inspect a real Codex rollout without any network or Jev call:
 *   deno run --allow-net=127.0.0.1 --allow-read="$HOME/.codex/sessions" \
 *     codex/test-cli.ts --rollout latest
 *
 * Send the extracted rollout through the installed proxy:
 *   deno run --allow-net=127.0.0.1 --allow-read="$HOME/.codex/sessions" \
 *     codex/test-cli.ts --rollout latest --send
 *
 * One compaction request goes to `POST <proxy>/v1/responses` with the exact
 * `x-codex-turn-metadata` header and `{ "stream": true, "input": [...] }` body
 * Codex sends, and the SSE (`response.output_item.done` then
 * `response.completed`) is parsed for the summary. Fixture mode asserts the
 * summary kept the goal marker and dropped all three obsolete markers; rollout
 * dry-run never touches the network and prints structural stats plus a bounded
 * excerpt only.
 *
 * This tool reads no credentials (the installed proxy owns the key), prints no
 * request payload body, no full provider response, and no API key; the only
 * transcript text it can print is the bounded excerpt (dry run) and the
 * <= 400-char summary preview. `--rollout latest` resolves the newest
 * `rollout-*.jsonl` under `$HOME/.codex/sessions` from `$HOME` when granted, or
 * by walking up from this file when the documented `--allow-read` grant alone
 * is present. Session files are only ever read.
 *
 * Exit codes: 0 pass, 1 fail/error.
 */

const DEFAULT_PROXY_ORIGIN = 'http://127.0.0.1:8787';
const DEFAULT_LIMIT = 40;
const DEFAULT_TIMEOUT_MS = 45_000;
const SUMMARY_PREVIEW_CHARS = 400;
const EXCERPT_CHARS = 1_200;

const TURN_METADATA_HEADER = 'x-codex-turn-metadata';
const TURN_METADATA = JSON.stringify({
  request_kind: 'compaction',
  compaction: { implementation: 'responses' },
});
const STRUCTURAL_HEADER = 'x-fast-jev-compaction';

const GOAL_MARKER = 'TESTCLI_ARTIFACT_OK';
const OBSOLETE_MARKERS = ['OLD_BUILD_LOG', 'OLD_METRIC_SCAN', 'OLD_CACHE_LIST'] as const;
const COMPACTION_PROMPT =
  'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM.';

const ROLLOUT_PREFIX = 'rollout-';
const ROLLOUT_SUFFIX = '.jsonl';
const SESSIONS_SUFFIX = '.codex/sessions';

const ROLLOUT_ITEM_TYPES = [
  'message',
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
  'reasoning',
] as const;
const ROLLOUT_ITEM_TYPE_SET = new Set<string>(ROLLOUT_ITEM_TYPES);
const CALL_ITEM_TYPES = new Set(['function_call', 'custom_tool_call']);
const OUTPUT_ITEM_TYPES = new Set(['function_call_output', 'custom_tool_call_output']);
const MESSAGE_ROLES = ['user', 'assistant', 'system', 'developer'] as const;
const MESSAGE_ROLE_SET = new Set<string>(MESSAGE_ROLES);

const SEND_CHECKS = [
  'http-200',
  'request-count-1',
  'structural-header-present',
  'sse-parsable',
  'sse-sequence',
  'sse-completed',
  'summary-present',
] as const;
const FIXTURE_CHECKS = ['goal-marker-kept', 'obsolete-markers-absent'] as const;

const USAGE = [
  'usage: deno run --allow-net=127.0.0.1 [--allow-read="$HOME/.codex/sessions"] codex/test-cli.ts [flags]',
  '',
  '  --fixture          synthetic transcript (default)',
  '  --rollout <path>   Codex rollout JSONL, or "latest" for the newest under $HOME/.codex/sessions',
  '  --send             with --rollout only: send the extracted transcript (default is a strict dry run)',
  '  --proxy <origin>   installed proxy origin (default http://127.0.0.1:8787)',
  '  --json             print one JSON object instead of the human report',
  '  --limit <n>        rollout item cap; the most recent items are kept (default 40)',
  '  --timeout <ms>     whole-request bound (default 45000)',
].join('\n');

type Mode = 'fixture' | 'rollout-dry-run' | 'rollout-send' | 'invalid';

interface CliOptions {
  mode: Mode;
  proxy: string;
  json: boolean;
  limit: number;
  timeoutMs: number;
  rollout: string | null;
}

interface RolloutStats {
  file: string;
  lines_total: number;
  items: number;
  counts: Record<string, number>;
  message_roles: Record<string, number>;
  input_chars: number;
  content_chars: number;
  matched_tool_pairs: number;
  unmatched_calls: number;
  unmatched_outputs: number;
  skipped: Record<string, number>;
  excerpt: string;
}

interface Metrics {
  mode: Mode;
  status: 'PASS' | 'FAIL';
  failure_class: string;
  failure_detail: string;
  proxy_origin: string;
  timeout_ms: number;
  send_attempted: boolean;
  request_count: number;
  http_status: number;
  /** Time until the proxy answered; the proxy answers only after its Jev call settled. */
  jev_request_ms: number;
  /** Time until the SSE body was fully consumed. */
  total_ms: number;
  input_chars: number;
  summary_chars: number;
  ratio: number;
  structural_header: string;
  structural: Record<string, number>;
  checks: Record<string, boolean>;
  summary_preview: string;
  rollout: RolloutStats | null;
  notes: string[];
}

interface SseResult {
  summary: string;
  completed: boolean;
  ordered: boolean;
  error: string | null;
}

class CliError extends Error {
  readonly kind: string;

  constructor(kind: string, detail: string) {
    super(detail);
    this.name = 'CliError';
    this.kind = kind;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserialisable]';
  }
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function clipLine(value: string, limit: number): string {
  return clip(value.replace(/\s+/g, ' ').trim(), limit);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message.slice(0, 160)}`;
  return String(error).slice(0, 160);
}

function newMetrics(options: CliOptions): Metrics {
  return {
    mode: options.mode,
    status: 'FAIL',
    failure_class: 'none',
    failure_detail: '',
    proxy_origin: options.proxy,
    timeout_ms: options.timeoutMs,
    send_attempted: false,
    request_count: 0,
    http_status: 0,
    jev_request_ms: 0,
    total_ms: 0,
    input_chars: 0,
    summary_chars: 0,
    ratio: 0,
    structural_header: '',
    structural: {},
    checks: {},
    summary_preview: '',
    rollout: null,
    notes: [],
  };
}

function fail(metrics: Metrics, failureClass: string, detail = ''): void {
  metrics.status = 'FAIL';
  if (metrics.failure_class === 'none') metrics.failure_class = failureClass;
  if (detail.length > 0 && metrics.failure_detail.length === 0) metrics.failure_detail = detail;
}

function setCheck(metrics: Metrics, name: string, ok: boolean): boolean {
  metrics.checks[name] = ok;
  return ok;
}

function splitFlag(arg: string): [string, string | null] {
  const separator = arg.indexOf('=');
  if (separator <= 0) return [arg, null];
  return [arg.slice(0, separator), arg.slice(separator + 1)];
}

function positiveInt(flag: string, raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliError('bad-args', `${flag} needs a positive integer, got "${raw}"`);
  }
  return parsed;
}

function normalizeProxy(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError('bad-args', `--proxy is not a URL: "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError('bad-args', `--proxy must be an http(s) origin: "${raw}"`);
  }
  if (url.hostname.length === 0) throw new CliError('bad-args', `--proxy has no host: "${raw}"`);
  return url.origin;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let fixture = false;
  let rollout: string | null = null;
  let send = false;
  let proxy = DEFAULT_PROXY_ORIGIN;
  let json = false;
  let limit = DEFAULT_LIMIT;
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = splitFlag(arg);
    const value = (): string => {
      if (inline !== null) return inline;
      index += 1;
      const next: string | undefined = argv[index];
      if (next === undefined) throw new CliError('bad-args', `${flag} needs a value`);
      return next;
    };
    const flagOnly = (): void => {
      if (inline !== null) throw new CliError('bad-args', `${flag} takes no value`);
    };
    switch (flag) {
      case '--fixture':
        flagOnly();
        fixture = true;
        break;
      case '--rollout':
        rollout = value();
        break;
      case '--send':
        flagOnly();
        send = true;
        break;
      case '--proxy':
        proxy = normalizeProxy(value());
        break;
      case '--json':
        flagOnly();
        json = true;
        break;
      case '--limit':
        limit = positiveInt(flag, value());
        break;
      case '--timeout':
        timeoutMs = positiveInt(flag, value());
        break;
      default:
        throw new CliError('bad-args', `unknown argument: "${arg}"`);
    }
  }

  if (fixture && rollout !== null) {
    throw new CliError('bad-args', '--fixture and --rollout are mutually exclusive');
  }
  if (send && rollout === null) {
    throw new CliError('bad-args', '--send is only valid with --rollout');
  }
  const mode: Mode = rollout === null ? 'fixture' : send ? 'rollout-send' : 'rollout-dry-run';
  return { mode, proxy, json, limit, timeoutMs, rollout };
}

/**
 * Fixture transcript in the shape Codex sends: three obsolete matched tool
 * pairs with obvious junk logs before the pinned recent window, one final goal
 * marker, and the trailing Codex compaction prompt.
 */
function fixtureItems(): unknown[] {
  // Each obsolete marker sits past the adapter's 300-char `drop_result` head,
  // and every junk result is longer than headChars + 120 so a truncating
  // decision really truncates. A marker in the summary therefore means Jev kept
  // the obsolete result verbatim, not that a bounded head leaked it.
  const obsolete = (label: string, lines: number): string =>
    `${'superseded build log line; safe to delete. '.repeat(12)}${label} ${
      'obsolete log line; superseded build, safe to delete. '.repeat(lines)
    }`;
  const text = (role: string, value: string) => ({
    type: 'message',
    role,
    content: [{ type: 'input_text', text: value }],
  });
  const call = (callId: string, command: string) => ({
    type: 'function_call',
    call_id: callId,
    name: 'shell',
    arguments: JSON.stringify({ command: ['bash', '-lc', command] }),
  });
  const output = (callId: string, value: string) => ({
    type: 'function_call_output',
    call_id: callId,
    output: value,
  });
  // Entries at indices 2/4/6 are the old calls and 3/5/7 their results: all six
  // sit before the pinned last six messages, so they are Jev's candidates.
  return [
    text('user', 'Goal: finish the widget release notes and keep the final artifact path.'),
    text('assistant', 'Starting with the old build logs.'),
    call('old_build_log', 'tail -n 400 /tmp/old-widget/build-2025.log'),
    output('old_build_log', obsolete('OLD_BUILD_LOG', 40)),
    call('old_metric_scan', 'grep -c deprecated /tmp/old-widget/metrics.csv'),
    output('old_metric_scan', obsolete('OLD_METRIC_SCAN', 30)),
    call('old_cache_list', 'ls -la /tmp/old-widget/cache'),
    output('old_cache_list', obsolete('OLD_CACHE_LIST', 30)),
    text('assistant', 'The old build investigation is finished; those logs are obsolete.'),
    text('user', 'Recent follow-up one: draft the release notes outline.'),
    text('assistant', 'Drafted the outline.'),
    text('user', 'Recent follow-up two: check the artifact marker wording.'),
    text('assistant', 'Checked.'),
    text('user', `Final goal: the release notes artifact is ${GOAL_MARKER}; keep that marker verbatim.`),
    text('user', COMPACTION_PROMPT),
  ];
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw === 'string') {
      parts.push(raw);
      continue;
    }
    const part = asRecord(raw);
    if (!part) continue;
    if (typeof part.text === 'string') parts.push(part.text);
    else if (part.type === 'input_image' || part.type === 'image') parts.push('[image]');
    else if (part.type === 'input_file' || part.type === 'file') parts.push('[file]');
    else if (typeof part.refusal === 'string') parts.push(part.refusal);
  }
  return parts.filter((part) => part.length > 0).join('\n');
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined || output === null) return '[no output]';
  return safeJson(output);
}

type MapResult = { ok: true; item: unknown; role?: string } | { ok: false; reason: string };

/** Conservative rollout -> Codex input item mapping; anything else is skipped. */
function mapRolloutItem(type: string, payload: Record<string, unknown>): MapResult {
  if (type === 'message') {
    const role = text(payload.role);
    if (role.length === 0) return { ok: false, reason: 'missing_fields' };
    if (!MESSAGE_ROLE_SET.has(role)) return { ok: false, reason: 'unsupported_role' };
    const parts: Array<{ type: string; text: string }> = [];
    for (const raw of Array.isArray(payload.content) ? payload.content : []) {
      if (typeof raw === 'string') {
        parts.push({ type: 'input_text', text: raw });
        continue;
      }
      const part = asRecord(raw);
      if (!part) continue;
      if (typeof part.text === 'string') parts.push({ type: 'input_text', text: part.text });
      else if (part.type === 'input_image' || part.type === 'image') {
        parts.push({ type: 'input_text', text: '[image]' });
      } else if (part.type === 'input_file' || part.type === 'file') {
        parts.push({ type: 'input_text', text: '[file]' });
      } else if (typeof part.refusal === 'string') {
        parts.push({ type: 'input_text', text: part.refusal });
      }
    }
    if (parts.length === 0) return { ok: false, reason: 'empty_content' };
    return { ok: true, item: { type: 'message', role, content: parts }, role };
  }
  if (type === 'function_call' || type === 'custom_tool_call') {
    const callId = text(payload.call_id);
    const name = text(payload.name);
    if (callId.length === 0 || name.length === 0) return { ok: false, reason: 'missing_fields' };
    if (type === 'function_call') {
      return {
        ok: true,
        item: { type, name, arguments: outputText(payload.arguments), call_id: callId },
      };
    }
    return { ok: true, item: { type, call_id: callId, name, input: outputText(payload.input) } };
  }
  if (type === 'function_call_output' || type === 'custom_tool_call_output') {
    const callId = text(payload.call_id);
    if (callId.length === 0) return { ok: false, reason: 'missing_fields' };
    return { ok: true, item: { type, call_id: callId, output: outputText(payload.output) } };
  }
  // reasoning is passed through as-is; the proxy renders it as an opaque item.
  return { ok: true, item: { ...payload } };
}

function itemChars(item: Record<string, unknown>): number {
  const type = text(item.type);
  if (type === 'message') return contentText(item.content).length;
  if (type === 'function_call') return text(item.arguments).length;
  if (type === 'custom_tool_call') return text(item.input).length;
  if (type === 'function_call_output' || type === 'custom_tool_call_output') {
    return text(item.output).length;
  }
  return safeJson(item).length;
}

function reasoningText(item: Record<string, unknown>): string {
  if (Array.isArray(item.summary)) {
    const parts = item.summary
      .map((part) => (typeof part === 'string' ? part : text(asRecord(part)?.text)))
      .filter((part) => part.length > 0);
    if (parts.length > 0) return parts.join(' ');
  }
  return typeof item.encrypted_content === 'string' ? '[encrypted reasoning]' : '[reasoning]';
}

/** Bounded, single-line-per-item view of the extracted transcript. */
function rolloutExcerpt(items: readonly unknown[]): string {
  const lines = items.map((raw, index) => {
    const item = asRecord(raw) ?? {};
    const type = text(item.type);
    let detail = '';
    if (type === 'message') detail = `${text(item.role)}: ${contentText(item.content)}`;
    else if (type === 'function_call') detail = `${text(item.name)} ${text(item.arguments)}`;
    else if (type === 'custom_tool_call') detail = `${text(item.name)} ${text(item.input)}`;
    else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      detail = text(item.output);
    } else if (type === 'reasoning') detail = reasoningText(item);
    return `[${index}] ${type} ${clipLine(detail, 110)}`.trimEnd();
  });
  return clip(lines.join('\n'), EXCERPT_CHARS);
}

function toolPairStats(items: readonly unknown[]): {
  matched: number;
  unmatchedCalls: number;
  unmatchedOutputs: number;
} {
  const callIds = new Set<string>();
  const outputIds = new Set<string>();
  for (const raw of items) {
    const item = asRecord(raw);
    if (!item) continue;
    const callId = text(item.call_id);
    if (callId.length === 0) continue;
    const type = text(item.type);
    if (CALL_ITEM_TYPES.has(type)) callIds.add(callId);
    else if (OUTPUT_ITEM_TYPES.has(type)) outputIds.add(callId);
  }
  let matched = 0;
  for (const callId of callIds) {
    if (outputIds.has(callId)) matched += 1;
  }
  return {
    matched,
    unmatchedCalls: callIds.size - matched,
    unmatchedOutputs: outputIds.size - matched,
  };
}

function extractRollout(file: string, limit: number): { items: unknown[]; stats: RolloutStats } {
  let raw: string;
  try {
    raw = Deno.readTextFileSync(file);
  } catch (error) {
    throw new CliError('rollout-unreadable', `cannot read ${file} (${describeError(error)})`);
  }

  const skipped: Record<string, number> = {
    blank_line: 0,
    malformed_line: 0,
    non_response_item: 0,
    unsupported_item_type: 0,
    missing_payload: 0,
    missing_fields: 0,
    unsupported_role: 0,
    empty_content: 0,
    over_limit: 0,
  };
  const mapped: unknown[] = [];
  const lines = raw.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      skipped.blank_line += 1;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped.malformed_line += 1;
      continue;
    }
    const record = asRecord(parsed);
    if (!record || record.type !== 'response_item') {
      skipped.non_response_item += 1;
      continue;
    }
    const payload = asRecord(record.payload);
    if (!payload) {
      skipped.missing_payload += 1;
      continue;
    }
    const type = text(payload.type);
    if (!ROLLOUT_ITEM_TYPE_SET.has(type)) {
      skipped.unsupported_item_type += 1;
      continue;
    }
    const result = mapRolloutItem(type, payload);
    if (!result.ok) {
      skipped[result.reason] += 1;
      continue;
    }
    mapped.push(result.item);
  }

  // The cap keeps the most recent items: the live context is the tail of a
  // session, and the proxy's own pinned window is anchored at the end too.
  if (mapped.length > limit) {
    skipped.over_limit = mapped.length - limit;
    mapped.splice(0, skipped.over_limit);
  }

  const counts: Record<string, number> = {};
  for (const type of ROLLOUT_ITEM_TYPES) counts[type] = 0;
  const roles: Record<string, number> = {};
  for (const role of MESSAGE_ROLES) roles[role] = 0;
  let contentChars = 0;
  for (const rawItem of mapped) {
    const item = asRecord(rawItem) ?? {};
    const type = text(item.type);
    if (type in counts) counts[type] += 1;
    if (type === 'message') {
      const role = text(item.role);
      if (role in roles) roles[role] += 1;
    }
    contentChars += itemChars(item);
  }

  const pairs = toolPairStats(mapped);
  const stats: RolloutStats = {
    file,
    lines_total: raw.endsWith('\n') ? lines.length - 1 : lines.length,
    items: mapped.length,
    counts,
    message_roles: roles,
    input_chars: JSON.stringify({ stream: true, input: mapped }).length,
    content_chars: contentChars,
    matched_tool_pairs: pairs.matched,
    unmatched_calls: pairs.unmatchedCalls,
    unmatched_outputs: pairs.unmatchedOutputs,
    skipped,
    excerpt: '',
  };
  return { items: mapped, stats };
}

function parentDir(path: string): string {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const index = trimmed.lastIndexOf('/');
  if (index < 0) return '.';
  if (index === 0) return '/';
  return trimmed.slice(0, index);
}

function ancestorChain(start: string): string[] {
  const chain: string[] = [];
  if (start.length === 0) return chain;
  let current = start;
  for (;;) {
    chain.push(current);
    const parent = parentDir(current);
    if (parent === current || parent === '.') break;
    current = parent;
  }
  return chain;
}

/** Reads $HOME only when --allow-env grants it; never prompts. */
function envHome(): string | null {
  try {
    if (Deno.permissions.querySync({ name: 'env', variable: 'HOME' }).state !== 'granted') {
      return null;
    }
  } catch {
    return null;
  }
  try {
    const home = Deno.env.get('HOME');
    return home && home.length > 0 ? home : null;
  } catch {
    return null;
  }
}

function cwdOrNull(): string | null {
  try {
    return Deno.cwd();
  } catch {
    return null;
  }
}

function readableRolloutDir(path: string): boolean {
  try {
    if (Deno.permissions.querySync({ name: 'read', path }).state !== 'granted') return false;
  } catch {
    return false;
  }
  try {
    for (const entry of Deno.readDirSync(path)) {
      if (entry.isDirectory) return true;
      if (entry.isFile && entry.name.startsWith(ROLLOUT_PREFIX) && entry.name.endsWith(ROLLOUT_SUFFIX)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * `latest` needs $HOME. Under the documented `--allow-read` grant alone, $HOME
 * is not readable, so the sessions root is also probed by walking up from this
 * file and from the working directory (which matches when the checkout lives
 * under the home directory).
 */
function resolveSessionsRoot(): string | null {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (base: string): void => {
    if (base.length === 0 || base === '/') return;
    const candidate = `${base}/${SESSIONS_SUFFIX}`;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  };

  const home = envHome();
  if (home) add(home);
  let moduleDir = '';
  try {
    moduleDir = parentDir(decodeURIComponent(new URL('.', import.meta.url).pathname));
  } catch {
    moduleDir = '';
  }
  for (const dir of ancestorChain(moduleDir)) add(dir);
  const cwd = cwdOrNull();
  if (cwd) for (const dir of ancestorChain(cwd)) add(dir);

  for (const candidate of candidates) {
    if (readableRolloutDir(candidate)) return candidate;
  }
  return null;
}

function newestRollout(root: string): string | null {
  let newestPath: string | null = null;
  let newestMtime = -1;
  const walk = (dir: string): void => {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        walk(path);
        continue;
      }
      if (!entry.isFile) continue;
      if (!entry.name.startsWith(ROLLOUT_PREFIX) || !entry.name.endsWith(ROLLOUT_SUFFIX)) continue;
      let mtime = 0;
      try {
        mtime = Deno.statSync(path).mtime?.getTime() ?? 0;
      } catch {
        continue;
      }
      if (mtime > newestMtime || (mtime === newestMtime && newestPath !== null && path > newestPath)) {
        newestMtime = mtime;
        newestPath = path;
      }
    }
  };
  walk(root);
  return newestPath;
}

function resolveRolloutPath(rollout: string): string {
  if (rollout !== 'latest') {
    if (rollout.startsWith('/')) return rollout;
    const cwd = cwdOrNull();
    if (!cwd) {
      throw new CliError(
        'bad-args',
        'a relative --rollout path needs read access to the working directory; pass an absolute path',
      );
    }
    return `${cwd}/${rollout}`;
  }
  const root = resolveSessionsRoot();
  if (!root) {
    throw new CliError(
      'rollout-root-unresolved',
      'cannot locate $HOME/.codex/sessions; pass an explicit --rollout <path> or grant --allow-env=HOME',
    );
  }
  const newest = newestRollout(root);
  if (!newest) throw new CliError('rollout-not-found', `no ${ROLLOUT_PREFIX}*${ROLLOUT_SUFFIX} under ${root}`);
  return newest;
}

function structuralCounts(header: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const match of header.matchAll(/([a-z_]+)=(\d+)/g)) {
    counts[match[1]] = Number(match[2]);
  }
  return counts;
}

function parseSse(body: string): SseResult {
  let summary = '';
  let completed = false;
  let itemAt: number | null = null;
  let completedAt: number | null = null;
  let error: string | null = null;
  let index = 0;
  for (const block of body.split('\n\n')) {
    index += 1;
    const lines = block.split('\n');
    const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? '';
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (event === 'response.output_item.done' && data.length > 0) {
      if (itemAt === null) itemAt = index;
      try {
        const parsed = JSON.parse(data) as { item?: { content?: Array<{ text?: string }> } };
        const part = parsed.item?.content?.find((entry) => typeof entry?.text === 'string');
        if (part?.text && part.text.length > summary.length) summary = part.text;
      } catch {
        error = 'unparsable-sse';
      }
    } else if (event === 'response.completed') {
      if (completedAt === null) completedAt = index;
      completed = true;
    } else if (event === 'response.failed' || event.includes('error')) {
      error = 'sse-error-event';
    }
  }
  const ordered = itemAt !== null && completedAt !== null && itemAt < completedAt;
  return { summary, completed, ordered, error };
}

/** Nonsecret failure class from a proxy error body; never echoes the body. */
function httpFailureClass(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    const match = /\(([a-z0-9-]+)\)/.exec(parsed.error?.message ?? '');
    if (match) return match[1];
  } catch {
    // A non-JSON error body is reported by status only.
  }
  return `http-${status}`;
}

function transportFailureClass(error: unknown): string {
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'timeout';
  }
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof TypeError) return 'proxy-unreachable';
  return 'transport-error';
}

type SendOutcome = { ok: true; sse: SseResult } | { ok: false };

async function sendRequest(
  options: CliOptions,
  metrics: Metrics,
  items: readonly unknown[],
): Promise<SendOutcome> {
  const body = JSON.stringify({ stream: true, input: items });
  metrics.input_chars = body.length;
  const started = performance.now();

  let response: Response;
  try {
    metrics.request_count += 1;
    response = await fetch(`${options.proxy}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [TURN_METADATA_HEADER]: TURN_METADATA },
      body,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    metrics.total_ms = Math.round(performance.now() - started);
    const failureClass = transportFailureClass(error);
    fail(
      metrics,
      failureClass,
      failureClass === 'timeout'
        ? `aborted after ${options.timeoutMs}ms`
        : describeError(error),
    );
    return { ok: false };
  }

  // The proxy buffers the Jev answer before it responds, so this is the Jev call.
  metrics.jev_request_ms = Math.round(performance.now() - started);
  metrics.http_status = response.status;
  metrics.structural_header = response.headers.get(STRUCTURAL_HEADER) ?? '';
  metrics.structural = structuralCounts(metrics.structural_header);

  let responseText: string;
  try {
    responseText = await response.text();
  } catch (error) {
    metrics.total_ms = Math.round(performance.now() - started);
    const failureClass = transportFailureClass(error);
    fail(
      metrics,
      failureClass,
      failureClass === 'timeout'
        ? `aborted after ${options.timeoutMs}ms`
        : describeError(error),
    );
    return { ok: false };
  }
  metrics.total_ms = Math.round(performance.now() - started);

  if (response.status !== 200) {
    fail(metrics, httpFailureClass(response.status, responseText), `http status ${response.status}`);
    return { ok: false };
  }
  return { ok: true, sse: parseSse(responseText) };
}

function evaluateSendChecks(metrics: Metrics, mode: Mode, sse: SseResult): void {
  const present = OBSOLETE_MARKERS.filter((marker) => sse.summary.includes(marker));
  const gates: Array<[string, boolean, string, string]> = [
    ['http-200', metrics.http_status === 200, 'http-status', `http status ${metrics.http_status}`],
    [
      'request-count-1',
      metrics.request_count === 1,
      'multiple-requests',
      `request_count=${metrics.request_count}`,
    ],
    [
      'structural-header-present',
      metrics.structural_header.length > 0,
      'missing-structural-header',
      `${STRUCTURAL_HEADER} response header is absent`,
    ],
    ['sse-parsable', sse.error === null, sse.error ?? 'unparsable-sse', ''],
    [
      'sse-sequence',
      sse.ordered,
      'sse-order',
      'response.completed did not follow response.output_item.done',
    ],
    ['sse-completed', sse.completed, 'incomplete-sse', 'no response.completed event'],
    ['summary-present', sse.summary.length > 0, 'empty-summary', 'summary is empty'],
  ];
  if (mode === 'fixture') {
    gates.push([
      'goal-marker-kept',
      sse.summary.includes(GOAL_MARKER),
      'missing-goal-marker',
      `summary does not contain ${GOAL_MARKER}`,
    ]);
    gates.push([
      'obsolete-markers-absent',
      present.length === 0,
      'obsolete-marker-present',
      `summary contains ${present.join(', ')}`,
    ]);
  }

  metrics.summary_chars = sse.summary.length;
  metrics.ratio = metrics.input_chars === 0
    ? 0
    : Number((1 - metrics.summary_chars / metrics.input_chars).toFixed(4));
  metrics.summary_preview = clip(sse.summary, SUMMARY_PREVIEW_CHARS);

  let failed = false;
  for (const [name, ok, failureClass, detail] of gates) {
    setCheck(metrics, name, ok);
    if (!ok) {
      failed = true;
      fail(metrics, failureClass, detail);
    }
  }
  if (failed) return;
  metrics.status = 'PASS';
  metrics.failure_class = 'none';
}

async function run(options: CliOptions, metrics: Metrics): Promise<void> {
  if (options.mode === 'fixture') {
    metrics.send_attempted = true;
    const outcome = await sendRequest(options, metrics, fixtureItems());
    if (!outcome.ok) return;
    evaluateSendChecks(metrics, options.mode, outcome.sse);
    return;
  }

  const file = resolveRolloutPath(options.rollout ?? 'latest');
  const { items, stats } = extractRollout(file, options.limit);
  if (options.mode === 'rollout-dry-run') stats.excerpt = rolloutExcerpt(items);
  metrics.rollout = stats;
  metrics.input_chars = stats.input_chars;

  if (!setCheck(metrics, 'extraction-items', stats.items > 0)) {
    fail(metrics, 'no-input', `${file} produced no usable Codex input items`);
    return;
  }
  if (stats.matched_tool_pairs === 0) {
    metrics.notes.push(
      'no matched tool call/result pairs: the installed proxy answers no-candidates (HTTP 400) for this input',
    );
  }
  if (options.mode === 'rollout-dry-run') {
    metrics.status = 'PASS';
    metrics.failure_class = 'none';
    return;
  }

  metrics.send_attempted = true;
  const outcome = await sendRequest(options, metrics, items);
  if (!outcome.ok) return;
  evaluateSendChecks(metrics, options.mode, outcome.sse);
}

function sendChecksPass(metrics: Metrics): boolean {
  const names: readonly string[] = metrics.mode === 'fixture'
    ? [...SEND_CHECKS, ...FIXTURE_CHECKS]
    : SEND_CHECKS;
  return names.every((name) => metrics.checks[name] === true);
}

function countsLine(counts: Record<string, number>): string {
  return Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(' ');
}

function renderHuman(metrics: Metrics): string {
  const lines: string[] = [];
  lines.push(`mode=${metrics.mode}`);
  lines.push(`proxy_origin=${metrics.proxy_origin} timeout_ms=${metrics.timeout_ms}`);
  if (metrics.mode === 'rollout-dry-run') {
    lines.push('request_count=0 (strict dry run: no network, no Jev call)');
  } else {
    lines.push(`request_count=${metrics.request_count} (must be exactly 1)`);
  }

  const rollout = metrics.rollout;
  if (rollout) {
    lines.push(`rollout_file=${rollout.file}`);
    lines.push(`rollout_lines=${rollout.lines_total} rollout_items=${rollout.items}`);
    lines.push(`rollout_counts: ${countsLine(rollout.counts)}`);
    lines.push(`rollout_message_roles: ${countsLine(rollout.message_roles)}`);
    lines.push(
      `rollout_sizes: input_chars=${rollout.input_chars} content_chars=${rollout.content_chars} ` +
        `matched_tool_pairs=${rollout.matched_tool_pairs} unmatched_calls=${rollout.unmatched_calls} ` +
        `unmatched_outputs=${rollout.unmatched_outputs}`,
    );
    lines.push(`rollout_skipped: ${countsLine(rollout.skipped)}`);
    for (const note of metrics.notes) lines.push(`note: ${note}`);
    const extractionOk = metrics.checks['extraction-items'] === true;
    lines.push(`extraction=${extractionOk ? 'PASS' : 'FAIL'}`);
    if (metrics.mode === 'rollout-dry-run' && extractionOk) {
      lines.push(`extraction_excerpt (<=${EXCERPT_CHARS} chars):`);
      lines.push(rollout.excerpt);
    }
  }

  if (metrics.send_attempted) {
    lines.push(`http_status=${metrics.http_status > 0 ? metrics.http_status : '(no response)'}`);
    lines.push(`timing: jev_request_ms=${metrics.jev_request_ms} total_ms=${metrics.total_ms}`);
    lines.push(
      `sizes: input_chars=${metrics.input_chars} summary_chars=${metrics.summary_chars} ratio=${metrics.ratio}`,
    );
    lines.push(`structural_header=${metrics.structural_header.length > 0 ? metrics.structural_header : '(absent)'}`);
    lines.push(
      `structural: ${
        Object.keys(metrics.structural).length > 0 ? countsLine(metrics.structural) : '(no counts parsed)'
      }`,
    );
    const checkNames = Object.keys(metrics.checks);
    lines.push(
      `checks: ${
        checkNames.length > 0
          ? checkNames.map((name) => `${name}=${metrics.checks[name] ? 'PASS' : 'FAIL'}`).join(' ')
          : '(not evaluated)'
      }`,
    );
    if (metrics.summary_preview.length > 0) {
      lines.push(`summary_preview (<=${SUMMARY_PREVIEW_CHARS} chars):`);
      lines.push(metrics.summary_preview);
    }
  }

  if (metrics.mode === 'rollout-send') {
    lines.push(`send=${metrics.send_attempted ? (sendChecksPass(metrics) ? 'PASS' : 'FAIL') : 'SKIPPED (extraction failed)'}`);
  }

  if (metrics.status === 'PASS') {
    lines.push(
      metrics.mode === 'rollout-dry-run'
        ? `PASS: rollout extraction produced ${rollout?.items ?? 0} items and ${rollout?.matched_tool_pairs ?? 0} matched tool pairs (nothing sent)`
        : `PASS: installed proxy at ${metrics.proxy_origin} answered one compaction request`,
    );
  } else {
    const detail = metrics.failure_detail.length > 0 ? `: ${metrics.failure_detail}` : '';
    lines.push(`FAIL: ${metrics.mode} failed (class=${metrics.failure_class}${detail})`);
  }
  return lines.join('\n');
}

function reportArgumentError(error: unknown, wantsJson: boolean): number {
  const fallback: CliOptions = {
    mode: 'invalid',
    proxy: DEFAULT_PROXY_ORIGIN,
    json: wantsJson,
    limit: DEFAULT_LIMIT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    rollout: null,
  };
  const metrics = newMetrics(fallback);
  fail(metrics, error instanceof CliError ? error.kind : 'bad-args', describeError(error));
  if (wantsJson) console.log(JSON.stringify(metrics));
  else console.log(`FAIL: ${describeError(error)}\n\n${USAGE}`);
  return 1;
}

async function main(): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(Deno.args);
  } catch (error) {
    return reportArgumentError(error, Deno.args.includes('--json'));
  }
  const metrics = newMetrics(options);
  try {
    await run(options, metrics);
  } catch (error) {
    fail(metrics, error instanceof CliError ? error.kind : 'unexpected-error', describeError(error));
  }
  if (metrics.status === 'FAIL' && metrics.failure_class === 'none') {
    metrics.failure_class = 'not-completed';
  }
  console.log(options.json ? JSON.stringify(metrics) : renderHuman(metrics));
  return metrics.status === 'PASS' ? 0 : 1;
}

try {
  Deno.exit(await main());
} catch (error) {
  console.log(`FAIL: unexpected error (${describeError(error)})`);
  Deno.exit(1);
}
