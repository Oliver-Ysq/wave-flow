import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";

/** 由 Engine 以每个 Harness session 私有 token 启动的 MCP sidecar。 */
export async function runHarnessMcpServer(): Promise<void> {
  const control = new HarnessControlPipeClient(required("WF_HARNESS_MCP_REQUEST_FIFO"), required("WF_HARNESS_MCP_RESPONSE_FIFO"));
  const server = new Server({ name: "wave-flow-harness", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => await control.request("list", {}) as { tools: unknown[] });
  server.setRequestHandler(CallToolRequestSchema, async requestValue => {
    const result = await control.request("call", { name: requestValue.params.name, arguments: requestValue.params.arguments ?? {} });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
  await server.connect(new StdioServerTransport());
}

function required(key: string): string { const value = process.env[key]?.trim(); if (!value) throw new Error(`Harness MCP 服务缺少 ${key}。`); return value; }

/** Harness MCP 仅向 Engine 的随机 FIFO 请求已授权工具；没有 HTTP fallback。 */
class HarnessControlPipeClient {
  #next = 1;
  #pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #writer: ReturnType<typeof createWriteStream>;
  constructor(requestFifo: string, responseFifo: string) {
    this.#writer = createWriteStream(requestFifo, { flags: "r+" });
    const reader = createInterface({ input: createReadStream(responseFifo, { flags: "r+", encoding: "utf8" }), crlfDelay: Infinity }); void this.read(reader);
  }
  async request(operation: "list" | "call", value: Record<string, unknown>): Promise<unknown> {
    const requestId = `harness-${process.pid}-${this.#next++}`;
    const response = new Promise<unknown>((resolve, reject) => this.#pending.set(requestId, { resolve, reject }));
    await new Promise<void>((resolve, reject) => this.#writer.write(`${JSON.stringify({ requestId, operation, value })}\n`, error => error ? reject(error) : resolve()));
    return response;
  }
  private async read(reader: ReturnType<typeof createInterface>): Promise<void> {
    try { for await (const line of reader) { let value: unknown; try { value = JSON.parse(line); } catch { continue; } if (!value || typeof value !== "object" || Array.isArray(value)) continue; const response = value as { requestId?: unknown; ok?: unknown; result?: unknown; error?: unknown }; if (typeof response.requestId !== "string") continue; const pending = this.#pending.get(response.requestId); if (!pending) continue; this.#pending.delete(response.requestId); response.ok === true ? pending.resolve(response.result) : pending.reject(new Error(typeof response.error === "string" ? response.error : "Harness 私有控制请求失败。")); } }
    finally { const error = new Error("Harness 私有控制通道已关闭。"); for (const pending of this.#pending.values()) pending.reject(error); this.#pending.clear(); }
  }
}
