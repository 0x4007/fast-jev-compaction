import { describe, expect, it } from 'vitest';
import { JevClient } from '../dist/index.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from '../dist/index.js';
import {
  isCompactionKind,
  isResponsesCompaction,
  parseCodexInput,
  parseTurnMetadata,
  renderSummary,
  SUMMARY_MARKER,
} from '../codex/codex-items.js';
import {
  buildCompactionResponse,
  CompactionUnavailable,
  createJevTimeoutFetch,
} from '../codex/jev-compaction-proxy.js';

const PROMPT = 'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM.';

function textItem(role: string, text: string) {
  return { type: 'message', role, content: [{ type: 'input_text', text }] };
}

function assistantText(text: string) {
  return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
}

function call(id: string, name: string, args: unknown) {
  return { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) };
}

function output(id: string, text: string) {
  return { type: 'function_call_output', call_id: id, output: text };
}

/**
 * A realistic compaction input: real history followed by Codex's trailing
 * compaction prompt, with the tool pair outside the pinned recent window.
 */
function longInput(callId = 'call_big', resultText = 'BIG_RESULT '.repeat(100)): unknown[] {
  return [
    textItem('user', 'old real user goal'),
    assistantText('working'),
    call(callId, 'shell', { command: ['bash', '-lc', 'printf fixture'] }),
    output(callId, resultText),
    assistantText('done with the tool'),
    textItem('user', 'follow up one'),
    assistantText('answer one'),
    textItem('user', 'follow up two'),
    assistantText('answer two'),
    textItem('user', 'follow up three'),
    textItem('user', PROMPT),
  ];
}

function parse(input: unknown) {
  const transcript = parseCodexInput(input);
  if (!transcript) throw new Error('expected a transcript');
  return transcript;
}

function summaryFor(input: unknown, decisions: Parameters<typeof renderSummary>[1]['decisions']) {
  const transcript = parse(input);
  const calls = transcript.entries
    .filter((entry) => entry.kind === 'call')
    .map((entry, index) => [entry.callId, `t${index + 1}`] as const);
  const callIds = new Map(calls.map(([callId, short]) => [short, callId]));
  return renderSummary(transcript, { decisions, callIds, headChars: 300 });
}

const DROP_CALL = {
  id: 't1',
  tool: 'shell',
  keepCall: 0.1,
  keepResult: 0.1,
  action: 'drop_call' as const,
  reason: 'call_dropped' as const,
};

const KEEP = {
  id: 't1',
  tool: 'shell',
  keepCall: 0.9,
  keepResult: 0.9,
  action: 'keep' as const,
  reason: 'kept' as const,
};

const DROP_RESULT = {
  id: 't1',
  tool: 'shell',
  keepCall: 0.9,
  keepResult: 0.05,
  action: 'drop_result' as const,
  reason: 'result_dropped' as const,
};

/** Answers keep/drop from markers in the question names' ids. */
class MarkerAsker implements JevAsker {
  asks = 0;
  states: JevState[] = [];
  constructor(private readonly mode: 'drop-call' | 'drop-result' | 'keep' | 'fail' = 'drop-result') {}

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    this.asks += 1;
    this.states.push(state);
    if (this.mode === 'fail') throw new Error('fake Jev is unavailable');
    const answers: Record<string, { noul: number }> = {};
    for (const name of Object.keys(questions)) {
      if (this.mode === 'drop-call') answers[name] = { noul: 0.1 };
      else if (this.mode === 'drop-result') answers[name] = { noul: name.startsWith('result_') ? 0.05 : 0.9 };
      else answers[name] = { noul: 0.95 };
    }
    return { answers };
  }
}

describe('turn metadata parsing', () => {
  it('parses valid metadata and rejects malformed or absent headers', () => {
    expect(parseTurnMetadata(null)).toBeNull();
    expect(parseTurnMetadata('not json')).toBeNull();
    // Arrays are JSON but not metadata objects.
    expect(parseTurnMetadata('[]')).toBeNull();
    const metadata = parseTurnMetadata(
      JSON.stringify({ request_kind: 'compaction', compaction: { implementation: 'responses' } }),
    );
    expect(metadata?.request_kind).toBe('compaction');
    expect(isCompactionKind(metadata)).toBe(true);
    expect(isResponsesCompaction(metadata)).toBe(true);
  });

  it('never adopts an unsupported or missing compaction implementation', () => {
    const unsupported = parseTurnMetadata(
      JSON.stringify({ request_kind: 'compaction', compaction: { implementation: 'remote_v2' } }),
    );
    expect(isCompactionKind(unsupported)).toBe(true);
    expect(isResponsesCompaction(unsupported)).toBe(false);
    expect(isResponsesCompaction(null)).toBe(false);
    expect(isResponsesCompaction(parseTurnMetadata(JSON.stringify({ request_kind: 'turn' })))).toBe(false);
  });
});

