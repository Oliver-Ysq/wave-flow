import type { CreateRunRequest, ResumeRunRequest, RunResponse } from "../daemon/types";
import type { CapabilitySnapshot } from "../adapters/capabilities";

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
        if (snapshot.snapshot.status !== "running") return;
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
          if (snapshot.snapshot.status !== "running") return true;
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
