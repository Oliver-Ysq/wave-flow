import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadWorkflow } from "../workflow/load-workflow";
import { RunRuntime } from "../runtime/run-runtime";
import { isJsonObject } from "../shared/json";
import type { CreateRunRequest, RunResponse } from "./types";
import { probeCapabilities } from "./capability-probe";
import { handleCompleteHttp } from "../control/control-http";
import type { ControlServer } from "../control/control-server";
import { createRealCodexExecutor } from "../runtime/real-codex-factory";
import { DeterministicExecutor } from "../runtime/deterministic-executor";
import type { AgentNodeExecutor } from "../runtime/run-types";
import { RealCodexExecutor } from "../runtime/real-codex-executor";
import { runsRoot } from "../journal/paths";

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
};

/** 只监听 loopback 的最小 daemon；CLI 必须经它创建和查询 Run。 */
export class LocalDaemon {
  #runs = new Map<string, RunRuntime>();
  #controls = new Map<string, ControlServer>();
  #server: ReturnType<typeof Bun.serve> | null = null;
  readonly instanceId = crypto.randomUUID();

  private readonly deterministicForTest: boolean;
  private readonly createRealExecutor: RealCodexExecutorFactory;

  /**
   * @param options 自动测试可选择稳定或 fake 真实执行器；省略时启动真正 tmux/Codex。
   * 为保持已有测试调用兼容，也接受历史 boolean 形式；用户 CLI 不会传入该参数。
   */
  constructor(options: LocalDaemonOptions | boolean = {}) {
    const normalized = typeof options === "boolean" ? { deterministicForTest: options } : options;
    this.deterministicForTest = normalized.deterministicForTest === true;
    this.createRealExecutor = normalized.createRealExecutor ?? createRealCodexExecutor;
  }

  /** 启动 HTTP 服务；默认随机端口，严格绑定 127.0.0.1。 */
  start(port = 0): { readonly baseUrl: string; stop(): void } {
    if (this.#server) throw new Error("Local daemon 已启动。");
    this.#server = Bun.serve({ hostname: "127.0.0.1", port, fetch: (request) => this.fetch(request) });
    return { baseUrl: `http://127.0.0.1:${this.#server.port}`, stop: () => this.stop() };
  }

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
      if (request.method === "GET" && url.pathname === "/capabilities") return this.json(await probeCapabilities());
      if (request.method === "POST" && url.pathname === "/runs") return this.json(await this.createRun(await this.readJson(request)));
      if (request.method === "GET" && /^\/runs\/[^/]+$/.test(url.pathname)) {
        const runId = decodeURIComponent(url.pathname.slice("/runs/".length));
        const cwd = url.searchParams.get("cwd");
        if (!cwd) throw new DaemonRequestError(400, "inspect 请求缺少 cwd。");
        return this.json(await this.inspect(runId, cwd));
      }
      const completeMatch = url.pathname.match(/^\/runs\/([^/]+)\/control\/complete$/);
      if (completeMatch) {
        const runId = decodeURIComponent(completeMatch[1]);
        const control = this.#controls.get(runId);
        if (!control) throw new DaemonRequestError(404, "该 Run 未注册 ControlServer。");
        return handleCompleteHttp(control, request);
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
    const cwd = await realpath(value.cwd);
    const workflow = await loadWorkflow(value.workflowPath, cwd);
    const sourcePath = await realpath(resolve(cwd, value.workflowPath));
    const source = await Bun.file(sourcePath).text();
    const executor: AgentNodeExecutor = this.deterministicForTest
      ? new DeterministicExecutor()
      : this.createRealExecutor({ controlUrl: `http://127.0.0.1:${this.#server!.port}`, runsRoot: runsRoot(cwd), daemonInstanceId: this.instanceId, codexRpcInput: value.codexRpcInput !== false });
    const runtime = await RunRuntime.create({ workflow, input: value.input, workflowSource: source, cwd, executor });
    if (!this.deterministicForTest && executor instanceof RealCodexExecutor) {
      const control = runtime.createControlServer();
      executor.bindControl(control);
      this.#runs.set(runtime.snapshot().id, runtime);
      this.registerControl(runtime.snapshot().id, control);
    }
    try {
      await runtime.run(workflow);
    } catch (error) {
      // 只有 Runtime 已耐久封存为 interrupted 时才可返回 RunId；否则不能把未终结 Run 伪装为成功响应。
      if (runtime.snapshot().status !== "interrupted") throw error;
    }
    this.#runs.set(runtime.snapshot().id, runtime);
    return { runId: runtime.snapshot().id, snapshot: runtime.snapshot() };
  }

  private async inspect(runId: string, cwd: string): Promise<RunResponse> {
    const canonicalCwd = await realpath(cwd);
    const memory = this.#runs.get(runId);
    if (memory) {
      if (memory.journal.manifest.cwd !== canonicalCwd) throw new DaemonRequestError(400, "Run 不属于请求的项目 cwd。");
      return { runId, snapshot: memory.snapshot() };
    }
    const runtime = await RunRuntime.open(runId, canonicalCwd, new DeterministicExecutor());
    this.#runs.set(runId, runtime);
    return { runId, snapshot: runtime.snapshot() };
  }

  private async readJson(request: Request): Promise<unknown> {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new DaemonRequestError(415, "请求必须使用 application/json。");
    try { return await request.json(); } catch { throw new DaemonRequestError(400, "请求 JSON 无效。"); }
  }

  private json(value: unknown, status = 200): Response { return Response.json(value, { status }); }
}

class DaemonRequestError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function isCreateRunRequest(value: unknown): value is CreateRunRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return typeof request.workflowPath === "string" && typeof request.cwd === "string" && isJsonObject(request.input) && (request.codexRpcInput === undefined || typeof request.codexRpcInput === "boolean");
}