describe('Codex input mapping', () => {
  it('pairs calls and results by call_id across function and custom items', () => {
    const transcript = parse([
      textItem('user', 'goal'),
      call('c1', 'shell', { cmd: 'echo hi' }),
      output('c1', 'hi'),
      { type: 'custom_tool_call', call_id: 'c2', name: 'apply_patch', input: '*** Begin Patch' },
      { type: 'custom_tool_call_output', call_id: 'c2', output: 'patch applied' },
      textItem('developer', 'house rules'),
    ]);
    const calls = transcript.entries.filter((entry) => entry.kind === 'call');
    const results = transcript.entries.filter((entry) => entry.kind === 'result');
    expect(calls.map((entry) => entry.callId)).toEqual(['c1', 'c2']);
    expect(results.map((entry) => entry.callId)).toEqual(['c1', 'c2']);
    expect(transcript.messages).toHaveLength(6);
    expect(transcript.messages[1].toolUses[0].tool_use_id).toBe('c1');
    expect(transcript.messages[2].toolResults?.[0].text).toBe('hi');
    expect(transcript.messages[5].role).toBe('user');
  });

  it('excludes only the trailing injected compaction prompt', () => {
    const input = [
      textItem('user', 'an earlier real user message'),
      assistantText('ok'),
      textItem('user', PROMPT),
    ];
    const transcript = parse(input);
    expect(transcript.exclusion?.reason).toBe('known-prompt');
    expect(transcript.exclusion?.index).toBe(2);
    expect(transcript.entries.some((entry) => entry.kind === 'text' && entry.text === 'an earlier real user message')).toBe(true);
    expect(transcript.entries.some((entry) => entry.kind === 'text' && entry.text.includes('CONTEXT CHECKPOINT'))).toBe(false);
  });

  it('keeps an earlier prompt-shaped message and only assumes the very last user item', () => {
    const input = [
      textItem('user', PROMPT),
      assistantText('done'),
      textItem('user', 'custom compact instruction from config'),
    ];
    const transcript = parse(input);
    expect(transcript.exclusion?.reason).toBe('trailing-prompt-assumed');
    expect(transcript.entries.some((entry) => entry.kind === 'text' && entry.text.includes('CONTEXT CHECKPOINT'))).toBe(true);
    expect(transcript.entries.some((entry) => entry.kind === 'text' && entry.text.includes('custom compact'))).toBe(false);
  });

  it('never excludes anything when the last item is not a user message', () => {
    const transcript = parse([textItem('user', 'goal'), assistantText('final answer')]);
    expect(transcript.exclusion).toBeNull();
    expect(transcript.entries).toHaveLength(2);
  });

  it('preserves unknown items and unmatched outputs without exposing opaque blobs', () => {
    const transcript = parse([
      { type: 'reasoning', summary: [], encrypted_content: 'SUPER_SECRET_BLOB'.repeat(20) },
      { type: 'web_search_call', id: 'ws1', status: 'completed' },
      output('orphan_call', 'orphan result text'),
    ]);
    const rendered = summaryFor([
      { type: 'reasoning', summary: [], encrypted_content: 'SUPER_SECRET_BLOB'.repeat(20) },
      { type: 'web_search_call', id: 'ws1', status: 'completed' },
      output('orphan_call', 'orphan result text'),
    ], []);
    expect(transcript.opaqueItems).toBe(1);
    expect(rendered).not.toContain('SUPER_SECRET_BLOB');
    expect(rendered).toContain('opaque payload');
    expect(rendered).toContain('[web_search_call]');
    expect(rendered).toContain('orphan result text');
    expect(rendered).toContain('no matching call in this transcript');
  });
});

describe('summary rendering', () => {
  it('drops a call together with its paired result', () => {
    const rendered = summaryFor(longInput('call_small', 'SMALL_RESULT_OK'), [DROP_CALL]);
    expect(rendered).not.toContain('call_small');
    expect(rendered).not.toContain('SMALL_RESULT_OK');
    expect(rendered).toContain('old real user goal');
    expect(rendered.startsWith(SUMMARY_MARKER)).toBe(true);
  });

  it('keeps a result verbatim and truncates a dropped result with a notice', () => {
    const kept = summaryFor(longInput('call_keep', 'KEEP_ME_VERBATIM'), [KEEP]);
    expect(kept).toContain('KEEP_ME_VERBATIM');
    expect(kept).toContain('kept verbatim');
    const truncated = summaryFor(longInput('call_big'), [DROP_RESULT]);
    expect(truncated).toContain('fast-jev-compaction truncated');
    expect(truncated).not.toContain('BIG_RESULT '.repeat(100));
  });

  it('keeps a dropped result call input while the result tail is cut', () => {
    const tail = 'TAIL_MARKER_MUST_NOT_SURVIVE';
    const rendered = summaryFor(longInput('call_retained_input', `${'head '.repeat(200)}${tail}`), [DROP_RESULT]);
    // `drop_result` keeps the call (with its input) and truncates only the
    // result body, so a fixture whose command spells out a dropped marker would
    // keep that marker alive in the summary.
    expect(rendered).toContain('[tool call call_retained_input]');
    expect(rendered).toContain('drop_result');
    expect(rendered).toContain('fast-jev-compaction truncated');
    expect(rendered).not.toContain(tail);
  });

  it('renders deterministically and never starts with the library summary prefix', () => {
    const first = summaryFor(longInput(), [DROP_RESULT]);
    const second = summaryFor(longInput(), [DROP_RESULT]);
    expect(first).toBe(second);
    expect(first.startsWith('Another language model started to solve this problem')).toBe(false);
  });
});

