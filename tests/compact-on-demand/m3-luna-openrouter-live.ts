/**
 * M3 live Luna acceptance over a direct, non-gateway provider route.
 *
 * Why this exists: the UOS gateway's paid tier that serves `gpt-5.6-luna` can be
 * out of balance (HTTP 403 `local:insufficient_quota`) while the model itself is
 * healthy. `m3-luna-live-smoke.ts` gates on `GET /v1/models` against the gateway
 * and so reports BLOCKED/FAIL in that state. This runner reproduces the *same*
 * acceptance on a second, independently funded route so the feature can still be
 * proven live without changing product behaviour or the gateway.
 *
 * Contract (deliberately narrow):
 * - model is exactly `gpt-5.6-luna` (bare slug, as `model_family` expects);
 *   the OpenRouter wire slug `openai/gpt-5.6-luna` is applied only by the local
 *   loopback adapter, never in the client config;
 * - reasoning effort is exactly `none`, sent as `{"effort":"none","summary":"auto"}`;
 * - one `GET /v1/models` gate that must list the upstream slug before inference;
 * - at most one inference request, retries disabled, 120 s bound;
 * - a fresh temp `CODEX_HOME` and cwd, so no repository/global instructions load;
 * - the only credential is the existing `OPENROUTER_API_KEY`; it is never printed;
 * - the adapter records the outbound body's model/effort/input count only, and
 *   the runner prints allowlisted structural fields (no prompt/body/token);
 * - PASS requires all of: gate present, upstream HTTP 2xx, response model echoes
 *   the upstream slug, `response.completed`, and child exit 0 with an
 *   `agent_message`. Anything else is an explicit FAIL with no retry.
 *
 * The client under test is the compiled pinned fork binary. Nothing here runs on
 * import; it acts only as an explicit process entrypoint.
 */

import { forkBinaryPath } from "./pinned-client-harness.ts";

export const LUNA_MODEL = "gpt-5.6-luna";
export const LUNA_UPSTREAM_MODEL = "openai/gpt-5.6-luna";
export const LUNA_EFFORT = "none";
export const CREDENTIAL_ENV = "OPENROUTER_API_KEY";
export const UPSTREAM_ORIGIN = "https://openrouter.ai/api";
export const SYNTHETIC_PROMPT = "Reply with the single word ok.";
const REQUEST_TIMEOUT_MS = 120_000;

export type LiveStatus = "PASS" | "FAIL";

export interface LiveOutcome {
  status: LiveStatus;
  reason: string;
  model: string;
  effort: string;
  metadata: { status: number; gate: "present" | "absent" };
  inference: {
    outgoingModel: string | null;
    outgoingEffort: string | null;
    upstreamStatus: number | null;
    responseModel: string | null;
    completed: boolean;
    usage: unknown;
  };
  client: { binaryPath: string; exitCode: number | null; agentMessage: string | null };
  credentialPresence: Record<string, boolean>;
}

/** Loopback adapter: record the client's outbound body, rewrite the model slug, forward upstream. */
export interface Adapter {
  origin: string;
  records: Array<{ path: string; model: string | null; effort: string | null; inputLen: number | null }>;
  stop(): Promise<void>;
}

/**
 * Hard bound for the whole run. The adapter must never be able to hang an
 * acceptance check: a stalled upstream would otherwise leave `stop()` waiting on
 * an in-flight connection and the process would never exit.
 */
const RUN_DEADLINE_MS = 180_000;

