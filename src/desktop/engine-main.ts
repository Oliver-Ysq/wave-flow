#!/usr/bin/env bun
import { DesktopExecutionEngine } from "./desktop-execution-engine";

/** Desktop Engine 私有 JSONL 请求；stdin 只接收由 Tauri 创建的管道。 */
type EngineRequest = {
  /** Tauri 生成的关联标识；响应必须原样回传。 */
  readonly requestId: string;
  /** 当前最小控制集合；所有业务请求使用显式 action 而非 HTTP 路由。 */
  readonly method: "engine.status" | "engine.shutdown" | "engine.action";
  /** engine.action 的受限动作名；不是 URL、HTTP method 或可拼接路由。 */
  readonly action?: string;
  /** engine.action 的 JSON 对象参数。 */
  readonly args?: unknown;
};

/** Engine 私有 JSONL 响应；不含 capability、环境变量或 Worker 原生会话信息。 */
type EngineResponse =
  | { readonly requestId: string; readonly ok: true; readonly result: unknown }
  | { readonly requestId: string; readonly ok: false; readonly error: string };

/**
 * 仅由 Tauri 启动的 Desktop Execution Engine 入口。
 *
 * 不监听网络端口，不发布任何发现信息；stdin EOF 表示 Tauri 已失去
 * 该私有通道，Engine 释放会话后退出。正常桌面退出使用 engine.shutdown：先
 * durable-first 写入 cancelled 再尽力终止 Worker 进程组。
 */
async function main(): Promise<void> {
  // 子进程（ACP adapter 与两类 MCP）必须知道自己属于打包 Desktop Engine，不能
  // 解析或启动历史控制面入口。
  process.env.WF_DESKTOP_ENGINE = "1";
  const deterministicForTest = process.env.WF_ENGINE_DETERMINISTIC === "1";
  const engine = new DesktopExecutionEngine({ deterministicForTest });
  // Engine 进程重启时绝不认领旧 ACP session。必须在接受任何新 action 前将
  // 上一个进程遗留的活跃事实收敛，避免 UI 短暂展示一个实际上无人持有的 Worker。
  await engine.convergeStaleAcpWorkers();
  // 事件帧与请求响应共用同一 stdout JSONL 通道：响应带 requestId，事件帧不带；
  // Tauri 按帧形状分流，迟到旧进程帧由 generation 校验丢弃。
  engine.subscribeEvents((frame) => write(frame));
  write({ type: "ready", protocolVersion: 1 });
  const reader = new TextDecoder();
  let buffered = "";
  const lines = async function* (): AsyncGenerator<string> {
    for await (const chunk of Bun.stdin.stream()) {
      buffered += reader.decode(chunk, { stream: true });
      let index: number;
      while ((index = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, index); buffered = buffered.slice(index + 1);
        if (line.trim()) yield line;
      }
    }
    if (buffered.trim()) yield buffered;
  };
  try {
    for await (const line of lines()) {
      const response = await dispatch(engine, line);
      write(response);
      if (response.ok && (requestMethod(line) === "engine.shutdown")) return;
    }
  } finally {
    engine.shutdown();
  }
}

async function dispatch(engine: DesktopExecutionEngine, line: string): Promise<EngineResponse> {
  // 请求参数即使非法，只要带有合法关联 id 就必须回传它；否则 Tauri 无法将错误
  // JSONL 帧关联到等待中的 invoke，会把确定性协议错误误报为超时。
  let requestId = requestIdFromLine(line);
  try {
    const request = parseRequest(line); requestId = request.requestId;
    if (request.method === "engine.status") return { requestId, ok: true, result: await engine.status() };
    if (request.method === "engine.shutdown") { await engine.cancelForDesktopExit(); return { requestId, ok: true, result: { accepted: true } }; }
    if (request.method === "engine.action") return { requestId, ok: true, result: await engine.handleDesktopAction(request.action!, request.args ?? {}) };
    return { requestId, ok: false, error: "未知 Engine 方法。" };
  } catch (error) {
    return { requestId, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function requestIdFromLine(line: string): string {
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    const id = (value as { requestId?: unknown }).requestId;
    return typeof id === "string" && id.trim() ? id : "";
  } catch { return ""; }
}

function parseRequest(line: string): EngineRequest {
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new Error("Engine 请求不是合法 JSON。 "); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Engine 请求必须是对象。 ");
  const request = value as Partial<EngineRequest>;
  if (typeof request.requestId !== "string" || !request.requestId.trim()) {
    const keys = Object.keys(request).sort().join(", ");
    throw new Error(`Engine 请求缺少 requestId（收到字段：${keys || "无"}）。`);
  }
  if (request.method === "engine.action") {
    if (typeof request.action !== "string" || !request.action.trim()) throw new Error("Engine action 请求缺少 action。 ");
    if (request.args !== undefined && (!request.args || typeof request.args !== "object" || Array.isArray(request.args))) throw new Error("Engine action 参数必须是对象。 ");
  } else if (request.method !== "engine.status" && request.method !== "engine.shutdown") throw new Error("Engine 请求方法无效。 ");
  return request as EngineRequest;
}

function requestMethod(line: string): EngineRequest["method"] | null {
  try { return parseRequest(line).method; } catch { return null; }
}
function write(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }

/** 打包后的 Worker MCP 也必须由 Engine binary 启动，不能回退到任何旧控制面入口。 */
process.env.WF_DESKTOP_ENGINE = "1";
if (process.argv[2] === "__codex-acp") {
  await import("@agentclientprotocol/codex-acp");
} else if (process.argv[2] === "__worker-mcp") {
  const { runWorkerMcpServer } = await import("../runtime/worker-mcp-server");
  // 测试注入的小预算走显式参数；生产路径永远使用默认 25s，不读取任何用户配置。
  const budgetOverride = Number(process.env.WF_WORKER_BLOCK_WAIT_BUDGET_MS);
  await runWorkerMcpServer(Number.isFinite(budgetOverride) && budgetOverride > 0 ? budgetOverride : undefined);
} else if (process.argv[2] === "__harness-mcp") {
  const { runHarnessMcpServer } = await import("../harness/mcp-server");
  await runHarnessMcpServer();
} else if (process.argv[2] === "__mcp-probe") {
  const { runMcpProbeServer } = await import("../runtimes/mcp-probe");
  await runMcpProbeServer();
} else {
  main().catch((error) => { process.stderr.write(`Wave Flow Desktop Engine: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
