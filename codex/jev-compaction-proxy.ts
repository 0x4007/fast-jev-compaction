/**
 * Loopback Responses proxy that answers Codex's *local* compaction request with
 * a Jev-compacted transcript, and forwards everything else byte-transparently.
 *
 * Run:  deno run --allow-net=0.0.0.0:8787,127.0.0.1,api.typesafe.ai --allow-env=TYPESAFE_API_KEY codex/jev-compaction-proxy.ts
 *
 * Product configuration is fixed (no env knobs, no CLI flags):
 *   bind 0.0.0.0:8787 (all interfaces, LAN + loopback), upstream http://127.0.0.1:8000, Jev key TYPESAFE_API_KEY.
 *   The Jev HTTP call is bounded at 30 s by an adapter-owned fetch wrapper.
 * `startProxy` takes internal options so tests can inject ephemeral ports, a
 * fake upstream origin, and a fake Jev asker. Nothing here reads conversation
 * content into logs: only structural counts are emitted.
 */
import { collectToolCalls, compact, JevClient } from '../dist/index.js';
import type { CompactResult, JevAsker, Message } from '../dist/index.js';
import {
  isCompactionKind,
  isResponsesCompaction,
  MAX_SUMMARY_CHARS,
  parseCodexInput,
  parseTurnMetadata,
  renderSummary,
} from './codex-items.ts';

export const DEFAULT_HOSTNAME = '127.0.0.1';
export const DEFAULT_PORT = 8787;
export const DEFAULT_UPSTREAM_ORIGIN = 'http://127.0.0.1:8000';

/** Library defaults, minus the goal (the transcript itself carries the task). */
export const COMPACTION_OPTIONS = {
  preserveRecentMessages: 6,
  keepThreshold: 0.5,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
} as const;

/** Bounded retry suppression: identical input replays the same outcome. */
const CACHE_MAX_ENTRIES = 4;
const CACHE_TTL_MS = 120_000;

const TURN_METADATA_HEADER = 'x-codex-turn-metadata';
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

type FailureKind =
  | 'unreadable-body'
  | 'unparsable-body'
  | 'missing-input'
  | 'empty-transcript'
  | 'no-candidates'
  | 'jev-failed'
  | 'no-reduction'
  | 'render-failed'
  | 'summary-too-large'
  | 'empty-summary';

export class CompactionUnavailable extends Error {
  readonly kind: FailureKind;

  constructor(kind: FailureKind, detail: string) {
    super(detail);
    this.name = 'CompactionUnavailable';
    this.kind = kind;
  }
}

interface CacheEntry {
  at: number;
  status: number;
  contentType: string;
  headers: Record<string, string>;
  body: string;
}

export interface ProxyOptions {
  hostname?: string;
  port?: number;
  upstreamOrigin?: string;
  /** Defaults to the production System One endpoint inside the library. */
  jevBaseUrl?: string;
  /** Defaults to `TYPESAFE_API_KEY` inside the library. */
  apiKey?: string;
  /** Test injection: replaces the HTTP Jev client entirely. */
  asker?: JevAsker;
  fetch?: typeof fetch;
  /** Test injection: bounds the Jev HTTP call (defaults to `JEV_TIMEOUT_MS`). */
  jevTimeoutMs?: number;
  log?: (line: string) => void;
}

/** True when a browser request targets the proxy's own origin (the only case that may be rewritten to the upstream origin). */
export function isProxySameOrigin(origin: string | null, requestOrigin: string): boolean {
  return origin !== null && origin === requestOrigin;
}

