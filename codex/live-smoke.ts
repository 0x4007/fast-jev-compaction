/**
 * Live synthetic timing smoke for the Codex adapter (primary run only).
 *
 * Run:
 *   deno run --allow-env=TYPESAFE_API_KEY --allow-net=127.0.0.1,api.typesafe.ai codex/live-smoke.ts
 *
 * One loopback proxy, one fake upstream that must see zero requests, and the
 * real TypeSafe Jev endpoint through the existing `TYPESAFE_API_KEY`. The
 * synthetic transcript holds three obsolete tool-call/result pairs outside the
 * pinned recent window and one final useful goal marker. At most one Jev HTTP
 * request is allowed (a second is rejected), there are no retries, the Jev call
 * is bounded at 30 s by the adapter's own wrapper, and the whole smoke is
 * bounded at 45 s. One JSON object is printed with numeric latency metrics,
 * structural counts, and a PASS/failure class: never the key, the request
 * payload, or a provider response.
 */
import { JevClient } from '../dist/index.js';
import { createJevTimeoutFetch, startProxy } from './jev-compaction-proxy.ts';

const MAX_TOTAL_MS = 45_000;
const JEV_HOST = 'api.typesafe.ai';
const ARTIFACT_MARKER = 'LIVE_SMOKE_ARTIFACT_OK';
const COMPACTION_PROMPT =
  'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM.';
const METADATA_HEADER = 'x-codex-turn-metadata';
const METADATA = JSON.stringify({
  request_kind: 'compaction',
  compaction: { implementation: 'responses' },
});

interface Metrics {
  status: 'PASS' | 'FAIL';
  failure_class: string;
  jev_request_ms: number;
  total_compaction_ms: number;
  request_count: number;
  upstream_request_count: number;
  input_chars: number;
  summary_chars: number;
  ratio: number;
  dropped: number;
  kept: number;
  structural_header: string;
}

const metrics: Metrics = {
  status: 'FAIL',
  failure_class: 'not-started',
  jev_request_ms: 0,
  total_compaction_ms: 0,
  request_count: 0,
  upstream_request_count: 0,
  input_chars: 0,
  summary_chars: 0,
  ratio: 0,
  dropped: 0,
  kept: 0,
  structural_header: '',
};

function fail(failureClass: string): void {
  metrics.status = 'FAIL';
  metrics.failure_class = failureClass;
}

/** Codex Responses input items; synthetic only, no machine or user files. */
function transcriptItems(): unknown[] {
  const obsolete = (label: string, lines: number): string =>
    `${label} obsolete log line; superseded build, safe to delete. `.repeat(lines);
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
  // 14 entries survive the injected prompt: indices 2/4/6 are the old calls and
  // 3/5/7 their results, all before the pinned last six messages.
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
    text('user', `Final goal: the release notes artifact is ${ARTIFACT_MARKER}; keep that marker verbatim.`),
    text('user', COMPACTION_PROMPT),
  ];
}

interface JevProbe {
  fetch: typeof fetch;
  requests: () => number;
  requestMs: () => number;
  /** Settles when the single Jev response body finished (or failed). */
  bodyComplete: Promise<void>;
}

/** Counts Jev requests, rejects a second one, and times body completion. */
function createJevProbe(): JevProbe {
  let requests = 0;
  let requestMs = 0;
  let finished = false;
  let resolveComplete: () => void = () => {};
  const bodyComplete = new Promise<void>((resolve) => {
    resolveComplete = resolve;
  });
  const finish = (started: number): void => {
    if (finished) return;
    finished = true;
    requestMs = Math.round(performance.now() - started);
    resolveComplete();
  };
  const probeFetch: typeof fetch = async (input, init) => {
    const started = performance.now();
    requests += 1;
    if (requests > 1) throw new Error('live-smoke: more than one Jev request');
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).hostname !== JEV_HOST) throw new Error('live-smoke: unexpected Jev host');
    let response: Response;
    try {
      response = await fetch(input, init);
    } catch (error) {
      finish(started);
      throw error;
    }
    const body = response.body;
    if (!body) {
      finish(started);
      return response;
    }
    const reader = body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            finish(started);
            streamController.close();
            return;
          }
          streamController.enqueue(chunk.value);
        } catch (error) {
          finish(started);
          streamController.error(error);
        }
      },
      cancel(reason) {
        finish(started);
        return reader.cancel(reason).catch(() => {});
      },
    });
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return { fetch: probeFetch, requests: () => requests, requestMs: () => requestMs, bodyComplete };
}

interface FakeUpstream {
  url: string;
  hits: () => number;
  close: () => Promise<void>;
}

async function startUpstream(): Promise<FakeUpstream> {
  let hits = 0;
  let resolveAddr: (addr: Deno.NetAddr) => void = () => {};
  const listening = new Promise<Deno.NetAddr>((resolve) => {
    resolveAddr = resolve;
  });
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen: (addr) => resolveAddr(addr as Deno.NetAddr) },
    () => {
      hits += 1;
      return new Response('live-smoke upstream must never be reached\n', { status: 500 });
    },
  );
  const addr = await listening;
  return {
    url: `http://${addr.hostname}:${addr.port}`,
    hits: () => hits,
    close: () => server.shutdown(),
  };
}

