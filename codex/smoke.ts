/**
 * Credential-free end-to-end acceptance for the Codex adapter.
 *
 * Run:  deno run --allow-read --allow-write --allow-env --allow-net=127.0.0.1 \
 *         --allow-run=/Users/nv/.codex/bin/codex codex/smoke.ts
 *
 * Everything runs on loopback ephemeral ports inside a temporary directory:
 * a fake provider upstream, a fake Jev, the real proxy module, and the
 * installed Codex `app-server` pointed at the proxy through an isolated
 * CODEX_HOME. No real credentials, MCP servers, hooks, projects, or .env are
 * discovered, and no live model or Jev request is made.
 */
import { startProxy } from './jev-compaction-proxy.ts';
import { SUMMARY_MARKER } from './codex-items.ts';

const CODEX_BIN = '/Users/nv/.codex/bin/codex';
const DEADLINE_MS = 90_000;
const STEP_TIMEOUT_MS = 20_000;
const STARTED_AT = Date.now();
const PROXY_API_KEY = 'smoke-test-key-not-a-credential';

const GOAL_TEXT = 'build the fixture history';
const POST_TURN = 'post-compaction probe';
const FILLER_TEXT = 'filler turn two';
const ALPHA_MARKER = 'ALPHA_FIXTURE_OK';
const BETA_HEAD = 'BETA_FIXTURE_HEAD';
const BETA_TAIL = 'BETA_FIXTURE_TAIL_MUST_BE_TRUNCATED';
const GAMMA_MARKER = 'GAMMA_KEEP_MARKER_STAYS_VERBATIM';
const PROMPT_MARKERS = ['CONTEXT CHECKPOINT COMPACTION'];
const BETA_FILLER = 'beta filler text '.repeat(120);

const cmd = (text: string): string => `printf '%s' '${text}'`;

/**
 * Octal escapes for a marker that must exist only in tool *output*. A
 * `drop_result` decision keeps the call with its input, so the literal tail in
 * the generating command would survive in the summary and defeat the dropped
 * tail assertion; the escapes make `printf` emit it without it appearing in the
 * call arguments.
 */
function octalEscapes(text: string): string {
  return [...text].map((char) => `\\${char.codePointAt(0)?.toString(8).padStart(3, '0') ?? '000'}`).join('');
}

/** Beta output is head + filler + tail; only the tail is written from escapes. */
const BETA_COMMAND = `printf '${BETA_HEAD} ${BETA_FILLER}${octalEscapes(BETA_TAIL)}'`;