export interface RunningProxy {
  hostname: string;
  port: number;
  url: string;
  /** Intercepted compaction requests (successful or failed). */
  compactionAttempts(): number;
  close(): Promise<void>;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function failureResponse(kind: FailureKind): Response {
  return jsonResponse(400, {
    error: {
      message: `fast-jev-compaction unavailable (${kind})`,
      type: 'invalid_request_error',
    },
  });
}

function ssePayload(itemId: string, responseId: string, text: string): string {
  const item = {
    type: 'message',
    role: 'assistant',
    id: itemId,
    content: [{ type: 'output_text', text }],
  };
  const done = JSON.stringify({ type: 'response.output_item.done', item });
  const completed = JSON.stringify({
    type: 'response.completed',
    response: { id: responseId, status: 'completed' },
  });
  return `event: response.output_item.done\ndata: ${done}\n\nevent: response.completed\ndata: ${completed}\n\n`;
}

function jsonCompletionPayload(itemId: string, responseId: string, text: string): string {
  return JSON.stringify({
    id: responseId,
    object: 'response',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        id: itemId,
        content: [{ type: 'output_text', text }],
      },
    ],
  });
}

/** Structural only: counts, sizes, and library stage — never transcript text. */
function compactionLogLine(
  outcome: 'ok' | 'failed',
  detail: string,
  counts?: {
    items: number;
    candidates: number;
    kept: number;
    resultsDropped: number;
    callsDropped: number;
    pinned: number;
    charsBefore: number;
    charsAfter: number;
    requests: number;
  },
): string {
  if (!counts) return `compaction ${outcome}: ${detail}`;
  return [
    `compaction ${outcome}:`,
    `items=${counts.items}`,
    `candidates=${counts.candidates}`,
    `kept=${counts.kept}`,
    `results_dropped=${counts.resultsDropped}`,
    `calls_dropped=${counts.callsDropped}`,
    `pinned=${counts.pinned}`,
    `chars_before=${counts.charsBefore}`,
    `chars_after=${counts.charsAfter}`,
    `jev_requests=${counts.requests}`,
  ].join(' ');
}

/**
 * Nonsecret failure class for logs: the failure kind plus a bounded structural
 * token. Library error messages can embed provider response text, so only
 * status codes, counts, and fixed classifications are ever logged.
 */
function failureLogDetail(kind: FailureKind, message: string): string {
  const http = /Jev request failed \((\d{3})\)/.exec(message);
  if (http) return `http=${http[1]}`;
  if (message.startsWith('Jev request timed out')) return 'timeout';
  if (message.includes('malformed JSON')) return 'malformed-response';
  if (message.startsWith('Invalid Jev answer')) return 'invalid-answer';
  if (message.includes('no room for questions')) return 'state-over-budget';
  if (message.includes('history too large for Jev')) return 'state-too-large';
  const counts = /dropped=(\d+), before=(\d+), after=(\d+)/.exec(message);
  if (counts) return `dropped=${counts[1]} before=${counts[2]} after=${counts[3]}`;
  const chars = /summary is (\d+) chars/.exec(message);
  if (chars) return `summary-chars=${chars[1]}`;
  return kind;
}

function structuralHeader(counts: {
  kept: number;
  resultsDropped: number;
  callsDropped: number;
  pinned: number;
  charsBefore: number;
  charsAfter: number;
}): string {
  return [
    'summary',
    `kept=${counts.kept}`,
    `results_dropped=${counts.resultsDropped}`,
    `calls_dropped=${counts.callsDropped}`,
    `pinned=${counts.pinned}`,
    `chars_before=${counts.charsBefore}`,
    `chars_after=${counts.charsAfter}`,
  ].join('; ');
}

export interface CompactionOutcome {
  status: number;
  contentType: string;
  headers: Record<string, string>;
  body: string;
  logLine: string;
}

/**
 * Turns one header-verified compaction request body into a completed response.
 * Throws `CompactionUnavailable` for every non-success path; the caller maps it
 * to an explicit error status so Codex keeps the original history.
 */
