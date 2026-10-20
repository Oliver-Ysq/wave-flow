import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { waveFlowHome } from "../journal/paths";
import type { DesktopExecutionEngine } from "./desktop-execution-engine";

/** 慢/挂死 action 落盘诊断；Tauri 会丢弃 ready 后的 stderr，必须写文件才可回溯。 */
function diag(line: string): void {
  void appendFile(join(waveFlowHome(), "runtime", "engine-diagnostic.log"), `${new Date().toISOString()} ${line}\n`).catch(() => {});
}

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
 * 逐行并发派发 Engine 请求：每行独立 dispatch，响应以 requestId 关联、完成即写回，
 * 不保证到达顺序。一个慢或挂死的 action（如冷启动时的 CLI 扫描）不得队头阻塞后续
 * 请求——方案页执行配置检查本身亚秒级，曾因排在串行扫描后无限转圈。
 * 与 Worker 控制 FIFO 同一先例：并发处理，避免首个未返回请求饿死后续请求。
 * engine.shutdown 排空全部在途请求后才返回，已接受请求的响应不被截断。
 */
export async function serveEngineRequests(engine: DesktopExecutionEngine, lines: AsyncIterable<string>, write: (value: unknown) => void): Promise<void> {
  const inFlight = new Set<Promise<unknown>>();
  try {
    for await (const line of lines) {
      const task = dispatch(engine, line).then((response) => { write(response); return response; });
      const tracked: Promise<unknown> = task.finally(() => { inFlight.delete(tracked); });
      inFlight.add(tracked);
      if (requestMethod(line) === "engine.shutdown" && (await task).ok) break;
    }
  } finally {
    // 排空有界：父进程已消失或 action 楔死时，无限等待会让 Engine 永久驻留。
    // 取值对齐 Orca provider supervisor 的 stdin 结束宽限（1 秒）；测试用环境变量覆盖。
    const override = Number(process.env.WF_ENGINE_DRAIN_BUDGET_MS);
    const budget = Number.isFinite(override) && override > 0 ? override : 1_000;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      Promise.allSettled([...inFlight]),
      new Promise<void>((resolve) => { drainTimer = setTimeout(resolve, budget); }),
    ]);
    // 排空正常完成时清除兜底定时器，否则待触发的 5 秒定时器会拖住进程退出。
    if (drainTimer) clearTimeout(drainTimer);
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
    if (request.method === "engine.action") {
      const actionStartedAt = Date.now();
      // 悬挂看门狗：action 超过 10 秒未返回即写诊断日志，挂死场景能直接定位卡点；
      // 完成后 1 秒以上的慢动作也记录。两者都只读诊断，不改变行为。
      const watchdog = setTimeout(() => {
        diag(`stuck action ${request.action} >10s (requestId=${requestId})`);
      }, 10_000);
      try {
        const result = await engine.handleDesktopAction(request.action!, request.args ?? {});
        const elapsed = Date.now() - actionStartedAt;
        if (elapsed > 1_000) diag(`slow action ${request.action} ${elapsed}ms`);
        return { requestId, ok: true, result };
      } finally {
        clearTimeout(watchdog);
      }
    }
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
    const keys = Object.keys(value).sort().join(", ");
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