function require_(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function remaining(): number {
  return DEADLINE_MS - (Date.now() - STARTED_AT);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Diagnostics only, and only on synthetic fixture data or structural fields:
 * never transcript text, tool output, or provider payloads.
 */
function safeExcerpt(value: string, limit = 400): string {
  return value.replaceAll('\n', ' ').slice(0, limit);
}

/**
 * The Jev summary Codex adopted, cut out of a provider request body: from the
 * adapter's own marker to the new user turn that follows it. Adoption
 * assertions read this window, so fixture replay material can neither satisfy
 * nor defeat them.
 */
function adoptedSummary(body: string): string {
  const start = body.indexOf(SUMMARY_MARKER);
  if (start < 0) return '';
  const end = body.indexOf(POST_TURN, start);
  return end < 0 ? body.slice(start) : body.slice(start, end);
}

/** Method plus item type/status only: never message text or tool payloads. */
function structuralNotification(message: RpcMessage): string {
  const method = message.method ?? 'notification';
  const params = message.params ?? {};
  const item = params.item && typeof params.item === 'object' ? params.item as Record<string, unknown> : {};
  const turn = params.turn && typeof params.turn === 'object' ? params.turn as Record<string, unknown> : {};
  const detail = [item.type, item.status, turn.status].filter((value) => typeof value === 'string' && value).join('/');
  return detail ? `${method}:${detail}` : method;
}

interface UpstreamRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  compaction: boolean;
}

interface ToolCallSpec {
  name: string;
  arguments: string;
}

/** Fake provider upstream: scripted Responses SSE, records every request. */
class FakeUpstream {
  readonly requests: UpstreamRequest[] = [];
  toolNames: string[] = [];
  private script: 'chain' | 'alpha-only' = 'chain';
  /**
   * Latched once every scripted step has been observed in a request. Post-
   * compaction verification turns (and every later turn) then get an ordinary
   * reply only: an unlatched reactive script would replay the dropped alpha
   * call and pollute the very transcript the adoption assertions inspect.
   */
  private chainServed = false;
  private server!: Deno.HttpServer;
  private shellTool: { name: string; parameters: Record<string, unknown> } | null = null;

  get mode(): 'chain' | 'alpha-only' {
    return this.script;
  }

  /** Switching scripts starts a fresh history, so the latch resets too. */
  set mode(next: 'chain' | 'alpha-only') {
    this.script = next;
    this.chainServed = false;
  }

  static async start(): Promise<FakeUpstream> {
    const fake = new FakeUpstream();
    let resolveAddr: (addr: Deno.NetAddr) => void = () => {};
    const listening = new Promise<Deno.NetAddr>((resolve) => {
      resolveAddr = resolve;
    });
    fake.server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: (addr) => resolveAddr(addr as Deno.NetAddr) }, (request) =>
      fake.handle(request));
    const addr = await listening;
    fake.url = `http://127.0.0.1:${addr.port}`;
    return fake;
  }

  url = '';

  compactionRequests(): UpstreamRequest[] {
    return this.requests.filter((entry) => entry.compaction);
  }

  bodiesMatching(needle: string): UpstreamRequest[] {
    return this.requests.filter((entry) => entry.body.includes(needle));
  }

  async close(): Promise<void> {
    await this.server.shutdown();
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
    const headers: Record<string, string> = {};
    for (const [name, value] of request.headers) headers[name.toLowerCase()] = value;
    let compaction = false;
    try {
      const metadata = JSON.parse(headers['x-codex-turn-metadata'] ?? 'null') as { request_kind?: string } | null;
      compaction = metadata?.request_kind === 'compaction';
    } catch {
      compaction = false;
    }
    this.requests.push({ method: request.method, path: url.pathname + url.search, headers, body, compaction });
    if (url.pathname === '/healthz') return new Response('fake upstream ready\n');

    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
    this.toolNames = tools
      .map((tool) => (tool && typeof tool === 'object' ? String((tool as { name?: unknown }).name ?? '') : ''))
      .filter(Boolean);
    this.shellTool = pickShellTool(tools);

    const next = this.nextCall(body);
    const items: unknown[] = [];
    if (next) {
      items.push(assistantItem(`Normal turn narration before ${next.name}.`));
      items.push({
        type: 'function_call',
        call_id: `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
        name: next.name,
        arguments: next.arguments,
      });
    } else {
      const reply = this.mode === 'chain' ? 'NORMAL_REPLY_MARKER_CHAIN_DONE' : 'NORMAL_REPLY_MARKER_THREAD_TWO';
      items.push(assistantItem(reply));
    }
    return sseResponse(items);
  }

  /**
   * Reactive script: emit the fixture tool calls until every step has been seen
   * in a provider request, then latch and answer ordinarily forever. `probe` is
   * plaintext that survives JSON encoding; `command` is what gets emitted (the
   * beta command carries octal escapes, so its own text is not a usable probe).
   */
  private nextCall(body: string): ToolCallSpec | null {
    if (!this.shellTool) return null;
    if (this.chainServed) return null;
    const steps: Array<{ probe: string; command: string }> = this.mode === 'chain'
      ? [
        { probe: ALPHA_MARKER, command: cmd(ALPHA_MARKER) },
        { probe: BETA_HEAD, command: BETA_COMMAND },
        { probe: GAMMA_MARKER, command: cmd(GAMMA_MARKER) },
      ]
      : [{ probe: ALPHA_MARKER, command: cmd(ALPHA_MARKER) }];
    for (const step of steps) {
      if (!body.includes(step.probe)) {
        const args = buildCallArguments(this.shellTool, step.command);
        if (args) return { name: this.shellTool.name, arguments: JSON.stringify(args) };
      }
    }
    this.chainServed = true;
    return null;
  }
}

function assistantItem(text: string): unknown {
  return {
    type: 'message',
    role: 'assistant',
    id: `msg_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
    content: [{ type: 'output_text', text }],
  };
}

function sseResponse(items: readonly unknown[]): Response {
  const chunks: string[] = [];
  for (const item of items) {
    chunks.push(`event: response.output_item.done\ndata: ${
      JSON.stringify({ type: 'response.output_item.done', item })
    }\n\n`);
  }
  chunks.push(`event: response.completed\ndata: ${
    JSON.stringify({ type: 'response.completed', response: { id: `resp_${crypto.randomUUID()}` } })
  }\n\n`);
  return new Response(chunks.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
  });
}

/** Picks any advertised tool that can run a command, from its own JSON schema. */
function pickShellTool(tools: readonly unknown[]): { name: string; parameters: Record<string, unknown> } | null {
  const usable: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const record = tool as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : '';
    const parameters = record.parameters && typeof record.parameters === 'object'
      ? record.parameters as Record<string, unknown>
      : null;
    if (!name || !parameters) continue;
    const properties = parameters.properties && typeof parameters.properties === 'object'
      ? parameters.properties as Record<string, unknown>
      : {};
    if ('cmd' in properties || 'command' in properties) usable.push({ name, parameters });
  }
  const preferred = ['exec_command', 'shell', 'local_shell', 'unified_exec', 'container.exec'];
  for (const name of preferred) {
    const match = usable.find((tool) => tool.name === name);
    if (match) return match;
  }
  return usable[0] ?? null;
}