export async function buildCompactionResponse(
  rawBody: string,
  asker: JevAsker,
  options: { stream: boolean },
): Promise<CompactionOutcome> {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new CompactionUnavailable('unparsable-body', 'compaction request body is not JSON');
  }
  const requestBody = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const transcript = parseCodexInput(requestBody.input);
  if (!transcript) {
    throw new CompactionUnavailable('missing-input', 'compaction request has no input items array');
  }
  if (transcript.entries.length === 0) {
    throw new CompactionUnavailable('empty-transcript', 'compaction request has no conversation content');
  }
  const calls = collectToolCalls(transcript.messages, COMPACTION_OPTIONS.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  if (candidates.length === 0) {
    // A short or tool-free transcript has nothing Jev could usefully decide.
    // No Jev request is made and no summary is invented.
    throw new CompactionUnavailable('no-candidates', 'no unpinned tool call/result pairs to decide');
  }

  let result: CompactResult;
  try {
    result = await compact(transcript.messages, asker, COMPACTION_OPTIONS);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // The library validates every asked question, so a thrown error here means
    // no partial decision set was substituted.
    throw new CompactionUnavailable('jev-failed', detail.slice(0, 200));
  }

  // Minimal adapter-side guard: every candidate must have exactly one decision.
  const decidedIds = new Set(result.decisions.map((decision) => decision.id));
  for (const candidate of candidates) {
    if (!decidedIds.has(candidate.id)) {
      throw new CompactionUnavailable('jev-failed', `missing decision for ${candidate.id}`);
    }
  }

  const dropped = result.stats.resultsDropped + result.stats.callsDropped;
  if (dropped === 0 || result.stats.charsAfter >= result.stats.charsBefore) {
    throw new CompactionUnavailable(
      'no-reduction',
      `nothing was dropped (dropped=${dropped}, before=${result.stats.charsBefore}, after=${result.stats.charsAfter})`,
    );
  }

  const callIds = new Map(calls.map((call) => [call.id, call.tool_use_id]));
  let summary: string;
  try {
    summary = renderSummary(transcript, {
      decisions: result.decisions,
      callIds,
      headChars: COMPACTION_OPTIONS.truncateHeadChars,
      stats: result.stats,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CompactionUnavailable('render-failed', `render failed: ${detail.slice(0, 200)}`);
  }
  if (summary.trim().length === 0) {
    throw new CompactionUnavailable('empty-summary', 'renderer produced an empty summary');
  }
  if (summary.length > MAX_SUMMARY_CHARS) {
    // Never truncate Jev-kept content silently: fail and keep Codex's history.
    throw new CompactionUnavailable(
      'summary-too-large',
      `summary is ${summary.length} chars (limit ${MAX_SUMMARY_CHARS})`,
    );
  }

  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  const headers = {
    'x-fast-jev-compaction': structuralHeader(result.stats),
  };
  const logLine = compactionLogLine('ok', 'summary installed', {
    items: transcript.entries.length,
    candidates: candidates.length,
    kept: result.stats.kept,
    resultsDropped: result.stats.resultsDropped,
    callsDropped: result.stats.callsDropped,
    pinned: result.stats.pinned,
    charsBefore: result.stats.charsBefore,
    charsAfter: result.stats.charsAfter,
    requests: result.stats.requests,
  });
  if (options.stream) {
    return {
      status: 200,
      contentType: 'text/event-stream',
      headers,
      body: ssePayload(`msg_jev_${suffix}`, `resp_jev_${suffix}`, summary),
      logLine,
    };
  }
  return {
    status: 200,
    contentType: 'application/json',
    headers,
    body: jsonCompletionPayload(`msg_jev_${suffix}`, `resp_jev_${suffix}`, summary),
    logLine,
  };
}

/** Bound on one Jev HTTP call, headers and response body included. */
export const JEV_TIMEOUT_MS = 30_000;

function timedOutError(timeoutMs: number): Error {
  return new Error(`Jev request timed out after ${timeoutMs}ms`);
}

/**
 * Adapter-owned Jev transport. One request is bounded by an `AbortSignal`
 * (30 s by default) that stays armed while the response body is consumed, any
 * caller signal is preserved, and the timer and listeners are released on
 * every path. Transport failures are re-thrown with a fixed, non-secret
 * message. The upstream passthrough fetch and the library are untouched, so
 * the Claude plugin keeps its existing behaviour.
 */
export function createJevTimeoutFetch(
  baseFetch: typeof fetch,
  timeoutMs = JEV_TIMEOUT_MS,
): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const external = init?.signal ?? null;
    const forwardExternalAbort = (): void => controller.abort(external?.reason);
    if (external) {
      if (external.aborted) controller.abort(external.reason);
      else external.addEventListener('abort', forwardExternalAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(timedOutError(timeoutMs)), timeoutMs);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      external?.removeEventListener('abort', forwardExternalAbort);
    };
    const sanitize = (error: unknown): Error => {
      const reason: unknown = controller.signal.reason;
      if (reason instanceof Error && reason.message.startsWith('Jev request timed out')) return reason;
      if (controller.signal.aborted) return new Error('Jev request aborted');
      const detail = error instanceof Error ? error.message : 'unknown transport failure';
      return new Error(`Jev transport error: ${detail.slice(0, 120)}`);
    };
    return baseFetch(input, { ...init, signal: controller.signal }).then((response) => {
      const body = response.body;
      if (!body) {
        release();
        return response;
      }
      const reader = body.getReader();
      let aborted = false;
      controller.signal.addEventListener('abort', () => {
        aborted = true;
        void reader.cancel(controller.signal.reason).catch(() => {});
      }, { once: true });
      const stream = new ReadableStream<Uint8Array>({
        async pull(streamController) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              release();
              // An abort that landed after the last chunk still fails the read.
              if (aborted) streamController.error(sanitize(controller.signal.reason));
              else streamController.close();
              return;
            }
            streamController.enqueue(value);
          } catch (error) {
            release();
            streamController.error(sanitize(error));
          }
        },
        cancel(reason) {
          release();
          return reader.cancel(reason).catch(() => {});
        },
      });
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }, (error: unknown) => {
      release();
      throw sanitize(error);
    });
  };
}

