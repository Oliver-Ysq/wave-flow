import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import type { JsonObject } from "../shared/json";

/**
 * 为单个受管 Coding Worker 提供的完成协议 MCP sidecar。
 *
 * 环境变量只在该 ACP session 的 MCP 子进程可见：仅有一对随机私有 FIFO 路径。
 * 身份与 capability 由 Engine 在 FIFO 服务端绑定，Control 仍复核节点状态与
 * Schema；sidecar 不读写 Journal、Runtime、业务工作区或任意 shell。
 */
export async function runWorkerMcpServer(): Promise<void> {
  const control = new WorkerControlPipeClient(required("WF_WORKER_MCP_REQUEST_FIFO"), required("WF_WORKER_MCP_RESPONSE_FIFO"));
  const server = new Server({ name: "wave-flow-worker-control", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: "wave_flow_complete", description: "完成当前受管节点。传入最终 JSON 对象与简短摘要；Control 会校验节点 Schema 并耐久写入结果。成功后才可以结束 ACP turn。", inputSchema: { type: "object", required: ["summary", "result"], properties: { summary: { type: "string" }, result: { type: "object" } }, additionalProperties: false } },
    { name: "wave_flow_block", description: "仅在没有人类决定无法安全继续时阻塞当前节点。调用会等待用户在 Wave Flow 界面提交 JSON 答案。", inputSchema: { type: "object", required: ["needHelp"], properties: { needHelp: { type: "string" }, answerSchema: { type: "object" } }, additionalProperties: false } },
    { name: "wave_flow_continue", description: "在 wave_flow_block 已返回答案且你确认可继续后恢复当前节点。", inputSchema: { type: "object", required: ["blockRequestId"], properties: { blockRequestId: { type: "string" } }, additionalProperties: false } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const args = params.arguments ?? {};
    if (params.name === "wave_flow_complete") {
      if (typeof args.summary !== "string" || !isObject(args.result)) throw new Error("wave_flow_complete 需要 summary 字符串和 result JSON 对象。 ");
      await control.request({ action: "complete", summary: args.summary, result: args.result });
      return text({ ok: true });
    }
    if (params.name === "wave_flow_block") {
      if (typeof args.needHelp !== "string" || !args.needHelp.trim() || (args.answerSchema !== undefined && !isObject(args.answerSchema))) throw new Error("wave_flow_block 参数无效。 ");
      const blockRequestId = crypto.randomUUID();
      const result = await control.request({ action: "block", blockRequestId, needHelp: args.needHelp, ...(args.answerSchema ? { answerSchema: args.answerSchema } : {}) });
      return text(result);
    }
    if (params.name === "wave_flow_continue") {
      if (typeof args.blockRequestId !== "string" || !args.blockRequestId.trim()) throw new Error("wave_flow_continue 需要 blockRequestId。 ");
      await control.request({ action: "continue", blockRequestId: args.blockRequestId });
      return text({ ok: true });
    }
    throw new Error(`未知 Worker Control 工具：${params.name}`);
  });
  await server.connect(new StdioServerTransport());
}

function required(key: string): string { const value = process.env[key]?.trim(); if (!value) throw new Error(`Worker MCP 服务缺少 ${key}。`); return value; }
function isObject(value: unknown): value is JsonObject { return !!value && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }; }

/** MCP 进程只经随机 FIFO 对接触当前 Engine；不发 HTTP，也不持有身份/capability。 */
class WorkerControlPipeClient {
  #next = 1;
  #pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #writer: ReturnType<typeof createWriteStream>;

  constructor(requestFifo: string, responseFifo: string) {
    this.#writer = createWriteStream(requestFifo, { flags: "r+" });
    const reader = createInterface({ input: createReadStream(responseFifo, { flags: "r+", encoding: "utf8" }), crlfDelay: Infinity });
    void this.read(reader);
  }

  async request(value: Record<string, unknown>): Promise<unknown> {
    const requestId = `worker-${process.pid}-${this.#next++}`;
    const response = new Promise<unknown>((resolve, reject) => this.#pending.set(requestId, { resolve, reject }));
    await new Promise<void>((resolve, reject) => this.#writer.write(`${JSON.stringify({ requestId, ...value })}\n`, error => error ? reject(error) : resolve()));
    return response;
  }

  private async read(reader: ReturnType<typeof createInterface>): Promise<void> {
    try {
      for await (const line of reader) {
        let value: unknown;
        try { value = JSON.parse(line); } catch { continue; }
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const response = value as { requestId?: unknown; ok?: unknown; result?: unknown; error?: unknown };
        if (typeof response.requestId !== "string") continue;
        const pending = this.#pending.get(response.requestId); if (!pending) continue;
        this.#pending.delete(response.requestId);
        if (response.ok === true) pending.resolve(response.result);
        else pending.reject(new Error(typeof response.error === "string" ? response.error : "Worker 私有控制请求失败。"));
      }
    } finally {
      const error = new Error("Worker 私有控制通道已关闭。");
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    }
  }
}
