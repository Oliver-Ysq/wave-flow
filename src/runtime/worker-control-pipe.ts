import { createReadStream, createWriteStream } from "node:fs";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ControlServer, CompletionSubmission } from "../control/control-server";
import type { BlockSubmission, ContinueSubmission } from "../control/block-broker";
import type { JsonObject } from "../shared/json";

/** 一个 Coding Worker 已绑定的私有 Control 身份；FIFO 路径不是授权凭据。 */
export type WorkerControlIdentity = Pick<CompletionSubmission, "runId" | "nodeId" | "agentSessionId" | "capability">;

/** Worker MCP 发给本次 Engine 的私有 JSONL 请求。 */
type PipeRequest =
  | { readonly requestId: string; readonly action: "complete"; readonly summary: string; readonly result: JsonObject }
  | { readonly requestId: string; readonly action: "block"; readonly blockRequestId: string; readonly needHelp: string; readonly answerSchema?: JsonObject }
  | { readonly requestId: string; readonly action: "continue"; readonly blockRequestId: string };
type PipeResponse = { readonly requestId: string; readonly ok: true; readonly result: unknown } | { readonly requestId: string; readonly ok: false; readonly error: string };

/** 注入 MCP 子进程的私有 FIFO 端点；目录仅在当前 Engine 生命周期内存在。 */
export type WorkerControlPipeEndpoints = {
  /** Worker MCP 写请求的 FIFO 绝对路径。 */
  readonly requestFifo: string;
  /** Worker MCP 读响应的 FIFO 绝对路径。 */
  readonly responseFifo: string;
};

/**
 * 单个 Coding Worker 的私有 Control 通道。
 *
 * Codex ACP 只能向 MCP 进程传递 command/args/env，无法可靠继承 Engine 文件描述符。
 * 因此这里用随机、0700 目录下的一对 FIFO 传输 JSONL；没有 listener、端口、
 * descriptor 或可发现注册。每个请求仍由已绑定的 ControlServer 校验 capability。
 */
export class WorkerControlPipe {
  readonly endpoints: WorkerControlPipeEndpoints;
  #closed = false;
  #requestStream: ReturnType<typeof createReadStream>;
  #responseStream: ReturnType<typeof createWriteStream>;

  constructor(
    private readonly control: ControlServer,
    private readonly identity: WorkerControlIdentity,
    private readonly onCompleted?: () => void,
    /** 受管writer专用scratch；生产Engine验证后传入，省略沿用系统临时目录。 */
    privateRoot = tmpdir(),
  ) {
    const directory = mkdtempSync(join(privateRoot, "wave-flow-worker-control-"));
    chmodSync(directory, 0o700);
    const requestFifo = join(directory, "request");
    const responseFifo = join(directory, "response");
    const made = Bun.spawnSync(["/usr/bin/mkfifo", "-m", "600", requestFifo, responseFifo]);
    if (made.exitCode !== 0) {
      rmSync(directory, { recursive: true, force: true });
      throw new Error(`无法创建 Worker 私有控制管道：${new TextDecoder().decode(made.stderr).trim() || `mkfifo exit ${made.exitCode}`}`);
    }
    this.endpoints = { requestFifo, responseFifo };
    // r+ 保持两端打开，避免 FIFO 在 MCP 进程启动早晚不同的情况下卡在 open。
    this.#requestStream = createReadStream(requestFifo, { flags: "r+", encoding: "utf8" });
    this.#responseStream = createWriteStream(responseFifo, { flags: "r+", encoding: "utf8" });
    void this.consume();
  }