function failureClass(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    const match = /\(([a-z-]+)\)/.exec(parsed.error?.message ?? '');
    if (match) return match[1];
  } catch {
    // A non-JSON error body is reported by status only.
  }
  return `http-${status}`;
}

function structuralCounts(header: string): { dropped: number; kept: number } {
  const read = (name: string): number => {
    const match = new RegExp(`${name}=(\\d+)`).exec(header);
    return match ? Number(match[1]) : 0;
  };
  return { dropped: read('results_dropped') + read('calls_dropped'), kept: read('kept') };
}

function parseSse(text: string): { summary: string; completed: boolean; error: string | null } {
  let summary = '';
  let completed = false;
  let error: string | null = null;
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n');
    const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? '';
    const data = lines.find((line) => line.startsWith('data:'))?.slice(5).trim() ?? '';
    if (event === 'response.output_item.done' && data.length > 0) {
      try {
        const parsed = JSON.parse(data) as { item?: { content?: Array<{ text?: string }> } };
        const part = parsed.item?.content?.find((entry) => typeof entry.text === 'string');
        if (part?.text && part.text.length > summary.length) summary = part.text;
      } catch {
        error = 'unparsable-sse';
      }
    } else if (event === 'response.completed') {
      completed = true;
    } else if (event.includes('error') || event === 'response.failed') {
      error = 'sse-error-event';
    }
  }
  return { summary, completed, error };
}

function timeoutLike(error: unknown): boolean {
  if (error instanceof Error && error.message.startsWith('Jev request timed out')) return true;
  return error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

async function main(): Promise<void> {
  const apiKey = Deno.env.get('TYPESAFE_API_KEY') ?? '';
  if (apiKey.length === 0) {
    fail('missing-credential');
    return;
  }
  const upstream = await startUpstream();
  const probe = createJevProbe();
  let upstreamAttempts = 0;
  const proxyLog: string[] = [];
  const upstreamGate: typeof fetch = () => {
    upstreamAttempts += 1;
    throw new Error('live-smoke: upstream request attempted');
  };
  let proxy: Awaited<ReturnType<typeof startProxy>> | null = null;
  try {
    proxy = await startProxy({
      port: 0,
      upstreamOrigin: upstream.url,
      asker: new JevClient({ apiKey, fetch: createJevTimeoutFetch(probe.fetch) }),
      fetch: upstreamGate,
      log: (line) => proxyLog.push(line),
    });
    const requestBody = JSON.stringify({ model: 'codex-live-smoke', stream: true, input: transcriptItems() });
    metrics.input_chars = requestBody.length;
    const started = performance.now();
    const response = await fetch(`${proxy.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [METADATA_HEADER]: METADATA },
      body: requestBody,
      signal: AbortSignal.timeout(MAX_TOTAL_MS),
    });
    const responseText = await response.text();
    metrics.total_compaction_ms = Math.round(performance.now() - started);
    metrics.structural_header = response.headers.get('x-fast-jev-compaction') ?? '';
    metrics.request_count = probe.requests();
    metrics.upstream_request_count = upstream.hits() + upstreamAttempts;
    if (probe.requests() > 0) {
      await Promise.race([
        probe.bodyComplete,
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    metrics.jev_request_ms = probe.requestMs();

    if (response.status !== 200) {
      // The proxy's failure log carries a fixed classification only.
      if (proxyLog.some((line) => line.includes('reason=timeout'))) return fail('timeout');
      fail(failureClass(response.status, responseText));
      return;
    }
    const sse = parseSse(responseText);
    metrics.summary_chars = sse.summary.length;
    metrics.ratio = metrics.input_chars === 0
      ? 0
      : Number((1 - metrics.summary_chars / metrics.input_chars).toFixed(4));
    const counts = structuralCounts(metrics.structural_header);
    metrics.dropped = counts.dropped;
    metrics.kept = counts.kept;
    if (sse.error) return fail(sse.error);
    if (!sse.completed) return fail('incomplete-sse');
    if (metrics.summary_chars === 0) return fail('empty-summary');
    if (!sse.summary.includes(ARTIFACT_MARKER)) return fail('missing-artifact-marker');
    if (metrics.request_count !== 1) {
      return fail(metrics.request_count === 0 ? 'no-jev-request' : 'multiple-jev-requests');
    }
    if (metrics.upstream_request_count !== 0) return fail('upstream-request');
    metrics.failure_class = 'none';
    metrics.status = 'PASS';
  } finally {
    await proxy?.close();
    await upstream.close();
  }
}

try {
  await main();
} catch (error) {
  fail(timeoutLike(error) ? 'timeout' : 'unexpected-error');
}
console.log(JSON.stringify(metrics));
Deno.exit(metrics.status === 'PASS' ? 0 : 1);
