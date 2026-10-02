import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { loadWorkflow } from "../workflow/load-workflow";
import { DeterministicExecutor } from "../runtime/deterministic-executor";
import { RunRuntime } from "../runtime/run-runtime";
import { isJsonObject } from "../shared/json";
import type { CreateRunRequest, RunResponse } from "./types";

/** 只监听 loopback 的最小 daemon；CLI 必须经它创建和查询 Run。 */
export class LocalDaemon {
  #runs = new Map<string, RunRuntime>();
  #server: ReturnType<typeof Bun.serve> | null = null;

  /** 启动 HTTP 服务；默认随机端口，严格绑定 127.0.0.1。 */
  start(port = 0): { readonly baseUrl: string; stop(): void } {
    if (this.#server) throw new Error("Local daemon 已启动。");
    this.#server = Bun.serve({ hostname: "127.0.0.1", port, fetch: (request) => this.fetch(request) });
    return { baseUrl: `http://127.0.0.1:${this.#server.port}`, stop: () => this.stop() };
  }

  /** 停止短生命周期 daemon；不会删除 Journal 或本地结果文件。 */
  stop(): void { this.#server?.stop(true); this.#server = null; }

  private async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/runs") return this.json(await this.createRun(await this.readJson(request)));
      if (request.method === "GET" && /^\/runs\/[^/]+$/.test(url.pathname)) {
        const runId = decodeURIComponent(url.pathname.slice("/runs/".length));
        const cwd = url.searchParams.get("cwd");
        if (!cwd) throw new DaemonRequestError(400, "inspect 请求缺少 cwd。");
        return this.json(await this.inspect(runId, cwd));
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
    const runtime = await RunRuntime.create({ workflow, input: value.input, workflowSource: source, cwd, executor: new DeterministicExecutor() });
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
  return typeof request.workflowPath === "string" && typeof request.cwd === "string" && isJsonObject(request.input);
}
