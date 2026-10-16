import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { JsonObject } from "../shared/json";

/**
 * 单次 wave_flow_block 调用的最长等待时间。
 *
 * Codex code-mode（exec JS REPL）在脚本运行约 31 秒后不返回工具结果，而是把脚本
 * 转为后台 cell，是否取回结果完全取决于模型行为——已实证 81 秒答案投递后模型
 * 空转到回合中止。因此 block 必须在远低于该阈值的窗口内返回；未答时返回
 * waiting，由模型携带同一 blockRequestId 重连继续等待。
 */
export const WORKER_BLOCK_WAIT_BUDGET_MS = 25_000;

/**
 * 为单个受管 Coding Worker 提供的完成协议 MCP sidecar。
 *
 * 环境变量只在该 ACP session 的 MCP 子进程可见：仅有一对随机私有 FIFO 路径。
 * 身份与 capability 由 Engine 在 FIFO 服务端绑定，Control 仍复核节点状态与
 * Schema；sidecar 不读写 Journal、Runtime、业务工作区或任意 shell。
 */
export async function runWorkerMcpServer(waitBudgetMs: number = WORKER_BLOCK_WAIT_BUDGET_MS): Promise<void> {
  const requestFifo = required("WF_WORKER_MCP_REQUEST_FIFO");
  const responseFifo = required("WF_WORKER_MCP_RESPONSE_FIFO");
  const control = new WorkerControlPipeClient(requestFifo, responseFifo);
  const server = new Server({ name: "wave-flow-worker-control", version: "1" }, { capabilities: { tools: {} } });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(lifetime);
    control.close();
    await server.close();
    // r+ FIFO不会因Engine关闭产生EOF；显式结束独占sidecar，不能让旧block计时器续命。
    process.stdout.write("", () => process.exit(0));
  };
  // 完成响应先经stdio flush，再退出；否则Engine完成清理可能抢先丢失MCP成功确认。
  const completeResponses = new Set<string | number>();
  const transport = new StdioServerTransport();
  const send = transport.send.bind(transport);
  transport.send = async (message) => {
    await send(message);
    if ("id" in message && message.id !== undefined && completeResponses.delete(message.id)) void close();
  };
  // 仅观察Engine颁发的本session端点是否仍存在，不据此推断节点业务状态。
  const lifetime = setInterval(() => {
    if (!existsSync(requestFifo) || !existsSync(responseFifo)) void close();
  }, 1_000);
  process.stdin.once("end", () => { void close(); });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: "wave_flow_complete", description: "完成当前受管节点。传入最终 JSON 对象与简短摘要；Control 会校验节点 Schema 并耐久写入结果。成功后才可以结束 ACP turn。", inputSchema: { type: "object", required: ["summary", "result"], properties: { summary: { type: "string" }, result: { type: "object" } }, additionalProperties: false } },
    { name: "wave_flow_block", description: "仅在没有人类决定无法安全继续时阻塞当前节点。answerSchema约束的答案必须是JSON对象，根type只能为object；需要单个数字或字符串时也请放入命名字段。单次调用最多等待约25秒：返回答案时为 { status: \"answered\", blockRequestId, answer }；尚未收到答案时返回 { status: \"waiting\", blockRequestId }，此时必须立即以相同的 blockRequestId、needHelp 与 answerSchema 再次调用本工具继续等待，直到 answered；不要结束回合、不要改参数、不要新建 block。收到答案并确认问题解决后调用 wave_flow_continue。", inputSchema: { type: "object", required: ["needHelp"], properties: { needHelp: { type: "string" }, answerSchema: { type: "object", description: "人类答案的JSON Schema；根type只能为object，答案始终是JSON对象。" }, blockRequestId: { type: "string", description: "重连等待时必传：第一次调用返回的 blockRequestId；首次调用不要传。" } }, additionalProperties: false } },
    { name: "wave_flow_continue", description: "在 wave_flow_block 已返回答案且你确认可继续后恢复当前节点。", inputSchema: { type: "object", required: ["blockRequestId"], properties: { blockRequestId: { type: "string" } }, additionalProperties: false } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    const args = params.arguments ?? {};
    if (params.name === "wave_flow_complete") {
      if (typeof args.summary !== "string" || !isObject(args.result)) throw new Error("wave_flow_complete 需要 summary 字符串和 result JSON 对象。 ");
      await control.request({ action: "complete", summary: args.summary, result: args.result });
      completeResponses.add(extra.requestId);
      return text({ ok: true });
    }
    if (params.name === "wave_flow_block") {
      if (typeof args.needHelp !== "string" || !args.needHelp.trim() || (args.answerSchema !== undefined && !isObject(args.answerSchema))) throw new Error("wave_flow_block 参数无效。 ");
      if (args.blockRequestId !== undefined && (typeof args.blockRequestId !== "string" || !/^[0-9a-f-]{36}$/i.test(args.blockRequestId))) throw new Error("wave_flow_block 的 blockRequestId 必须是首次调用返回的 UUID。 ");
      const blockRequestId = typeof args.blockRequestId === "string" && args.blockRequestId.trim() ? args.blockRequestId : crypto.randomUUID();
      const waiting = control.request({ action: "block", blockRequestId, needHelp: args.needHelp, ...(args.answerSchema ? { answerSchema: args.answerSchema } : {}) });
      // 有界等待：预算到期不改变任何状态，原 FIFO 请求仍在等待；答案到达时旧
      // 请求一并 resolve（无人读取，无害），重连的新调用会立即拿到同一答案。
      const resolution = await Promise.race([waiting, Bun.sleep(waitBudgetMs).then(() => null)]);
      if (!resolution) return text({ status: "waiting", blockRequestId });
      return text({ status: "answered", ...(resolution as { blockRequestId: string; answer: JsonObject }) });
    }
    if (params.name === "wave_flow_continue") {
      if (typeof args.blockRequestId !== "string" || !args.blockRequestId.trim()) throw new Error("wave_flow_continue 需要 blockRequestId。 ");
      await control.request({ action: "continue", blockRequestId: args.blockRequestId });
      return text({ ok: true });
    }
    throw new Error(`未知 Worker Control 工具：${params.name}`);
  });
  await server.connect(transport);
}

