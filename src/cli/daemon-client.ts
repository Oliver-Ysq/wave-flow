import type { CloseDaemonResponse, CreateRunRequest, ResumeRunRequest, RunResponse } from "../daemon/types";
import type { CapabilitySnapshot } from "../adapters/capabilities";

/** 仅表示已验证 daemon 明确不认识新版关闭接口，供 CLI 做受限旧版兼容。 */
export class UnsupportedDaemonCloseEndpointError extends Error {
  constructor() { super("当前 daemon 不支持优雅关闭接口。"); }
}

/** 仅通过 loopback HTTP 与 daemon 通信的 CLI 客户端。 */
export class DaemonClient {
  constructor(private readonly baseUrl: string) {}

  /** 请求 daemon 创建并完成一条开发验证 Run。 */
  async createRun(request: CreateRunRequest): Promise<RunResponse> {
    const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) } as const;
    try { return await this.request("/runs", init); } catch (error) {
      // 仅传输层异常重试一次，始终复用同一 clientRequestId。daemon 会将其绑定到
      // manifest，故“服务已创建 Run、响应却丢失”不会生成第二个 Agent。
      if (!(error instanceof TypeError)) throw error;
      return this.request("/runs", init);
    }
  }

  /** 请求 daemon 返回内存或用户级 Journal 重建的 Run 查询视图。 */
  async inspect(runId: string): Promise<RunResponse> {
    return this.request(`/runs/${encodeURIComponent(runId)}`);
  }

  /** 用户明确授权后请求同一 Run 的调用级 resume。 */
  async resume(runId: string): Promise<RunResponse> {
    return this.request(`/runs/${encodeURIComponent(runId)}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ authorized: true } satisfies ResumeRunRequest) });
  }

  /** 暂停当前 daemon 持有的 Run；daemon 负责真实会话控制和状态耐久化。 */
  async pause(runId: string): Promise<RunResponse> {
    return this.request(`/runs/${encodeURIComponent(runId)}/pause`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  }

  /** 在原 thread 创建新回合继续；不得重发原 Prompt。 */
  async recover(runId: string): Promise<RunResponse> {
    return this.request(`/runs/${encodeURIComponent(runId)}/recover`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  }

  /** 停止当前 Run；终态不可 recover，只能用户显式 resume/replay。 */
  async stop(runId: string): Promise<RunResponse> {
    return this.request(`/runs/${encodeURIComponent(runId)}/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  }

  /** 请求已验证 daemon 优雅关闭；旧版明确不支持接口时由调用方决定是否安全兼容。 */
  async closeDaemon(): Promise<CloseDaemonResponse> {
    const response = await fetch(`${this.baseUrl}/daemon/close`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const value = await response.json() as CloseDaemonResponse | { error: string };
    if (response.status === 404 && "error" in value && value.error === "未知 daemon API 路径或方法。") throw new UnsupportedDaemonCloseEndpointError();
    if (!response.ok || "error" in value) throw new Error("error" in value ? value.error : `daemon 请求失败：${response.status}`);
    return value;
  }

  /** 请求 daemon 返回当前机器的三态能力快照。 */
  async capabilities(): Promise<CapabilitySnapshot> {
    const response = await fetch(`${this.baseUrl}/capabilities`);
    const value = await response.json() as CapabilitySnapshot | { error: string };
    if (!response.ok || "error" in value) throw new Error("error" in value ? value.error : `daemon 请求失败：${response.status}`);
    return value;
  }

  /** 订阅某个 Run 的 daemon 权威快照；调用方取消 signal 只停止观看，不停止 Run。 */
  async followRun(runId: string, onSnapshot: (response: RunResponse) => void, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const terminal = await this.followRunOnce(runId, onSnapshot, signal);
        if (terminal) return;
      } catch (error) {
        if (signal.aborted) return;
        // SSE 在终态 close 与网络瞬断时都可能报 socket closed。此时以 daemon 权威
        // 快照裁决：已终结就显示最终状态；仍运行则短暂退避后重新订阅。
        const snapshot = await this.inspect(runId);
        onSnapshot(snapshot);
        if (snapshot.snapshot.status !== "running" && snapshot.snapshot.status !== "pausing" && snapshot.snapshot.status !== "recovering") return;
        await abortableDelay(200, signal);
      }
    }
  }

  private async followRunOnce(runId: string, onSnapshot: (response: RunResponse) => void, signal: AbortSignal): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/events`, { headers: { accept: "text/event-stream" }, signal });
    if (!response.ok || !response.body) throw new Error(`Run 事件流连接失败：${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return false;
        buffer += decoder.decode(chunk.value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
          if (!data) continue;
          const snapshot = JSON.parse(data) as RunResponse;
          onSnapshot(snapshot);
          if (snapshot.snapshot.status !== "running" && snapshot.snapshot.status !== "pausing" && snapshot.snapshot.status !== "recovering") return true;
        }
      }
    } finally { reader.releaseLock(); }
  }

  private async request(path: string, init?: RequestInit): Promise<RunResponse> {
    const response = await fetch(`${this.baseUrl}${path}`, init);
    const value = await response.json() as RunResponse | { error: string };
    if (!response.ok || "error" in value) throw new Error("error" in value ? value.error : `daemon 请求失败：${response.status}`);
    return value;
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    const abort = () => { clearTimeout(timer); reject(new Error("Run 观看已取消。")); };
    signal.addEventListener("abort", abort, { once: true });
  });
}
