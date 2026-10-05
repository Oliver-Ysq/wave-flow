import { readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadWorkflow } from "../workflow/load-workflow";
import { RunRuntime } from "../runtime/run-runtime";
import { isJsonObject } from "../shared/json";
import type { CreateRunRequest, RunResponse } from "./types";
import { probeCapabilities } from "./capability-probe";
import { handleCompleteHttp } from "../control/control-http";
import { handleAnswerHttp, handleBlockHttp, handleContinueHttp } from "../control/block-http";
import type { ControlServer } from "../control/control-server";
import { createRealCodexExecutor } from "../runtime/real-codex-factory";
import { DeterministicExecutor } from "../runtime/deterministic-executor";
import type { AgentNodeExecutor } from "../runtime/run-types";
import { RealCodexExecutor } from "../runtime/real-codex-executor";
import { runsRoot } from "../journal/paths";
import { DAEMON_PROTOCOL_VERSION, daemonUserIdentity } from "./daemon-descriptor";
import { RunJournal } from "../journal/run-journal";
import { AgentStartLimiter, LimitedAgentExecutor } from "./agent-start-limiter";

/** 真实 Codex 执行器的 daemon 内部工厂；仅用于生产构造与无模型服务的端到端测试注入。 */
export type RealCodexExecutorFactory = (args: {
  /** 当前 daemon 的 loopback Control 根地址。 */
  readonly controlUrl: string;
  /** 当前项目 Run 耐久目录的根路径。 */
  readonly runsRoot: string;
  /** 当前 daemon 的唯一私有 tmux socket 身份。 */
  readonly daemonInstanceId: string;
  /** 本次 Run 是否使用 App Server hybrid 投递。 */
  readonly codexRpcInput: boolean;
}) => RealCodexExecutor;

/** LocalDaemon 的可选构造配置；生产默认使用真实 Codex 执行器。 */
export type LocalDaemonOptions = {
  /** 仅自动测试使用确定性执行器；不能用于用户 CLI。默认 false。 */
  readonly deterministicForTest?: boolean;
  /** 替换真实执行器的创建方式，以便验证 daemon/Control 闭环而不连接模型服务。 */
  readonly createRealExecutor?: RealCodexExecutorFactory;
  /** 用户级 Run Store 根目录；仅测试或受控嵌入环境注入，生产默认 ~/.wave-flow/runs。 */
  readonly storeRoot?: string;
  /** 全局同时运行 Run 上限；生产默认保守值，测试可缩小。 */
  readonly maxActiveRuns?: number;
  /** 全局同时启动的真实 Agent 上限，同时限制 tmux 会话与 App Server 进程。 */
  readonly maxActiveAgents?: number;
};

/** 只监听 loopback 的最小 daemon；CLI 必须经它创建和查询 Run。 */
export class LocalDaemon {
  #runs = new Map<string, RunRuntime>();
  #controls = new Map<string, ControlServer>();
  #runTasks = new Map<string, Promise<unknown>>();
  #createRequests = new Map<string, Promise<RunResponse>>();
  #server: ReturnType<typeof Bun.serve> | null = null;
  readonly instanceId = crypto.randomUUID();
  bootInstanceId: string | null = null;

  private readonly deterministicForTest: boolean;
  private readonly createRealExecutor: RealCodexExecutorFactory;
  private readonly storeRoot: string;
  private readonly maxActiveRuns: number;
  private readonly agentStartLimiter: AgentStartLimiter;

  /**
   * @param options 自动测试可选择稳定或 fake 真实执行器；省略时启动真正 tmux/Codex。
   * 为保持已有测试调用兼容，也接受历史 boolean 形式；用户 CLI 不会传入该参数。
   */
  constructor(options: LocalDaemonOptions | boolean = {}) {
    const normalized = typeof options === "boolean" ? { deterministicForTest: options } : options;
    this.deterministicForTest = normalized.deterministicForTest === true;
    this.createRealExecutor = normalized.createRealExecutor ?? createRealCodexExecutor;
    this.storeRoot = normalized.storeRoot ?? runsRoot();
    this.maxActiveRuns = normalized.maxActiveRuns ?? 20;
    if (!Number.isInteger(this.maxActiveRuns) || this.maxActiveRuns < 1) throw new Error("maxActiveRuns 必须是不小于 1 的整数。");
    this.agentStartLimiter = new AgentStartLimiter(normalized.maxActiveAgents ?? 20);
  }