function required(key: string): string { const value = process.env[key]?.trim(); if (!value) throw new Error(`Worker MCP 服务缺少 ${key}。`); return value; }
function isObject(value: unknown): value is JsonObject { return !!value && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }; }

/** MCP 进程只经随机 FIFO 对接触当前 Engine；不发 HTTP，也不持有身份/capability。 */
class WorkerControlPipeClient {
  #next = 1;
  #pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #writer: ReturnType<typeof createWriteStream>;
  #reader: ReturnType<typeof createReadStream>;
  #closed = false;

  constructor(requestFifo: string, responseFifo: string) {
    this.#writer = createWriteStream(requestFifo, { flags: "r+" });
    this.#reader = createReadStream(responseFifo, { flags: "r+", encoding: "utf8" });
    const reader = createInterface({ input: this.#reader, crlfDelay: Infinity });
    void this.read(reader);
  }

  /** 端点撤销或stdio关闭时拒绝等待并释放FIFO；幂等，不上报任何业务终态。 */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(new Error("Worker 私有控制通道已关闭。"));
    this.#pending.clear();
    this.#writer.destroy();
    this.#reader.destroy();
  }

  async request(value: Record<string, unknown>): Promise<unknown> {
    if (this.#closed) throw new Error("Worker 私有控制通道已关闭。");
    const requestId = `worker-${process.pid}-${this.#next++}`;
    const response = new Promise<unknown>((resolve, reject) => this.#pending.set(requestId, { resolve, reject }));
    void response.catch(() => undefined);
    try { await new Promise<void>((resolve, reject) => this.#writer.write(`${JSON.stringify({ requestId, ...value })}\n`, error => error ? reject(error) : resolve())); }
    catch (error) { this.#pending.delete(requestId); throw error; }
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
    } catch { /* 通道错误不产生业务事实，释放等待由close统一处理。 */ }
    finally { this.close(); }
  }
}