function buildCallArguments(
  tool: { name: string; parameters: Record<string, unknown> },
  command: string,
): Record<string, unknown> | null {
  const properties = tool.parameters.properties && typeof tool.parameters.properties === 'object'
    ? tool.parameters.properties as Record<string, unknown>
    : {};
  const argSchema = (key: string): Record<string, unknown> =>
    properties[key] && typeof properties[key] === 'object' ? properties[key] as Record<string, unknown> : {};
  const args: Record<string, unknown> = {};
  if ('cmd' in properties) {
    args.cmd = command;
    if ('login' in properties) args.login = false;
    if ('yield_time_ms' in properties) args.yield_time_ms = 10_000;
  } else if ('command' in properties) {
    args.command = argSchema('command').type === 'string' ? command : ['bash', '-lc', command];
  } else {
    return null;
  }
  if ('timeout_ms' in properties) args.timeout_ms = 10_000;
  return args;
}

interface JevRequestRecord {
  stateJson: string;
  questionNames: string[];
  authorization: string;
}

/** Fake Jev: real HTTP hop, decisions driven by fixture markers in the state. */
class FakeJev {
  readonly requests: JevRequestRecord[] = [];
  mode: 'decide' | 'fail' = 'decide';
  private server!: Deno.HttpServer;

  static async start(): Promise<FakeJev> {
    const fake = new FakeJev();
    let resolveAddr: (addr: Deno.NetAddr) => void = () => {};
    const listening = new Promise<Deno.NetAddr>((resolve) => {
      resolveAddr = resolve;
    });
    fake.server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: (addr) => resolveAddr(addr as Deno.NetAddr) }, (request) =>
      fake.handle(request));
    const addr = await listening;
    fake.url = `http://127.0.0.1:${addr.port}`;
    return fake;
  }

  url = '';

  async close(): Promise<void> {
    await this.server.shutdown();
  }

  private async handle(request: Request): Promise<Response> {
    const body = await request.text();
    let parsed: { state?: unknown; questions?: Record<string, unknown> } = {};
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      parsed = {};
    }
    const questions = parsed.questions && typeof parsed.questions === 'object' ? parsed.questions : {};
    this.requests.push({
      stateJson: JSON.stringify(parsed.state ?? null),
      questionNames: Object.keys(questions),
      authorization: request.headers.get('authorization') ?? '',
    });
    if (this.mode === 'fail') {
      return new Response(JSON.stringify({ error: 'synthetic Jev outage' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ model: 'fake-jev', answers: answersFor(parsed.state, questions) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
}

function answersFor(state: unknown, questions: Record<string, unknown>): Record<string, { noul: number }> {
  const actions = new Map<string, 'drop_call' | 'drop_result' | 'keep'>();
  const history = state && typeof state === 'object' && Array.isArray((state as { history?: unknown }).history)
    ? (state as { history: unknown[] }).history
    : [];
  for (const entry of history) {
    const calls = entry && typeof entry === 'object' && Array.isArray((entry as { tool_calls?: unknown }).tool_calls)
      ? (entry as { tool_calls: unknown[] }).tool_calls
      : [];
    for (const call of calls) {
      const text = typeof call === 'string' ? call : JSON.stringify(call);
      const id = typeof call === 'string'
        ? call.split(' ')[0]
        : String((call as { id?: unknown })?.id ?? '');
      if (!id) continue;
      if (text.includes(ALPHA_MARKER)) actions.set(id, 'drop_call');
      else if (text.includes(BETA_HEAD)) actions.set(id, 'drop_result');
      else if (text.includes(GAMMA_MARKER)) actions.set(id, 'keep');
    }
  }
  const answers: Record<string, { noul: number }> = {};
  for (const name of Object.keys(questions)) {
    const action = actions.get(name.replace(/^(call|result)_/, '')) ?? 'keep';
    let noul = 0.95;
    if (action === 'drop_call') noul = 0.1;
    else if (action === 'drop_result') noul = name.startsWith('result_') ? 0.05 : 0.9;
    answers[name] = { noul };
  }
  return answers;
}

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/** Minimal JSON-RPC client for `codex app-server` over stdio. */
class AppServer {
  readonly notifications: RpcMessage[] = [];
  readonly serverRequests: string[] = [];
  stderr = '';
  exited = false;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private writer!: WritableStreamDefaultWriter<Uint8Array>;
  private child!: Deno.ChildProcess;
  private stderrTail = '';

  static async start(cwd: string, env: Record<string, string>): Promise<AppServer> {
    const server = new AppServer();
    server.child = new Deno.Command(CODEX_BIN, {
      args: ['app-server'],
      cwd,
      env,
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
    server.writer = server.child.stdin.getWriter();
    void server.pumpStdout();
    void server.pumpStderr();
    await server.request('initialize', {
      clientInfo: { name: 'fast-jev-compaction-smoke', title: 'smoke', version: '0.1.0' },
    });
    server.notify('initialized', {});
    return server;
  }

  private async pumpStdout(): Promise<void> {
    const reader = this.child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line) this.handleLine(line);
          index = buffer.indexOf('\n');
        }
      }
    } catch {
      // The child exited; `exited` and pending rejections carry the diagnosis.
    } finally {
      this.exited = true;
      for (const { reject } of this.pending.values()) reject(new Error('codex app-server exited'));
      this.pending.clear();
    }
  }

  private async pumpStderr(): Promise<void> {
    const reader = this.child.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.stderrTail = (this.stderrTail + decoder.decode(value, { stream: true })).slice(-4000);
        this.stderr = this.stderrTail;
      }
    } catch {
      // Ignore: stdout diagnostics are enough.
    }
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    if (message.id !== undefined && message.method) {
      // Server-initiated request; the smoke never needs approvals.
      this.serverRequests.push(message.method);
      this.write({ jsonrpc: '2.0', id: message.id, result: {} });
      return;
    }
    if (message.id !== undefined) {
      const waiter = this.pending.get(Number(message.id));
      if (!waiter) return;
      this.pending.delete(Number(message.id));
      if (message.error) waiter.reject(new Error(`${JSON.stringify(message.error).slice(0, 300)}`));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method) this.notifications.push(message);
  }

  private write(payload: unknown): void {
    void this.writer.write(new TextEncoder().encode(`${JSON.stringify(payload)}\n`));
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ jsonrpc: '2.0', id, method, params });
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${method} response`)), STEP_TIMEOUT_MS)
    );
    return await Promise.race([promise, timeout]);
  }

  cursor(): number {
    return this.notifications.length;
  }

  async waitFor(
    predicate: (message: RpcMessage) => boolean,
    label: string,
    timeoutMs = STEP_TIMEOUT_MS,
    from = 0,
  ): Promise<RpcMessage> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const found = this.notifications.slice(from).find(predicate);
      if (found) return found;
      if (this.exited) throw new Error(`codex app-server exited while waiting for ${label}`);
      await delay(50);
    }
    throw new Error(`timed out (${timeoutMs}ms) waiting for ${label}`);
  }

  async stop(): Promise<void> {
    try {
      this.child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
    const exited = await Promise.race([
      this.child.status.then(() => true),
      delay(2000).then(() => false),
    ]);
    if (!exited) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
    this.exited = true;
  }
}

interface ThreadHandle {
  id: string;
  runTurn(text: string): Promise<RpcMessage[]>;
  compact(): Promise<{ ok: boolean; detail: string }>;
}

function threadIdOf(result: unknown): string {
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const thread = record.thread && typeof record.thread === 'object' ? record.thread as Record<string, unknown> : {};
  const id = thread.id ?? record.threadId ?? record.id;
  require_(typeof id === 'string' && id.length > 0, `thread/start returned no thread id: ${JSON.stringify(result).slice(0, 200)}`);
  return id;
}

function statusOf(message: RpcMessage): string {
  const params = message.params ?? {};
  const turn = params.turn && typeof params.turn === 'object' ? params.turn as Record<string, unknown> : {};
  return String(turn.status ?? params.status ?? 'unknown');
}

function turnIdOf(message: RpcMessage): string | null {
  const params = message.params ?? {};
  const turn = params.turn && typeof params.turn === 'object' ? params.turn as Record<string, unknown> : {};
  const id = params.turnId ?? turn.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

async function openThread(rpc: AppServer, cwd: string): Promise<ThreadHandle> {
  const result = await rpc.request('thread/start', {
    cwd,
    approvalPolicy: 'never',
    sandbox: 'read-only',
  });
  const id = threadIdOf(result);
  return {
    id,
    async runTurn(text: string): Promise<RpcMessage[]> {
      const from = rpc.cursor();
      await rpc.request('turn/start', { threadId: id, input: [{ type: 'text', text }] });
      const completed = await rpc.waitFor(
        (message) => message.method === 'turn/completed' && message.params?.threadId === id,
        `turn/completed for ${text.slice(0, 40)}`,
        STEP_TIMEOUT_MS,
        from,
      );
      const status = statusOf(completed);
      require_(status === 'completed', `turn "${text.slice(0, 40)}" ended with status ${status}`);
      return rpc.notifications.slice(from);
    },
    async compact(): Promise<{ ok: boolean; detail: string }> {
      const from = rpc.cursor();
      try {
        await rpc.request('thread/compact/start', { threadId: id });
      } catch (error) {
        return { ok: false, detail: `compact/start rejected: ${safeExcerpt(String(error), 200)}` };
      }
      // The compact task owns a real turn: the contextCompaction item completes
      // before that turn settles, and a turn/start sent in between is rejected
      // with ActiveTurnNotSteerable { turn_kind: Compact }. So bind events to the
      // compact turn id and report the outcome only once that same turn reaches
      // turn/completed; the failure path awaits the same settlement before the
      // caller probes history.
      const end = Date.now() + STEP_TIMEOUT_MS;
      let compactTurnId: string | null = null;
      let compacted = false;
      let failure: string | null = null;
      while (Date.now() < end) {
        for (const message of rpc.notifications.slice(from)) {
          const forThread = message.params?.threadId === id;
          const eventTurnId = turnIdOf(message);
          if (forThread && eventTurnId && compactTurnId === null) compactTurnId = eventTurnId;
          if (
            forThread && message.method === 'item/completed' &&
            (message.params?.item as { type?: string } | undefined)?.type === 'contextCompaction'
          ) {
            compacted = true;
          }
          if (message.method === 'error' && failure === null) {
            failure = `${message.method}: ${safeExcerpt(JSON.stringify(message.params ?? {}), 200)}`;
          }
          if (!forThread || message.method !== 'turn/completed') continue;
          if (compactTurnId !== null && eventTurnId !== compactTurnId) continue;
          const status = statusOf(message);
          if (status === 'completed' && compacted) {
            return { ok: true, detail: `contextCompaction + turn/completed (${status})` };
          }
          return {
            ok: false,
            detail: failure ??
              (compacted
                ? `turn/completed (${status}) after the contextCompaction item`
                : `turn/completed (${status}) without a contextCompaction item`),
          };
        }
        await delay(50);
      }
      const seen = [...new Set(rpc.notifications.slice(from).map((message) => message.method))].join(', ');
      return { ok: false, detail: failure ?? `timed out waiting for the compaction outcome; methods=${seen || 'none'}` };
    },
  };
}

function configToml(port: number, workDir: string): string {
  return `# Generated by codex/smoke.ts: isolated, credential-free acceptance config.