  /** 启动 HTTP 服务；默认随机端口，严格绑定 127.0.0.1。 */
  start(port = 0): { readonly baseUrl: string; stop(): void } {
    if (this.#server) throw new Error("Local daemon 已启动。");
    this.#server = Bun.serve({ hostname: "127.0.0.1", port, fetch: (request) => this.fetch(request) });
    return { baseUrl: `http://127.0.0.1:${this.#server.port}`, stop: () => this.stop() };
  }

  /** 供常驻 daemon 发布 descriptor 前注入稳定启动身份。 */
  setBootInstanceId(value: string): void { if (!value.trim() || this.bootInstanceId) throw new Error("daemon 启动身份无效或已设置。"); this.bootInstanceId = value; }

  /** 停止短生命周期 daemon；不会删除 Journal 或本地结果文件。 */
  stop(): void { this.#server?.stop(true); this.#server = null; }

  /** 注册一个真实 Run 的 ControlServer；必须与当前 daemon 中的同一 Run 绑定。 */
  registerControl(runId: string, control: ControlServer): void {
    const runtime = this.#runs.get(runId);
    if (!runtime || runtime.journal.manifest.runId !== runId) throw new Error("只能为当前 daemon 已知的 Run 注册 ControlServer。");
    if (this.#controls.has(runId)) throw new Error("该 Run 的 ControlServer 已注册。");
    this.#controls.set(runId, control);
  }

  private async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return this.json({ protocolVersion: DAEMON_PROTOCOL_VERSION, userIdentity: daemonUserIdentity(), bootInstanceId: this.bootInstanceId ?? this.instanceId });
      if (request.method === "GET" && url.pathname === "/capabilities") return this.json(await probeCapabilities());
      if (request.method === "POST" && url.pathname === "/runs") return this.json(await this.createRun(await this.readJson(request)));
      if (request.method === "GET" && /^\/runs\/[^/]+$/.test(url.pathname)) {
        const runId = decodeURIComponent(url.pathname.slice("/runs/".length));
        return this.json(await this.inspect(runId));
      }
      const eventsMatch = url.pathname.match(/^\/runs\/([^/]+)\/events$/);
      if (request.method === "GET" && eventsMatch) return this.streamRunEvents(decodeURIComponent(eventsMatch[1]));
      const completeMatch = url.pathname.match(/^\/runs\/([^/]+)\/control\/complete$/);
      if (completeMatch) {
        const runId = decodeURIComponent(completeMatch[1]);
        const control = this.#controls.get(runId);
        if (!control) throw new DaemonRequestError(404, "该 Run 未注册 ControlServer。");
        return handleCompleteHttp(control, request);
      }
      const blockMatch = url.pathname.match(/^\/runs\/([^/]+)\/control\/block$/);
      if (blockMatch) {
        const control = this.#controls.get(decodeURIComponent(blockMatch[1]));
        if (!control) throw new DaemonRequestError(404, "该 Run 未注册 ControlServer。");
        return handleBlockHttp(control, request);
      }
      const answerMatch = url.pathname.match(/^\/blocks\/([^/]+)\/answer$/);
      if (answerMatch) {
        const blockRequestId = decodeURIComponent(answerMatch[1]);
        const control = [...this.#controls.values()].find((candidate) => candidate.hasBlock(blockRequestId));
        if (!control) throw new DaemonRequestError(404, "该 Run 未注册 ControlServer。");
        return handleAnswerHttp(control, blockRequestId, request);
      }
      const continueMatch = url.pathname.match(/^\/runs\/([^/]+)\/control\/continue$/);
      if (continueMatch) {
        const control = this.#controls.get(decodeURIComponent(continueMatch[1]));
        if (!control) throw new DaemonRequestError(404, "该 Run 未注册 ControlServer。");
        return handleContinueHttp(control, request);
      }
      throw new DaemonRequestError(404, "未知 daemon API 路径或方法。");
    } catch (error) {
      const status = error instanceof DaemonRequestError ? error.status : 400;
      const message = error instanceof Error ? error.message : String(error);
      return this.json({ error: message }, status);
    }
  }

  private async createRun(value: unknown): Promise<RunResponse> {
    if (!isCreateRunRequest(value)) throw new DaemonRequestError(400, "创建 Run 请求无效。");
    const inFlight = this.#createRequests.get(value.clientRequestId);
    if (inFlight) return inFlight;
    // 必须在任何 await 前登记：两个并发 POST 若都先完成磁盘查找，会各自创建一个 Run。
    const task = (async () => {
      // 第一条请求已经返回后，客户端仍可能因响应丢失而带着同一个
      // clientRequestId 重试。这时 Run 已在本 daemon 内存中运行，不能再从
      // Journal 以“无法恢复运行中 Run”为由拒绝它；直接返回同一份权威快照。
      const active = [...this.#runs.values()].find((runtime) => runtime.journal.manifest.clientRequestId === value.clientRequestId);
      if (active) return { runId: active.snapshot().id, snapshot: active.snapshot() };
      const durable = await this.findByClientRequestId(value.clientRequestId);
      if (!durable && [...this.#runs.values()].filter((runtime) => runtime.snapshot().status === "running").length >= this.maxActiveRuns) throw new DaemonRequestError(429, `全局运行中 Run 已达到上限：${this.maxActiveRuns}。`);
      return durable ?? this.createRunOnce(value);
    })().finally(() => this.#createRequests.delete(value.clientRequestId));
    this.#createRequests.set(value.clientRequestId, task);
    return task;
  }

  private async createRunOnce(value: CreateRunRequest): Promise<RunResponse> {
    const cwd = await realpath(value.cwd);
    const workflow = await loadWorkflow(value.workflowPath, cwd);
    const sourcePath = await realpath(resolve(cwd, value.workflowPath));
    const source = await Bun.file(sourcePath).text();
    const baseExecutor: AgentNodeExecutor = this.deterministicForTest
      ? new DeterministicExecutor()
      : this.createRealExecutor({ controlUrl: `http://127.0.0.1:${this.#server!.port}`, runsRoot: this.storeRoot, daemonInstanceId: this.instanceId, codexRpcInput: value.codexRpcInput !== false });
    const executor: AgentNodeExecutor = new LimitedAgentExecutor(baseExecutor, this.agentStartLimiter);
    const runtime = await RunRuntime.create({ workflow, input: value.input, workflowSource: source, clientRequestId: value.clientRequestId, workflowProjectCwd: cwd, workflowPath: sourcePath, storeRoot: this.storeRoot, executor });
    if (!this.deterministicForTest && baseExecutor instanceof RealCodexExecutor) {
      const control = runtime.createControlServer();
      baseExecutor.bindControl(control);
      this.#runs.set(runtime.snapshot().id, runtime);
      this.registerControl(runtime.snapshot().id, control);
    }
    const runId = runtime.snapshot().id;
    this.#runs.set(runId, runtime);
    const task = runtime.run(workflow).catch(() => undefined).finally(() => { this.#runTasks.delete(runId); });
    this.#runTasks.set(runId, task);
    await runtime.waitForSafeLaunch();
    return { runId: runtime.snapshot().id, snapshot: runtime.snapshot() };
  }

  private async findByClientRequestId(clientRequestId: string): Promise<RunResponse | null> {
    let names: string[];
    try { names = await readdir(this.storeRoot); } catch { return null; }
    for (const runId of names) {
      try {
        const opened = await RunJournal.open(runId, this.storeRoot);
        if (opened.journal.manifest.clientRequestId !== clientRequestId) continue;
        const runtime = await RunRuntime.open(runId, new DeterministicExecutor(), this.storeRoot);
        if (runtime.snapshot().status === "running") throw new DaemonRequestError(409, "相同创建请求的 Run 仍在运行，但当前 daemon 未持有其权威状态；请启动或恢复 daemon。");
        this.#runs.set(runId, runtime);
        return { runId, snapshot: runtime.snapshot() };
      } catch (error) {
        if (error instanceof DaemonRequestError) throw error;
      }
    }
    return null;
  }

  private async inspect(runId: string): Promise<RunResponse> {
    const memory = this.#runs.get(runId);
    if (memory) return { runId, snapshot: memory.snapshot() };
    const runtime = await RunRuntime.open(runId, new DeterministicExecutor(), this.storeRoot);
    if (runtime.snapshot().status === "running") throw new DaemonRequestError(409, "Run 仍在运行，但当前 daemon 未持有其权威状态；请启动或恢复 daemon。");
    this.#runs.set(runId, runtime);
    return { runId, snapshot: runtime.snapshot() };
  }

  /**
   * 将 daemon 权威快照以 SSE 推送给 CLI 与未来 Web。
   *
   * 当前 Runtime 尚未提供事件订阅钩子，因此此处以短周期比较快照并只在变化时输出；
   * 客户端不读取终端文本，也不会凭 SSE 内容改变 Run 状态。
   */
  private async streamRunEvents(runId: string): Promise<Response> {
    const initial = await this.inspect(runId);
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let previous = "";
        const publish = () => {
          const runtime = this.#runs.get(runId);
          if (!runtime) {
            if (timer) clearInterval(timer);
            controller.error(new Error("Run 不再由当前 daemon 管理。"));
            return;
          }
          const response: RunResponse = { runId, snapshot: runtime.snapshot() };
          const serialized = JSON.stringify(response);
          if (serialized === previous) return;
          previous = serialized;
          controller.enqueue(encoder.encode(`event: snapshot\ndata: ${serialized}\n\n`));
          if (response.snapshot.status !== "running") {
            if (timer) clearInterval(timer);
            controller.close();
          }
        };
        publish();
        if (initial.snapshot.status === "running") timer = setInterval(publish, 200);
      },
      cancel: () => { if (timer) clearInterval(timer); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
  }

  private async readJson(request: Request): Promise<unknown> {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new DaemonRequestError(415, "请求必须使用 application/json。");
    try { return await request.json(); } catch { throw new DaemonRequestError(400, "请求 JSON 无效。"); }
  }

  private json(value: unknown, status = 200): Response { return Response.json(value, { status }); }
}

/**
 * 在 daemon 不在线时只读取已结束 Run 的耐久证据。
 * 运行中的 Run 没有内存状态机就无法可信重建，调用方应提示用户连接或恢复 daemon，
 * 绝不能据 Journal 猜测它是否仍在执行。
 */
export async function inspectStoredRun(runId: string, storeRoot = runsRoot()): Promise<RunResponse> {
  const runtime = await RunRuntime.open(runId, new DeterministicExecutor(), storeRoot);
  if (runtime.snapshot().status === "running") throw new DaemonRequestError(409, "Run 仍在运行，但当前没有可验证的 daemon；请先启动或恢复 daemon。" );
  return { runId, snapshot: runtime.snapshot() };
}

class DaemonRequestError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function isCreateRunRequest(value: unknown): value is CreateRunRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return typeof request.clientRequestId === "string" && /^[0-9a-f-]{36}$/i.test(request.clientRequestId) && typeof request.workflowPath === "string" && typeof request.cwd === "string" && isJsonObject(request.input) && (request.codexRpcInput === undefined || typeof request.codexRpcInput === "boolean");
}