describe('compaction response construction', () => {
  const body = (input: unknown) => JSON.stringify({ model: 'test', stream: true, input });

  it('answers an SSE completion that names the Jev-rendered summary', async () => {
    const asker = new MarkerAsker('drop-result');
    const outcome = await buildCompactionResponse(body(longInput()), asker, { stream: true });
    expect(outcome.status).toBe(200);
    expect(outcome.contentType).toBe('text/event-stream');
    expect(outcome.body).toContain('event: response.output_item.done');
    expect(outcome.body).toContain('event: response.completed');
    expect(outcome.body).toContain(SUMMARY_MARKER);
    expect(outcome.headers['x-fast-jev-compaction']).toContain('results_dropped=1');
    expect(asker.asks).toBe(1);
  });

  it('makes no Jev request and fails explicitly when there is nothing to decide', async () => {
    const asker = new MarkerAsker('drop-result');
    const input = [textItem('user', 'short chat'), assistantText('hello'), textItem('user', PROMPT)];
    await expect(buildCompactionResponse(body(input), asker, { stream: true })).rejects.toMatchObject({
      kind: 'no-candidates',
    });
    expect(asker.asks).toBe(0);
  });

  it('fails when Jev is unavailable, when nothing is dropped, and on bad input', async () => {
    await expect(
      buildCompactionResponse(body(longInput()), new MarkerAsker('fail'), { stream: true }),
    ).rejects.toMatchObject({ kind: 'jev-failed' });
    await expect(
      buildCompactionResponse(body(longInput()), new MarkerAsker('keep'), { stream: true }),
    ).rejects.toMatchObject({ kind: 'no-reduction' });
    await expect(
      buildCompactionResponse('not json', new MarkerAsker(), { stream: true }),
    ).rejects.toBeInstanceOf(CompactionUnavailable);
    await expect(
      buildCompactionResponse(JSON.stringify({ input: 'nope' }), new MarkerAsker(), { stream: true }),
    ).rejects.toMatchObject({ kind: 'missing-input' });
  });
});

describe('Jev timeout wiring', () => {
  const requestBody = (input: unknown) => JSON.stringify({ model: 'test', stream: true, input });

  it('aborts an injected hanging Jev fetch and covers body consumption', async () => {
    const signals: AbortSignal[] = [];
    let calls = 0;
    const hangingFetch: typeof fetch = (_input, init) => {
      calls += 1;
      const signal = init?.signal;
      if (!signal) throw new Error('the adapter must pass an AbortSignal');
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    const client = new JevClient({
      apiKey: 'unit-test-key',
      baseUrl: 'http://127.0.0.1:9/jev',
      fetch: createJevTimeoutFetch(hangingFetch, 20),
    });
    await expect(
      buildCompactionResponse(requestBody(longInput()), client, { stream: true }),
    ).rejects.toMatchObject({
      kind: 'jev-failed',
      message: 'Jev request timed out after 20ms',
    });
    expect(calls).toBe(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0].aborted).toBe(true);

    // The timeout must stay armed while the response body is being read.
    const stuckBodyFetch: typeof fetch = () =>
      Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }));
    const stuckClient = new JevClient({
      apiKey: 'unit-test-key',
      baseUrl: 'http://127.0.0.1:9/jev',
      fetch: createJevTimeoutFetch(stuckBodyFetch, 20),
    });
    await expect(
      stuckClient.ask({ context: '', goal: '', history: [] }, { q: { type: 'noul', instructions: 'q' } }),
    ).rejects.toThrow('Jev request timed out after 20ms');
  });
});

describe('isProxySameOrigin', () => {
  it('accepts only the exact proxy origin', async () => {
    const { isProxySameOrigin } = await import('../codex/jev-compaction-proxy.js');
    expect(isProxySameOrigin('http://192.168.4.47:8787', 'http://192.168.4.47:8787')).toBe(true);
    expect(isProxySameOrigin('http://127.0.0.1:8787', 'http://127.0.0.1:8787')).toBe(true);
    expect(isProxySameOrigin('https://evil.example', 'http://192.168.4.47:8787')).toBe(false);
    expect(isProxySameOrigin(null, 'http://192.168.4.47:8787')).toBe(false);
    expect(isProxySameOrigin('http://192.168.4.47:8787', 'http://127.0.0.1:8787')).toBe(false);
  });
});
