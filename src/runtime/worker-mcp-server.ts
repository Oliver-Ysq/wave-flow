import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { JsonObject } from "../shared/json";

/**
 * 为单个受管 Coding Worker 提供的完成协议 MCP sidecar。
 *
 * 环境变量只在该 ACP session 的 MCP 子进程可见。它们携带的 capability 仍会由
 * daemon Control 复核；sidecar 不读写 Journal、Runtime、业务工作区或任意 shell。
 */
export async function runWorkerMcpServer(): Promise<void> {
  const baseUrl = required("WF_WORKER_MCP_BASE_URL");
  const capability = required("WF_WORKER_MCP_CAPABILITY");
  const runId = required("WF_WORKER_MCP_RUN_ID");
  const nodeId = required("WF_WORKER_MCP_NODE_ID");
  const agentSessionId = required("WF_WORKER_MCP_AGENT_SESSION_ID");
  const identity = { runId, nodeId, agentSessionId, capability };
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
      await post(baseUrl, `/runs/${encodeURIComponent(runId)}/control/complete`, { ...identity, summary: args.summary, result: args.result });
      return text({ ok: true });
    }
    if (params.name === "wave_flow_block") {
      if (typeof args.needHelp !== "string" || !args.needHelp.trim() || (args.answerSchema !== undefined && !isObject(args.answerSchema))) throw new Error("wave_flow_block 参数无效。 ");
      const blockRequestId = crypto.randomUUID();
      const result = await post(baseUrl, `/runs/${encodeURIComponent(runId)}/control/block-active`, { ...identity, blockRequestId, needHelp: args.needHelp, ...(args.answerSchema ? { answerSchema: args.answerSchema } : {}) });
      return text(result);
    }
    if (params.name === "wave_flow_continue") {
      if (typeof args.blockRequestId !== "string" || !args.blockRequestId.trim()) throw new Error("wave_flow_continue 需要 blockRequestId。 ");
      await post(baseUrl, `/runs/${encodeURIComponent(runId)}/control/continue-active`, { ...identity, blockRequestId: args.blockRequestId });
      return text({ ok: true });
    }
    throw new Error(`未知 Worker Control 工具：${params.name}`);
  });
  await server.connect(new StdioServerTransport());
}

function required(key: string): string { const value = process.env[key]?.trim(); if (!value) throw new Error(`Worker MCP sidecar 缺少 ${key}。`); return value; }
function isObject(value: unknown): value is JsonObject { return !!value && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }; }
async function post(baseUrl: string, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json() as { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Worker Control 请求失败：${response.status}`);
  return value;
}
