import { appendFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError, type ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";
import { connectControlSocket } from "./control-socket";
import type { JsonObject } from "../shared/json";

/** 单次人工请求的最长业务等待；超时只关闭本次 Elicitation，可恢复重开。 */
const WORKER_ELICIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * 为单个受管 Coding Worker 提供的完成协议 MCP sidecar。
 *
 * 环境变量只在该 ACP session 的 MCP 子进程可见：一个随机私有 Unix socket 路径，
 * 以及可选的本节点 resultSchema。身份与 capability 由 Engine 在 socket 服务端绑定，
 * Control 仍复核节点状态与 Schema；sidecar 不读写 Journal、Runtime、业务工作区或任意 shell。
 */
export async function runWorkerMcpServer(): Promise<void> {
  const socketPath = required("WF_WORKER_CONTROL_SOCKET");
  // resultSchema 内联进完成工具的 inputSchema：工具定义每次请求都会重发，
  // 因此它是唯一不随对话历史被压缩折叠的完成条件载体。
  const resultSchema = readResultSchema();
  const control = await connectControlSocket({ socketPath, idPrefix: "worker", capability: required("WF_WORKER_CONTROL_CAPABILITY") });
  // 真机验收可选的协议轨迹：只记录工具名、结果与错误摘要，不记录 result 正文。
  const tracePath = process.env.WF_MCP_TRACE;
  const trace = (event: { readonly phase: "tools/list" | "call" | "ok" | "error"; readonly tool?: string; readonly detail?: string }): void => {
    if (!tracePath) return;
    try { appendFileSync(tracePath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`); } catch { /* 诊断失败不影响协议。 */ }
  };
  const server = new Server({ name: "wave-flow-worker-control", version: "1" }, { capabilities: { tools: {} } });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    control.close();
    await server.close();
    // Engine 关闭通道时显式结束独占 sidecar，不能让旧 block 计时器续命。
    process.stdout.write("", () => process.exit(0));
  };
  // 完成响应先经stdio flush，再退出；否则Engine完成清理可能抢先丢失MCP成功确认。
  const completeResponses = new Set<string | number>();
  const transport = new StdioServerTransport();
  let clientConnectionClosed = false;
  transport.onclose = () => { clientConnectionClosed = true; };
  const send = transport.send.bind(transport);
  transport.send = async (message) => {
    await send(message);
    if ("id" in message && message.id !== undefined && completeResponses.delete(message.id)) void close();
  };
  // Engine 关闭通道（节点收尾或 Engine 退出）时自行退出；socket 关闭事件可靠，
  // 不再轮询文件是否存在，也不据此推断节点业务状态。
  // 但必须先让进行中的 tools/call 拿到"通道已关闭"的错误并写回 stdio：直接退出会把
  // 调用丢给客户端，表现为 MCP 调用一直等到客户端超时（实测 300 秒）。
  void control.closed.then(async () => {
    for (let index = 0; index < 40 && inFlight > 0; index += 1) await Bun.sleep(50);
    await close();
  });
  process.stdin.once("end", () => { void close(); });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    trace({ phase: "tools/list", detail: "complete,block" });
    return ({ tools: [
    { name: "wave_flow_complete", description: resultSchema ? "完成当前受管节点。传入最终 JSON 对象与简短摘要；result 必须符合本节点 resultSchema（已内联在 inputSchema 的 result 属性中），Control 会再次校验并耐久写入结果。成功后才可以结束 ACP turn。" : "完成当前受管节点。传入最终 JSON 对象与简短摘要；Control 会校验节点 Schema 并耐久写入结果。成功后才可以结束 ACP turn。", inputSchema: { type: "object", required: ["summary", "result"], properties: { summary: { type: "string" }, result: resultSchema ?? { type: "object" } }, additionalProperties: false } },
    { name: "wave_flow_block", description: "仅在没有人类决定无法安全继续时请求人工协助。必须提供扁平 answerSchema：根 type 为 object 且至少一个字段；字段只允许 string/number/integer/boolean 或字符串单选 enum，禁止嵌套、数组多选、动态字段、条件约束和自由正则。answered 表示答案与可选 userNote 已交付并自动继续；closed 表示表单关闭，宿主可在同一会话恢复，不要新建 block 或改参数。blockRequestId 只用于宿主恢复时重接同一请求，首次调用不要传。", inputSchema: { type: "object", required: ["needHelp", "answerSchema"], properties: { needHelp: { type: "string" }, answerSchema: { type: "object", description: "扁平人类答案 JSON Schema；禁止嵌套、数组多选、动态字段和条件约束。" }, blockRequestId: { type: "string", description: "仅宿主恢复时重接原请求使用；首次调用不要传。" } }, additionalProperties: false } },
  ] }); });
  let inFlight = 0;
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    inFlight += 1;
    trace({ phase: "call", tool: params.name });
    try {
    const args = params.arguments ?? {};
    if (params.name === "wave_flow_complete") {
      if (typeof args.summary !== "string" || !isObject(args.result)) throw new Error("wave_flow_complete 需要 summary 字符串和 result JSON 对象。 ");
      await control.request({ action: "complete", summary: args.summary, result: args.result });
      completeResponses.add(extra.requestId);
      trace({ phase: "ok", tool: params.name });
      return text({ ok: true });
    }
    if (params.name === "wave_flow_block") {
      if (typeof args.needHelp !== "string" || !args.needHelp.trim() || !isObject(args.answerSchema)) throw new Error("wave_flow_block 需要 needHelp 和扁平 answerSchema。 ");
      if (args.blockRequestId !== undefined && (typeof args.blockRequestId !== "string" || !/^[0-9a-f-]{36}$/i.test(args.blockRequestId))) throw new Error("wave_flow_block 的 blockRequestId 必须是首次调用返回的 UUID。 ");
      const blockRequestId = typeof args.blockRequestId === "string" && args.blockRequestId.trim() ? args.blockRequestId : crypto.randomUUID();
      const status = await control.request({ action: "block", blockRequestId, needHelp: args.needHelp, answerSchema: args.answerSchema }) as { readonly answerSchema: JsonObject; readonly answer: JsonObject | null; readonly userNote: string | null; readonly delivery: "pending" | "answered" | "closed" | "delivered"; readonly deliveryToken?: string };
      if (status.answer) {
        await control.request({ action: "continue", blockRequestId });
        return answeredText(blockRequestId, status);
      }
      if (status.delivery === "closed") return text({ status: "closed", blockRequestId });
      const resolution = await server.elicitInput({
        mode: "form",
        message: args.needHelp,
        requestedSchema: status.answerSchema as ElicitRequestFormParams["requestedSchema"],
        _meta: { waveFlow: { blockRequestId } },
      }, { timeout: WORKER_ELICIT_TIMEOUT_MS, signal: extra.signal }).catch(async (error: unknown) => {
        // SDK 将业务超时与 tools/call 的显式取消都归为 RequestTimeout；连接死亡不属于可重开关闭。
        if (!clientConnectionClosed && error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
          await control.request({ action: "close-block", blockRequestId, deliveryToken: status.deliveryToken });
          return null;
        }
        throw error;
      });
      if (resolution === null) {
        const current = await control.request({ action: "block", blockRequestId, needHelp: args.needHelp, answerSchema: args.answerSchema }) as typeof status;
        if (current.answer) {
          await control.request({ action: "continue", blockRequestId });
          return answeredText(blockRequestId, current);
        }
        return text({ status: "closed", blockRequestId });
      }
      if (resolution.action === "accept" && isObject(resolution.content)) {
        const durable = await control.request({ action: "block", blockRequestId, needHelp: args.needHelp, answerSchema: args.answerSchema }) as typeof status;
        if (!durable.answer || !isDeepStrictEqual(durable.answer, resolution.content)) throw new Error("ACP 返回答案与 Journal 中的人工答案不一致，拒绝 continue。 ");
        await control.request({ action: "continue", blockRequestId });
        return answeredText(blockRequestId, durable);
      }
      await control.request({ action: "close-block", blockRequestId, deliveryToken: status.deliveryToken });
      const current = await control.request({ action: "block", blockRequestId, needHelp: args.needHelp, answerSchema: args.answerSchema }) as typeof status;
      if (current.answer) {
        await control.request({ action: "continue", blockRequestId });
        return answeredText(blockRequestId, current);
      }
      return text({ status: "closed", blockRequestId });
    }
    throw new Error(`未知 Worker Control 工具：${params.name}`);
    } catch (error) {
      trace({ phase: "error", tool: params.name, detail: (error instanceof Error ? error.message : String(error)).slice(0, 240) });
      throw error;
    } finally { inFlight -= 1; }
  });
  await server.connect(transport);
}

function required(key: string): string { const value = process.env[key]?.trim(); if (!value) throw new Error(`Worker MCP 服务缺少 ${key}。`); return value; }

/**
 * 读取 Engine 注入的本节点 resultSchema。
 *
 * 缺省表示该节点没有声明结果 Schema，工具仍按对象形状通告。
 * 已声明但无法解析时直接失败：静默降级会让模型拿到与实际校验不同的契约，
 * 产出的结果在 Control 侧必然被拒，比启动失败更难排查。
 */
function readResultSchema(): JsonObject | null {
  const raw = process.env.WF_WORKER_RESULT_SCHEMA?.trim();
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("Worker MCP 服务收到的 WF_WORKER_RESULT_SCHEMA 不是合法 JSON。"); }
  if (!isObject(value)) throw new Error("Worker MCP 服务收到的 WF_WORKER_RESULT_SCHEMA 不是 JSON 对象。");
  return value;
}

/** answered 的统一交付形状：意见只来自 Control 耐久副本，不进入 ACP accept content。 */
function answeredText(blockRequestId: string, status: { readonly answer: JsonObject | null; readonly userNote: string | null }) {
  if (!status.answer) throw new Error("answered 交付缺少 Control 耐久答案。 ");
  return text({ status: "answered", blockRequestId, answer: status.answer, ...(status.userNote ? { userNote: status.userNote } : {}) });
}

function isObject(value: unknown): value is JsonObject { return !!value && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }; }