model = "jevtest-model"
model_provider = "jevtest"
approval_policy = "never"
sandbox_mode = "read-only"
model_context_window = 120000
model_auto_compact_token_limit = 100000

[model_providers.jevtest]
name = "jevtest"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
stream_max_retries = 0
request_max_retries = 0

[projects."${workDir}"]
trust_level = "trusted"
`;
}

async function main(): Promise<void> {
  // Fixture invariant: the dropped beta tail must not be spelled out in the
  // command that produces it, or the retained call input would keep it alive.
  require_(!BETA_COMMAND.includes(BETA_TAIL), 'the beta command must not embed the dropped tail literal');
  require_(BETA_COMMAND.includes(BETA_HEAD), 'the beta command must still name the call for the Jev decision');
  const tmp = await Deno.makeTempDir({ prefix: 'jev-codex-smoke-' });
  const codexHome = `${tmp}/codex-home`;
  const workDir = `${tmp}/work`;
  await Deno.mkdir(codexHome, { recursive: true });
  await Deno.mkdir(workDir, { recursive: true });
  const proxyLog: string[] = [];
  const upstream = await FakeUpstream.start();
  const jev = await FakeJev.start();
  const proxy = await startProxy({
    port: 0,
    upstreamOrigin: upstream.url,
    jevBaseUrl: jev.url,
    apiKey: PROXY_API_KEY,
    log: (line) => proxyLog.push(line),
  });
  let rpc: AppServer | null = null;
  try {
    // 1. Health endpoint: simple status text, never a JSON `ok` body.
    const health = await fetch(`${proxy.url}/healthz`);
    const healthBody = await health.text();
    require_(health.status === 200, `healthz returned ${health.status}`);
    require_(healthBody.includes('fast-jev-compaction'), 'healthz body does not identify the proxy');
    require_(!healthBody.includes('"ok"'), 'healthz must not answer a JSON ok body');
    console.log(`PASS healthz: ${health.status} ${safeExcerpt(healthBody, 80)}`);

    // 2. Pass-through fidelity probe: query, method, authorization, status, body.
    const probe = await fetch(`${proxy.url}/v1/responses?probe=1`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer passthrough-probe-token',
        'x-codex-turn-metadata': JSON.stringify({ request_kind: 'turn' }),
      },
      body: JSON.stringify({ stream: true, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'PROBE' }] }] }),
    });
    const probeText = await probe.text();
    require_(probe.status === 200, `passthrough probe returned ${probe.status}`);
    require_(probeText.includes('NORMAL_REPLY_MARKER'), 'passthrough probe did not receive the upstream SSE body');
    const probeRecord = upstream.requests.find((entry) => entry.path.includes('probe=1'));
    require_(probeRecord, 'passthrough probe never reached the fake upstream');
    require_(probeRecord.method === 'POST', 'passthrough changed the method');
    require_(probeRecord.headers.authorization === 'Bearer passthrough-probe-token', 'passthrough dropped or rewrote Authorization');
    require_(!probeRecord.compaction, 'the ordinary probe was misread as compaction');
    console.log(`PASS passthrough: POST ?probe=1 preserved query+auth (${safeExcerpt(probeRecord.headers['x-codex-turn-metadata'] ?? '', 40)})`);

    // 3. Credential-free Codex app-server with an isolated CODEX_HOME.
    await Deno.writeTextFile(`${codexHome}/config.toml`, configToml(proxy.port, workDir));
    const childEnv = {
      CODEX_HOME: codexHome,
      HOME: codexHome,
      PATH: Deno.env.get('PATH') ?? '/usr/bin:/bin',
      TMPDIR: tmp,
      TERM: 'dumb',
      LANG: 'C.UTF-8',
      NO_COLOR: '1',
      RUST_LOG: 'error',
    };
    rpc = await AppServer.start(workDir, childEnv);
    require_(rpc.serverRequests.length === 0, `unexpected server requests during startup: ${rpc.serverRequests.join(', ')}`);
    console.log('PASS app-server: initialize handshake accepted');

    // 4. Build real tool-call history through the installed CLI.
    const thread = await openThread(rpc, workDir);
    const chain = await thread.runTurn(GOAL_TEXT);
    const streamedText = chain
      .filter((message) => message.method === 'item/completed')
      .map((message) => JSON.stringify(message.params ?? {}))
      .join(' ');
    require_(
      streamedText.includes('NORMAL_REPLY_MARKER_CHAIN_DONE'),
      'normal assistant content did not stream through the proxy unchanged',
    );
    const chainRequests = upstream.bodiesMatching(ALPHA_MARKER);
    require_(chainRequests.length > 0, `the fake upstream never received a request carrying the fixture tool call; tools=${upstream.toolNames.join(',')}`);
    require_(upstream.bodiesMatching(GAMMA_MARKER).length > 0, 'fixture chain did not reach the third tool call');
    console.log(`PASS history: tool-call chain executed (tools advertised: ${upstream.toolNames.slice(0, 4).join(', ') || 'none'})`);

    await thread.runTurn('filler turn one');
    await thread.runTurn('filler turn two');
    require_(upstream.compactionRequests().length === 0, 'a compaction request reached the fake upstream before compaction ran');

    // 5. Compaction: Jev-rendered summary replaces the history.
    const jevBefore = jev.requests.length;
    const proxyAttemptsBefore = proxy.compactionAttempts();
    const outcome = await thread.compact();
    require_(outcome.ok, `compaction did not succeed: ${outcome.detail}`);
    require_(
      proxy.compactionAttempts() === proxyAttemptsBefore + 1,
      `expected exactly one intercepted compaction, saw ${proxy.compactionAttempts() - proxyAttemptsBefore}`,
    );
    const jevCalls = jev.requests.length - jevBefore;
    require_(jevCalls === 1, `expected exactly one Jev request for the compaction, saw ${jevCalls}`);
    const jevRequest = jev.requests[jev.requests.length - 1];
    require_(jevRequest.authorization === `Bearer ${PROXY_API_KEY}`, 'the Jev hop did not use its own key');
    require_(
      !PROMPT_MARKERS.some((marker) => jevRequest.stateJson.includes(marker)),
      'the injected Codex compaction prompt reached the Jev state',
    );
    const jevState = JSON.parse(jevRequest.stateJson) as {
      history?: Array<{ role?: string; text?: string; tool_calls?: unknown[] }>;
    };
    const jevHistory = Array.isArray(jevState.history) ? jevState.history : [];
    require_(
      jevHistory.some((entry) => entry.role === 'user' && (entry.text ?? '').includes(FILLER_TEXT)),
      'earlier real user content is missing from the Jev state',
    );
    require_(
      JSON.stringify(jevHistory).includes(GAMMA_MARKER),
      'the third fixture tool call is missing from the Jev state',
    );
    require_(upstream.compactionRequests().length === 0, 'the compaction request was forwarded to the fake upstream');
    console.log(`PASS compaction: 1 Jev request, ${jevRequest.questionNames.length} questions, prompt excluded, upstream never saw it`);

    // 6. Codex adopted the rendered summary in the next request.
    const after = await thread.runTurn(POST_TURN);
    const postRequests = upstream.requests.filter((entry) =>
      entry.body.includes(POST_TURN) && !entry.compaction
    );
    require_(postRequests.length > 0, 'the post-compaction turn never reached the fake upstream');
    // A replayed fixture tool call would add a provider request that carries
    // dropped content back into the transcript after compaction.
    require_(
      postRequests.every((entry) => !entry.body.includes(ALPHA_MARKER)),
      'the fake upstream replayed a dropped tool call after compaction',
    );
    const postRequest = postRequests[0];
    require_(postRequest.body.includes(SUMMARY_MARKER), 'the next request does not contain the Jev summary marker');
    require_(
      postRequest.body.includes('Another language model started to solve this problem'),
      'Codex did not install the summary with its own SUMMARY_PREFIX',
    );
    // Everything below reads the summary Codex actually adopted, not material
    // the fixture generated after compaction.
    const summary = adoptedSummary(postRequest.body);
    require_(summary.length > 500, `the adopted summary window is implausibly small (${summary.length} chars)`);
    require_(summary.includes('[fast-jev-compaction stats]'), 'the adopted summary is missing its structural trailer');
    require_(
      summary.includes('results_dropped=1 ') && summary.includes('calls_dropped=1 '),
      'the adopted summary does not report the fixture decisions',
    );
    require_(summary.includes('drop_result'), 'the kept call was not rendered with its drop_result notice');
    require_(summary.includes(GAMMA_MARKER), 'a kept tool result was lost from the compacted memory');
    require_(summary.includes('fast-jev-compaction truncated'), 'the truncated result notice is missing from the compacted memory');
    require_(!summary.includes(ALPHA_MARKER), 'a dropped call/result is still present in the adopted summary');
    require_(
      !summary.includes(BETA_TAIL),
      'a dropped result tail survived compaction (kept call input or result head)',
    );
    require_(summary.includes(GOAL_TEXT), 'the real user goal did not survive compaction');
    require_(after.length > 0, 'the post-compaction turn produced no notifications');
    console.log(
      `PASS adoption: next request carries the Jev summary (${summary.length} chars), keeps the kept result, drops the dropped ones`,
    );

    // 7. Failure path: Jev outage leaves the original history available.
    jev.mode = 'fail';
    upstream.mode = 'alpha-only';
    const failing = await openThread(rpc, workDir);
    await failing.runTurn('failure-path fixture history');
    await failing.runTurn('failure-path filler one');
    await failing.runTurn('failure-path filler two');
    await failing.runTurn('failure-path filler three');
    const attemptsBeforeFailure = proxy.compactionAttempts();
    const failed = await failing.compact();
    require_(!failed.ok, 'compaction reported success although Jev was failing');
    require_(
      proxy.compactionAttempts() === attemptsBeforeFailure + 1,
      'the failing compaction was not intercepted exactly once',
    );
    require_(jev.requests.length > jevCalls, 'the failure path never reached Jev');
    const survivor = await failing.runTurn('post-failure probe');
    const failureRequest = upstream.requests.filter((entry) => entry.body.includes('post-failure probe')).pop();
    require_(failureRequest, 'the post-failure turn never reached the fake upstream');
    require_(failureRequest.body.includes(ALPHA_MARKER), 'original tool output was lost after a failed compaction');
    require_(!failureRequest.body.includes(SUMMARY_MARKER), 'a summary was installed although compaction failed');
    require_(survivor.length > 0, 'the post-failure turn produced no notifications');
    console.log(`PASS failure: compaction failed (${safeExcerpt(failed.detail, 80)}), original history still present`);

    console.log(`PASS proxy log: ${proxyLog.filter((line) => line.startsWith('compaction')).join(' | ')}`);
    console.log(`PASS e2e complete in ${Date.now() - STARTED_AT}ms (upstream requests=${upstream.requests.length}, jev calls=${jev.requests.length})`);
  } catch (error) {
    console.error(`FAIL codex/smoke.ts: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`DIAG notifications: ${rpc?.notifications.map((message) => message.method).join(', ').slice(0, 600) ?? 'none'}`);
    console.error(`DIAG notification tail: ${(rpc?.notifications.slice(-4) ?? []).map(structuralNotification).join(' || ')}`);
    console.error(`DIAG serverRequests: ${rpc?.serverRequests.join(', ') || 'none'}`);
    console.error(`DIAG upstream: ${upstream.requests.map((entry) => `${entry.method} ${entry.path}${entry.compaction ? ' [compaction]' : ''} ${entry.body.length}b`).join(' | ').slice(0, 600)}`);
    console.error(`DIAG jev calls: ${jev.requests.length}; proxy log: ${proxyLog.slice(-4).join(' | ').slice(0, 400)}`);
    {
      const last = upstream.requests.at(-1)?.body ?? '';
      const window = adoptedSummary(last);
      console.error(
        `DIAG adopted summary: ${window.length}/${last.length} chars; marker=${window.startsWith(SUMMARY_MARKER)}` +
          ` betaHead=${window.includes(BETA_HEAD)} betaTail=${window.includes(BETA_TAIL)}` +
          ` truncated=${window.includes('fast-jev-compaction truncated')} alpha=${window.includes(ALPHA_MARKER)}` +
          ` gamma=${window.includes(GAMMA_MARKER)} goal=${window.includes(GOAL_TEXT)}`,
      );
    }
    console.error(`DIAG codex stderr tail: ${safeExcerpt(rpc?.stderr ?? '', 500)}`);
    throw error;
  } finally {
    await rpc?.stop();
    await proxy.close();
    await jev.close();
    await upstream.close();
    try {
      await Deno.remove(tmp, { recursive: true });
    } catch {
      // Best effort; the temp directory is outside the repository.
    }
  }
}

require_(remaining() > 10_000, 'the smoke test ran out of its 90s budget before starting');
await main();