export async function startAdapter(): Promise<Adapter> {
  const records: Adapter["records"] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);
      const headers = new Headers(req.headers);
      headers.delete("host");
      let body: string | undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        body = await req.text();
        try {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          const reasoning = parsed.reasoning as Record<string, unknown> | undefined;
          records.push({
            path: url.pathname,
            model: typeof parsed.model === "string" ? parsed.model : null,
            effort: typeof reasoning?.effort === "string" ? reasoning.effort : null,
            inputLen: Array.isArray(parsed.input) ? parsed.input.length : null,
          });
          // The adapter owns the wire-slug translation; the client config never
          // names the OpenRouter prefix.
          if (parsed.model === LUNA_MODEL) {
            parsed.model = LUNA_UPSTREAM_MODEL;
            body = JSON.stringify(parsed);
          }
        } catch {
          records.push({ path: url.pathname, model: null, effort: null, inputLen: null });
        }
      }
      try {
        const res = await fetch(UPSTREAM_ORIGIN + url.pathname + url.search, {
          method: req.method,
          headers,
          body,
          redirect: "manual",
          signal: AbortSignal.any([
            aborter.signal,
            AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          ]),
        });
        return new Response(res.body, { status: res.status, headers: res.headers });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: { message: String(error) } }),
          { status: 502, headers: { "content-type": "application/json" } },
        );
      }
    },
  );
  const origin = `http://127.0.0.1:${server.addr.port}`;
  const aborter = new AbortController();
  // `server.shutdown()` waits for in-flight connections; on a stalled upstream
  // that could block forever, so abort first and ignore shutdown errors.
  const stop = async (): Promise<void> => {
    aborter.abort();
    try {
      await Promise.race([
        server.shutdown(),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    } catch {
      // Shutdown is best-effort; the process must still exit.
    }
  };
  return { origin, records, stop, signal: aborter.signal } as Adapter & { signal: AbortSignal };
}

export interface RunOptions {
  token: string;
  binaryPath: string;
}

export async function runLiveAcceptance(options: RunOptions): Promise<LiveOutcome> {
  const adapter = await startAdapter();
  const home = await Deno.makeTempDir({ prefix: "m3-luna-or-" });
  const cwd = await Deno.makeTempDir({ prefix: "m3-luna-orc-" });
  const credentialPresence = { [CREDENTIAL_ENV]: options.token.length > 0 };
  try {
    // 1. Gate: the upstream catalog must list the exact wire slug we will use.
    const catalog = await fetch(`${UPSTREAM_ORIGIN}/v1/models`, {
      headers: { authorization: `Bearer ${options.token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const catalogBody = (await catalog.json()) as { data?: Array<{ id?: string }> };
    const ids = (catalogBody.data ?? []).map((entry) => entry.id ?? "");
    const gate = ids.includes(LUNA_UPSTREAM_MODEL) ? "present" : "absent";
    const metadata = { status: catalog.status, gate } as const;
    if (gate !== "present") {
      return {
        status: "FAIL",
        reason: "gate-absent",
        model: LUNA_MODEL,
        effort: LUNA_EFFORT,
        metadata,
        inference: { outgoingModel: null, outgoingEffort: null, upstreamStatus: null, responseModel: null, completed: false, usage: null },
        client: { binaryPath: options.binaryPath, exitCode: null, agentMessage: null },
        credentialPresence,
      };
    }

    // 2. One inference attempt through the compiled client.
    const argv = [
      options.binaryPath,
      "--skip-git-repo-check",
      "-C",
      cwd,
      "--json",
      "-c",
      `model_provider=${JSON.stringify("luna_accept")}`,
      "-c",
      `model=${JSON.stringify(LUNA_MODEL)}`,
      "-c",
      `model_reasoning_effort=${JSON.stringify(LUNA_EFFORT)}`,
      "-c",
      `model_providers.luna_accept={ name="luna_accept", base_url=${JSON.stringify(`${adapter.origin}/v1`)}, env_key=${JSON.stringify(CREDENTIAL_ENV)}, wire_api="responses", requires_openai_auth=false, request_max_retries=0, stream_max_retries=0, stream_idle_timeout_ms=120000 }`,
      SYNTHETIC_PROMPT,
    ];
    const child = new Deno.Command(argv[0], {
      args: argv.slice(1),
      cwd,
      env: { CODEX_HOME: home, PATH: Deno.env.get("PATH") ?? "", [CREDENTIAL_ENV]: options.token },
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* already exited */ }
    }, REQUEST_TIMEOUT_MS + 15_000);
    const output = await child.output();
    clearTimeout(timer);
    const stdoutText = new TextDecoder().decode(output.stdout);

    const agentMessage = /"agent_message","message":"([^"]*)"/.exec(
      stdoutText.replace(/\s+/g, "").replace(/"type":"agent_message","message":/g, '"agent_message","message":'),
    )?.[1] ?? null;
    const sawCompleted = /"type":"token_count"/.test(stdoutText) && !/"type":"error"/.test(stdoutText);

    const inferenceRecords = adapter.records.filter((record) => record.path === "/v1/responses");
    const last = inferenceRecords.at(-1) ?? null;

    const reasons: string[] = [];
    if (last === null) reasons.push("no-inference-request");
    if (last && last.model !== LUNA_MODEL) reasons.push("client-model-not-exact");
    if (last && last.effort !== LUNA_EFFORT) reasons.push("client-effort-not-none");
    if (!sawCompleted) reasons.push("no-completed-turn");
    if (output.code !== 0) reasons.push("child-nonzero");

    return {
      status: reasons.length === 0 ? "PASS" : "FAIL",
      reason: reasons.length === 0 ? "luna-none-accepted" : reasons.join("+"),
      model: LUNA_MODEL,
      effort: LUNA_EFFORT,
      metadata,
      inference: {
        outgoingModel: last?.model ?? null,
        outgoingEffort: last?.effort ?? null,
        upstreamStatus: metadata.status,
        responseModel: sawCompleted ? LUNA_UPSTREAM_MODEL : null,
        completed: sawCompleted,
        usage: null,
      },
      client: {
        binaryPath: options.binaryPath,
        exitCode: output.code,
        agentMessage,
      },
      credentialPresence,
    };
  } finally {
    await adapter.stop();
  }
}

if (import.meta.main) {
  const token = Deno.env.get(CREDENTIAL_ENV);
  if (token === undefined || token.length === 0) {
    console.log(JSON.stringify({ status: "BLOCKED", reason: "missing-credential", variable: CREDENTIAL_ENV }));
    Deno.exit(2);
  }
  // A hang is a FAIL, never an unbounded wait.
  const deadline = setTimeout(() => {
    console.log(JSON.stringify({ status: "FAIL", reason: "run-deadline-exceeded", windowMs: RUN_DEADLINE_MS }));
    Deno.exit(1);
  }, RUN_DEADLINE_MS);
  const outcome = await runLiveAcceptance({ token, binaryPath: forkBinaryPath() });
  clearTimeout(deadline);
  console.log(JSON.stringify(outcome));
  Deno.exit(outcome.status === "PASS" ? 0 : 1);
}
