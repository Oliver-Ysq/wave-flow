import { tmpdir } from "node:os";
import { startControlSocket, type ControlSocketServer } from "../runtime/control-socket";

/** 注入 Lead MCP 子进程的私有控制端点。 */
export type LeadControlChannelEndpoints = { readonly socketPath: string };
type Request = { readonly requestId: string; readonly operation: "list" | "call"; readonly value: Record<string, unknown> };
type Response = { readonly requestId: string; readonly ok: true; readonly result: unknown } | { readonly requestId: string; readonly ok: false; readonly error: string };

/**
 * Lead/main controller 的私有 MCP 通道。
 *
 * 随机 0700 目录内的 Unix domain socket 不发布、不持久化；Lead MCP 没有
 * Control、Journal、shell 或工作区写入权限，所有可用工具仍由 LeadService.mcpTools 复核。
 *
 * 不用 FIFO：FIFO 阻塞读会长期占用线程池线程且关闭后无法释放，累积到池大小后
 * 所有异步文件写入饿死。socket 读写由事件循环驱动。
 */
export class LeadControlChannel {
  readonly endpoints: LeadControlChannelEndpoints;
  #channel: ControlSocketServer;
  #closed = false;

  constructor(private readonly invoke: (request: { readonly operation: "list" | "call"; readonly value: Record<string, unknown> }) => Promise<unknown>,
    /** Engine的私有主控scratch；默认系统tmp仅供独立通道测试，不授权整个父目录。 */
    root = tmpdir(),
  ) {
    this.#channel = startControlSocket({
      root,
      prefix: "wave-flow-lead-control-",
      onLine: async (line, reply) => {
        reply(JSON.stringify(await this.dispatch(line)));
      },
    });
    this.endpoints = { socketPath: this.#channel.socketPath };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#channel.close();
  }

  private async dispatch(line: string): Promise<Response> {
    let requestId = "";
    try { const request = parse(line); requestId = request.requestId; return { requestId, ok: true, result: await this.invoke(request) }; }
    catch (error) { return { requestId, ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}
function parse(line: string): Request {
  let value: unknown; try { value = JSON.parse(line); } catch { throw new Error("Lead 私有控制请求不是合法 JSON。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Lead 私有控制请求必须是对象。");
  const request = value as Record<string, unknown>;
  if (typeof request.requestId !== "string" || !request.requestId.trim()) throw new Error("Lead 私有控制请求缺少 requestId。");
  if ((request.operation !== "list" && request.operation !== "call") || !request.value || typeof request.value !== "object" || Array.isArray(request.value)) throw new Error("Lead 私有控制请求无效。");
  return { requestId: request.requestId, operation: request.operation, value: request.value as Record<string, unknown> };
}
