import type { ControlServer } from "../control/control-server";
import { resolveWorkerLauncher } from "../runtimes/worker-launcher-resolver";
import { runtimeProvenance } from "../runtimes/worker-launcher-resolver";
import type { AcpLauncher } from "../adapters/acp-session";
import type { CliRuntimeRegistry } from "../runtimes/registry";
import type { RuntimeProvenance, VerifiedCliRuntime } from "../runtimes/types";
import { AcpWorkerExecutor } from "./acp-worker-executor";
import type { AgentNodeExecutor, AgentNodeSnapshot } from "./run-types";
import type { JsonObject } from "../shared/json";
import type * as acp from "@agentclientprotocol/sdk";

/**
 * 延迟解析用户 Runtime 的 ACP Executor。Run/Execution 可先建立 Journal 与 Control，
 * 但真正启动第一个 Agent 前必须再次读取 Registry 并按节点 cli 复核已验证 Worker
 * 候选的文件身份；没有可用候选时 fail closed，绝不回退到随包 CLI。
 *
 * 受限 Execution 的指派节点（request.assignedRuntimeId）按分配快照直接解析目标；
 * 解析、launcher 组装或 ACP session 建立前失败时，允许一次性回退到快照冻结的主控
 * Runtime，并耐久 Journal 诊断。agent.session 已耐久的失败绝不回退——已投递节点
 * 只能收敛为 interrupted，由用户显式 resume。
 */
export class RuntimeAcpWorkerExecutor implements AgentNodeExecutor {
  #control: ControlServer | null = null;
  #workers = new Map<string, AcpWorkerExecutor>();

  constructor(
    private readonly runtimes: CliRuntimeRegistry,
    private readonly createControlMcp: (value: { readonly runId: string; readonly nodeId: string; readonly agentSessionId: string; readonly capability: string }) => acp.McpServer,
    /** 测试注入的 Worker 构造；生产省略时使用真实 AcpWorkerExecutor。 */
    private readonly createWorker: (launcher: AcpLauncher, runtime: RuntimeProvenance) => AcpWorkerExecutor = (launcher, runtime) => new AcpWorkerExecutor(launcher, undefined, runtime, createControlMcp),
    /** 分配快照冻结的回退目标（主控 CLI runtimeId）；受信任 Run 与不指派节点为 null。 */
    private readonly fallbackRuntimeId: string | null = null,
  ) {}

  bindControl(control: ControlServer): void {
    if (this.#control) throw new Error("Runtime ACP Worker 已绑定 ControlServer。 ");
    this.#control = control;
  }

  async execute(node: AgentNodeSnapshot) {
    const control = this.#control;
    if (!control) throw new Error("Runtime ACP Worker 尚未绑定 ControlServer。 ");
    const assignedRuntimeId = node.request.assignedRuntimeId;
    if (!assignedRuntimeId) return this.launch(node, await this.runtimes.resolveWorker(node.cli), control);
    try {
      return await this.launch(node, await this.runtimes.resolveWorkerById(assignedRuntimeId), control);
    } catch (error) {
      // 回退边界：agent.session 一旦耐久，说明 ACP session 已建立、任务可能已投递，
      // 此后任何失败都不允许换 CLI，避免同一任务在两个 Runtime 上重复副作用。
      if (!this.fallbackRuntimeId || this.fallbackRuntimeId === assignedRuntimeId) throw error;
      if (!node.agentSessionId || control.hasRecordedNodeSession(node.id, node.agentSessionId)) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      const fallback = await this.runtimes.resolveWorkerById(this.fallbackRuntimeId);
      await control.recordExecutorDiagnostic(`节点 ${node.id} 的分配 Runtime ${assignedRuntimeId} 启动前失败（${reason.slice(0, 200)}），已回退到主控 Runtime ${this.fallbackRuntimeId}。`);
      return this.launch(node, fallback, control);
    }
  }

  /** 用已复核的 Runtime 组装 launcher 并执行；createSession 抛错前都允许上层回退。 */
  private async launch(node: AgentNodeSnapshot, runtime: VerifiedCliRuntime, control: ControlServer): Promise<JsonObject | null> {
    const worker = this.createWorker(resolveWorkerLauncher(runtime), runtimeProvenance(runtime));
    worker.bindControl(control);
    const key = keyOf(node);
    this.#workers.set(key, worker);
    try { return await worker.execute(node); }
    finally { this.#workers.delete(key); }
  }

  async pause(node: AgentNodeSnapshot, signal?: AbortSignal): Promise<void> { return this.require(node).pause(node, signal); }
  async recover(node: AgentNodeSnapshot, signal?: AbortSignal): Promise<{}> { return this.require(node).recover(node, signal); }
  async stop(node: AgentNodeSnapshot): Promise<void> { return this.require(node).stop(node); }
  private require(node: AgentNodeSnapshot): AcpWorkerExecutor { const worker = this.#workers.get(keyOf(node)); if (!worker) throw new Error(`节点 ${node.id} 没有可控制的本机 CLI ACP 会话。`); return worker; }
}
function keyOf(node: AgentNodeSnapshot): string { return `${node.id}:${node.agentSessionId ?? ""}`; }
