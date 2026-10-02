import type { CreateRunRequest, RunResponse } from "../daemon/types";

/** 仅通过 loopback HTTP 与 daemon 通信的 CLI 客户端。 */
export class DaemonClient {
  constructor(private readonly baseUrl: string) {}

  /** 请求 daemon 创建并完成一条开发验证 Run。 */
  async createRun(request: CreateRunRequest): Promise<RunResponse> {
    return this.request("/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
  }

  /** 请求 daemon 返回内存或 Journal 重建的 Run 查询视图。 */
  async inspect(runId: string, cwd: string): Promise<RunResponse> {
    return this.request(`/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
  }

  private async request(path: string, init?: RequestInit): Promise<RunResponse> {
    const response = await fetch(`${this.baseUrl}${path}`, init);
    const value = await response.json() as RunResponse | { error: string };
    if (!response.ok || "error" in value) throw new Error("error" in value ? value.error : `daemon 请求失败：${response.status}`);
    return value;
  }
}