export async function startProxy(options: ProxyOptions = {}): Promise<RunningProxy> {
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const port = options.port ?? DEFAULT_PORT;
  const upstreamOrigin = options.upstreamOrigin ?? DEFAULT_UPSTREAM_ORIGIN;
  const upstreamOriginValue = new URL(upstreamOrigin).origin;
  const fetcher = options.fetch ?? fetch;
  const log = options.log ?? ((line: string) => console.log(`[codex-jev] ${line}`));
  const asker: JevAsker = options.asker ??
    new JevClient({
      apiKey: options.apiKey,
      baseUrl: options.jevBaseUrl,
      fetch: createJevTimeoutFetch(fetcher, options.jevTimeoutMs),
    });
  const cache = new Map<string, CacheEntry>();
  let attempts = 0;

  const cached = (key: string): CacheEntry | null => {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > CACHE_TTL_MS) {
      cache.delete(key);
      return null;
    }
    return entry;
  };
  const remember = (key: string, entry: CacheEntry): void => {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  };
  const replay = (entry: CacheEntry): Response =>
    new Response(entry.body, {
      status: entry.status,
      headers: { 'content-type': entry.contentType, ...entry.headers },
    });

  async function passthrough(request: Request, url: URL): Promise<Response> {
    const target = new URL(url.pathname + url.search, upstreamOrigin);
    const headers = new Headers();
    for (const [name, value] of request.headers) {
      if (!HOP_BY_HOP.has(name.toLowerCase())) headers.set(name, value);
    }
    // Browser clients reach the proxy on its own origin, but the gateway grants
    // local trust only when Origin is absent or equals the origin it sees (the
    // loopback upstream). Rewrite exactly that same-origin case so LAN and
    // localhost UIs pass the gateway's check; foreign origins are left
    // untouched and still rejected upstream.
    const origin = request.headers.get('origin');
    if (isProxySameOrigin(origin, url.origin)) headers.set('origin', upstreamOriginValue);
    const init: RequestInit = { method: request.method, headers, redirect: 'manual' };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
      // Deno streams request bodies; some runtimes require the half-duplex hint.
      (init as Record<string, unknown>).duplex = 'half';
    }
    const upstream = await fetcher(target, init);
    const responseHeaders = new Headers();
    for (const [name, value] of upstream.headers) {
      if (!HOP_BY_HOP.has(name.toLowerCase())) responseHeaders.set(name, value);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }

  async function handleCompaction(request: Request, url: URL): Promise<Response> {
    attempts += 1;
    let rawBody: string;
    try {
      rawBody = await request.text();
    } catch {
      log(compactionLogLine('failed', 'unreadable-body'));
      return failureResponse('unreadable-body');
    }
    let stream = true;
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      stream = parsed.stream !== false;
    } catch {
      // buildCompactionResponse reports the parse failure.
    }
    const key = await sha256Hex(rawBody);
    const hit = cached(key);
    if (hit) {
      log(compactionLogLine(hit.status === 200 ? 'ok' : 'failed', `cached ${hit.status}`));
      return replay(hit);
    }
    try {
      const outcome = await buildCompactionResponse(rawBody, asker, { stream });
      remember(key, {
        at: Date.now(),
        status: outcome.status,
        contentType: outcome.contentType,
        headers: outcome.headers,
        body: outcome.body,
      });
      log(outcome.logLine);
      return new Response(outcome.body, {
        status: outcome.status,
        headers: { 'content-type': outcome.contentType, ...outcome.headers },
      });
    } catch (error) {
      const kind = error instanceof CompactionUnavailable ? error.kind : 'jev-failed';
      const message = error instanceof Error ? error.message : String(error);
      const response = failureResponse(kind);
      const body = await response.text();
      remember(key, {
        at: Date.now(),
        status: response.status,
        contentType: 'application/json',
        headers: {},
        body,
      });
      log(compactionLogLine('failed', `kind=${kind} reason=${failureLogDetail(kind, message)}`));
      return new Response(body, { status: response.status, headers: { 'content-type': 'application/json' } });
    }
  }

  async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return new Response(
        `fast-jev-compaction proxy ready; upstream=${upstreamOrigin}; compaction=responses\n`,
        { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } },
      );
    }
    const metadata = parseTurnMetadata(request.headers.get(TURN_METADATA_HEADER));
    if (request.method === 'POST' && url.pathname === '/v1/responses' && isResponsesCompaction(metadata)) {
      return await handleCompaction(request, url);
    }
    if (isCompactionKind(metadata)) {
      // An explicit compaction request this adapter does not implement (or
      // malformed metadata) stays Codex's own request; never claimed as ours.
      const implementation = String(metadata?.compaction?.implementation ?? 'unknown').slice(0, 40);
      log(`compaction forwarded untouched: implementation=${implementation}`);
    }
    return await passthrough(request, url);
  }

  let resolveAddr: (addr: Deno.NetAddr) => void = () => {};
  const listening = new Promise<Deno.NetAddr>((resolve) => {
    resolveAddr = resolve;
  });
  const server = Deno.serve(
    { hostname, port, onListen: (addr) => resolveAddr(addr as Deno.NetAddr) },
    handler,
  );
  const addr = await listening;
  log(`listening on http://${addr.hostname}:${addr.port} upstream=${upstreamOrigin}`);

  return {
    hostname: addr.hostname,
    port: addr.port,
    url: `http://${addr.hostname}:${addr.port}`,
    compactionAttempts: () => attempts,
    close: async () => {
      await server.shutdown();
    },
  };
}

if (import.meta.main) {
  // Product entrypoint binds all interfaces so the gateway UI is reachable on the LAN; the library default stays loopback.
  const running = await startProxy({ hostname: '0.0.0.0' });
  const stop = async (): Promise<void> => {
    await running.close();
    Deno.exit(0);
  };
  Deno.addSignalListener('SIGINT', () => void stop());
  Deno.addSignalListener('SIGTERM', () => void stop());
  if (!Deno.env.get('TYPESAFE_API_KEY')) {
    console.error('[codex-jev] TYPESAFE_API_KEY is not set; compaction requests will fail and Codex keeps its history');
  }
}
