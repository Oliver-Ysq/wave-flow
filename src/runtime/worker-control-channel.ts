import { tmpdir } from "node:os";
import { startControlSocket, type ControlSocketServer } from "./control-socket";
import type { ControlServer, CompletionSubmission } from "../control/control-server";
import type { BlockSubmission, ContinueSubmission } from "../control/block-broker";
import type { JsonObject } from "../shared/json";

/** 一个 Coding Worker 已绑定的私有 Control 身份；socket 路径不是授权凭据。 */
export type WorkerControlIdentity = Pick<CompletionSubmission, "runId" | "nodeId" | "agentSessionId" | "capability">;

/** Worker MCP 发给本次 Engine 的私有 JSONL 请求。 */
type ControlRequest =
  | { readonly requestId: string; readonly action: "complete"; readonly summary: string; readonly result: JsonObject }
  | { readonly requestId: string; readonly action: "block"; readonly blockRequestId: string; readonly needHelp: string; readonly answerSchema?: JsonObject }
  | { readonly requestId: string; readonly action: "continue"; readonly blockRequestId: string };
type ControlResponse = { readonly requestId: string; readonly ok: true; readonly result: unknown } | { readonly requestId: string; readonly ok: false; readonly error: string };

/** 注入 MCP 子进程的私有控制端点；目录仅在当前 Engine 生命周期内存在。 */
export type WorkerControlChannelEndpoints = {
  /** Worker MCP 连接的 Unix domain socket 绝对路径。 */
  readonly socketPath: string;
};

/**
 * 单个 Coding Worker 的私有 Control 通道。
 *
 * Codex ACP 只能向 MCP 进程传递 command/args/env，无法可靠继承 Engine 文件描述符，
 * 因此这里用随机、0700 目录下的 Unix domain socket 传输 JSONL；不监听网络端口、
 * 不发布 descriptor、没有可发现注册。每个请求仍由已绑定的 ControlServer 校验 capability。
 *
 * 不用 FIFO：FIFO 的阻塞读会长期占用线程池线程，会话关闭也无法释放，累积后会让
 * 所有异步文件写入饿死（节点永久 running 且无日志）。socket 读写由事件循环驱动。
 */
export class WorkerControlChannel {
  readonly endpoints: WorkerControlChannelEndpoints;
  #channel: ControlSocketServer;
  #closed = false;

  constructor(
    private readonly control: ControlServer,
    private readonly identity: WorkerControlIdentity,
    private readonly onCompleted?: () => void,
    /** 受管writer专用scratch；生产Engine验证后传入，省略沿用系统临时目录。 */
    privateRoot = tmpdir(),
  ) {
    this.#channel = startControlSocket({
      root: privateRoot,
      prefix: "wave-flow-worker-control-",
      onLine: async (line, reply, finish) => {
        const response = await this.dispatch(line);
        reply(JSON.stringify(response));
        if (response.ok && isComplete(line)) {
          // 让 MCP 先收到成功确认（FIN 在响应之后），再停止本次连接；通道由
          // 执行器的 finally 统一关闭，避免丢弃尚未刷出的 ack。
          this.onCompleted?.();
          finish();
        }
      },
    });
    this.endpoints = { socketPath: this.#channel.socketPath };
  }

  /** 关闭通道并移除随机目录；Engine 退出、节点完成或启动失败时调用。 */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#channel.close();
  }

  private async dispatch(line: string): Promise<ControlResponse> {
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
}

function isComplete(line: string): boolean { try { return parseRequest(line).action === "complete"; } catch { return false; } }

function requestIdFromLine(line: string): string {
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    const id = (value as { requestId?: unknown }).requestId;
    return typeof id === "string" && id.trim() ? id : "";
  } catch { return ""; }
}

function parseRequest(line: string): ControlRequest {
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