  /** 关闭流并移除随机目录；Engine 退出、节点完成或启动失败时调用。 */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#requestStream.destroy();
    this.#responseStream.destroy();
    rmSync(join(this.endpoints.requestFifo, ".."), { recursive: true, force: true });
  }

  private async consume(): Promise<void> {
    const reader = createInterface({ input: this.#requestStream, crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        if (this.#closed || !line.trim()) continue;
        // 并发处理请求：block 是有界等待并重连的，串行 dispatch 会让重连请求排在
        // 首个未答 block 之后，永远无法及时处理。Control 自身按动作做并发仲裁，
        // 业务顺序由模型串行调用与状态机校验保证，不依赖本通道的到达顺序。
        void this.serve(line);
      }
    } catch {
      // Worker/Engine 任一端关闭都不应把读取器错误写成业务状态；Runtime 负责
      // 把没有 complete 的会话收敛为 cancelled 或 interrupted。
    } finally { reader.close(); }
  }

  private async serve(line: string): Promise<void> {
    try {
      const response = await this.dispatch(line);
      await this.write(response);
      if (response.ok && this.isComplete(line)) {
        // 让 MCP 先收到成功确认，再回收不会再被使用的端点。
        queueMicrotask(() => { this.onCompleted?.(); this.close(); });
      }
    } catch {
      // 并发处理中通道关闭或写入失败只影响该请求；等待中的调用由 Control 的
      // cancelForSession 或 MCP 侧有界等待收尾。
    }
  }

  private async dispatch(line: string): Promise<PipeResponse> {
    // 请求参数即使非法，只要带有合法 requestId 就必须回传它；否则 MCP 客户端
    // 无法把错误帧关联到等待中的工具调用，会把确定性协议错误误报为超时。
    let requestId = requestIdFromLine(line);
    try {
      const request = parseRequest(line); requestId = request.requestId;
      if (request.action === "complete") {
        await this.control.complete({ ...this.identity, summary: request.summary, result: request.result });
        return { requestId, ok: true, result: { ok: true } };
      }
      if (request.action === "block") {
        const resolution = await this.control.block({ ...this.identity, blockRequestId: request.blockRequestId, needHelp: request.needHelp, ...(request.answerSchema ? { answerSchema: request.answerSchema } : {}) } as BlockSubmission);
        return { requestId, ok: true, result: resolution };
      }
      await this.control.continue({ ...this.identity, blockRequestId: request.blockRequestId } as ContinueSubmission);
      return { requestId, ok: true, result: { ok: true } };
    } catch (error) { return { requestId, ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }

  private async write(response: PipeResponse): Promise<void> {
    await new Promise<void>((resolve, reject) => this.#responseStream.write(`${JSON.stringify(response)}\n`, error => error ? reject(error) : resolve()));
  }
  private isComplete(line: string): boolean { try { return parseRequest(line).action === "complete"; } catch { return false; } }
}

function requestIdFromLine(line: string): string {
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    const id = (value as { requestId?: unknown }).requestId;
    return typeof id === "string" && id.trim() ? id : "";
  } catch { return ""; }
}

function parseRequest(line: string): PipeRequest {
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new Error("Worker 私有控制请求不是合法 JSON。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Worker 私有控制请求必须是对象。");
  const request = value as Record<string, unknown>;
  if (typeof request.requestId !== "string" || !request.requestId.trim()) throw new Error("Worker 私有控制请求缺少 requestId。");
  if (request.action === "complete" && typeof request.summary === "string" && isObject(request.result)) return { requestId: request.requestId, action: "complete", summary: request.summary, result: request.result };
  if (request.action === "block" && typeof request.blockRequestId === "string" && typeof request.needHelp === "string" && (request.answerSchema === undefined || isObject(request.answerSchema))) return { requestId: request.requestId, action: "block", blockRequestId: request.blockRequestId, needHelp: request.needHelp, ...(isObject(request.answerSchema) ? { answerSchema: request.answerSchema } : {}) };
  if (request.action === "continue" && typeof request.blockRequestId === "string") return { requestId: request.requestId, action: "continue", blockRequestId: request.blockRequestId };
  throw new Error("Worker 私有控制请求无效。");
}
function isObject(value: unknown): value is JsonObject { return !!value && typeof value === "object" && !Array.isArray(value); }
