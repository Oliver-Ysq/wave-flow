import { createReadStream, createWriteStream } from "node:fs";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** 注入 Harness MCP 子进程的随机私有 FIFO 对。 */
export type HarnessControlPipeEndpoints = { readonly requestFifo: string; readonly responseFifo: string };
type Request = { readonly requestId: string; readonly operation: "list" | "call"; readonly value: Record<string, unknown> };
type Response = { readonly requestId: string; readonly ok: true; readonly result: unknown } | { readonly requestId: string; readonly ok: false; readonly error: string };

/**
 * Harness/main controller 的私有 MCP 通道。
 *
 * 随机 FIFO 目录不发布、不持久化；Harness MCP 没有 Control、Journal、shell 或
 * 工作区写入权限，所有可用工具仍由 HarnessService.mcpTools 复核。
 */
export class HarnessControlPipe {
  readonly endpoints: HarnessControlPipeEndpoints;
  #closed = false;
  #request: ReturnType<typeof createReadStream>;
  #response: ReturnType<typeof createWriteStream>;

  constructor(private readonly invoke: (request: { readonly operation: "list" | "call"; readonly value: Record<string, unknown> }) => Promise<unknown>,
    /** Engine的私有主控scratch；默认系统tmp仅供独立管道测试，不授权整个父目录。 */
    root = tmpdir(),
  ) {
    const directory = mkdtempSync(join(root, "wave-flow-harness-control-"));
    chmodSync(directory, 0o700);
    const requestFifo = join(directory, "request"); const responseFifo = join(directory, "response");
    const made = Bun.spawnSync(["/usr/bin/mkfifo", "-m", "600", requestFifo, responseFifo]);
    if (made.exitCode !== 0) { rmSync(directory, { recursive: true, force: true }); throw new Error("无法创建 Harness 私有控制管道。 "); }
    this.endpoints = { requestFifo, responseFifo };
    this.#request = createReadStream(requestFifo, { flags: "r+", encoding: "utf8" });
    this.#response = createWriteStream(responseFifo, { flags: "r+" });
    void this.consume();
  }
  close(): void {
    if (this.#closed) return; this.#closed = true;
    this.#request.destroy(); this.#response.destroy();
    rmSync(join(this.endpoints.requestFifo, ".."), { recursive: true, force: true });
  }
  private async consume(): Promise<void> {
    const reader = createInterface({ input: this.#request, crlfDelay: Infinity });
    try { for await (const line of reader) { if (!line.trim() || this.#closed) continue; await this.write(await this.dispatch(line)); } }
    catch { /* Engine 或 MCP 关闭时不把管道 EOF 误记为业务失败。 */ }
    finally { reader.close(); }
  }
  private async dispatch(line: string): Promise<Response> {
    let requestId = "";
    try { const request = parse(line); requestId = request.requestId; return { requestId, ok: true, result: await this.invoke(request) }; }
    catch (error) { return { requestId, ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }
  private async write(value: Response): Promise<void> { await new Promise<void>((resolve, reject) => this.#response.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve())); }
}
function parse(line: string): Request {
  let value: unknown; try { value = JSON.parse(line); } catch { throw new Error("Harness 私有控制请求不是合法 JSON。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Harness 私有控制请求必须是对象。");
  const request = value as Record<string, unknown>;
  if (typeof request.requestId !== "string" || !request.requestId.trim()) throw new Error("Harness 私有控制请求缺少 requestId。");
  if ((request.operation !== "list" && request.operation !== "call") || !request.value || typeof request.value !== "object" || Array.isArray(request.value)) throw new Error("Harness 私有控制请求无效。");
  return { requestId: request.requestId, operation: request.operation, value: request.value as Record<string, unknown> };
}
