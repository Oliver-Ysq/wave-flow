import type { ControlServer } from "../control/control-server";
import { resolveWorkerLauncher } from "../runtimes/worker-launcher-resolver";
import { runtimeProvenance } from "../runtimes/worker-launcher-resolver";
import { AcpSessionClient, type AcpLauncher } from "../adapters/acp-session";
import type { CliRuntimeRegistry } from "../runtimes/registry";
import type { RuntimeProvenance, VerifiedCliRuntime } from "../runtimes/types";
import { AcpWorkerExecutor } from "./acp-worker-executor";
import type { AgentNodeExecutor, AgentNodeSnapshot } from "./run-types";
import type { JsonObject } from "../shared/json";
import type * as acp from "@agentclientprotocol/sdk";
import { prepareSessionScratch } from "../workspace/session-scratch";
import { prepareSessionSkills } from "../skills/session";
import { adapterById } from "../runtimes/adapter-catalog";
import { ownedAcpTransport } from "../workspace/managed-acp-transport";
import { WriterProcessGroups } from "../workspace/writer-process-group";
import { WorkflowContractError } from "../workflow/errors";
import { logWorkerLifecycle } from "./worker-lifecycle-log";

/**
 * 延迟解析用户 Runtime 的 ACP Executor。Run/Execution 可先建立 Journal 与 Control，
 * 但真正启动第一个 Agent 前必须再次读取 Registry 并按节点 cli 复核已验证 Worker
 * 候选的文件身份；没有可用候选时 fail closed，绝不回退到随包 CLI。
 *
 * 历史 assigned 配置的指派节点（request.assignedRuntimeId）按分配快照直接解析目标；
 * 解析、launcher 组装或 ACP session 建立前失败时，允许一次性回退到快照冻结的主控
 * Runtime，并耐久 Journal 诊断。agent.session 已耐久的失败绝不回退——已投递节点
 * 只能收敛为 interrupted，由用户显式 resume。
 */
export class RuntimeAcpWorkerExecutor implements AgentNodeExecutor {
  #control: ControlServer | null = null;
  #workers = new Map<string, AcpWorkerExecutor>();
  /** 只保留退出未核验的本实例句柄，供宿主收尾重试；不跨Engine认领旧PID。 */
  #closing = new Map<string, AcpWorkerExecutor>();

  constructor(
    private readonly runtimes: CliRuntimeRegistry,
    private readonly createControlMcp: (value: { readonly runId: string; readonly nodeId: string; readonly agentSessionId: string; readonly capability: string }, scratch?: string) => acp.McpServer,
    /** 测试注入的 Worker 构造；生产省略时使用真实 AcpWorkerExecutor。 */
    private readonly createWorker: (launcher: AcpLauncher, runtime: RuntimeProvenance) => AcpWorkerExecutor = (launcher, runtime) => new AcpWorkerExecutor(launcher, undefined, runtime, createControlMcp),
    /** 分配快照冻结的回退目标（主控 CLI runtimeId）；受信任 Run 与不指派节点为 null。 */
    private readonly fallbackRuntimeId: string | null = null,
    /** Engine指定的Worker私有Control状态根；省略仅供历史测试，生产必须提供。 */
    private readonly workerStateRoot?: string,
    /** 技能库根目录；缺省 `waveFlowHome()/skills`，测试与隔离运行可注入。 */
    private readonly skillsRoot?: string,
  ) {}

  bindControl(control: ControlServer): void {
    if (this.#control) throw new Error("Runtime ACP Worker 已绑定 ControlServer。 ");
    this.#control = control;
  }

  async execute(node: AgentNodeSnapshot) {
    const control = this.#control;
    if (!control) throw new Error("Runtime ACP Worker 尚未绑定 ControlServer。 ");
    const assignedRuntimeId = node.request.assignedRuntimeId;
    if (!assignedRuntimeId) return this.launchWithStartupRetry(node, await this.runtimes.resolveWorker(node.cli), control);
    try {
      return await this.launchWithStartupRetry(node, await this.runtimes.resolveWorkerById(assignedRuntimeId), control);
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

  /**
   * 启动超时发生在 prompt 投递前，没有业务副作用；自动换新进程重试一次，
   * 不让用户先看到技术错误再自己决定是否恢复。agent.session 已耐久后不重试。
   */
  private async launchWithStartupRetry(node: AgentNodeSnapshot, runtime: VerifiedCliRuntime, control: ControlServer): Promise<JsonObject | null> {
    try {
      return await this.launch(node, runtime, control);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ACP Worker 启动超时")) throw error;
      if (node.agentSessionId && control.hasRecordedNodeSession(node.id, node.agentSessionId)) throw error;
      if (control.isNodeStopped?.(node.id)) throw error;
      await control.recordExecutorDiagnostic(`节点 ${node.id} 的 Worker 启动未完成，正在自动重启一次；这是启动阶段重试，不会重发已投递任务。`, node.id, node.agentSessionId ?? "").catch(() => {});
      await control.recordExecutorHint?.("本地执行环境正在自动恢复，请稍候…", node.id, node.agentSessionId ?? "").catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 250));
      if (control.isNodeStopped?.(node.id)) throw error;
      return this.launch(node, runtime, control);
    }
  }

  /** 用已复核的 Runtime 组装 launcher 并执行；createSession 抛错前都允许上层回退。 */
  private async launch(node: AgentNodeSnapshot, runtime: VerifiedCliRuntime, control: ControlServer): Promise<JsonObject | null> {
    let worker: AcpWorkerExecutor;
    let owned = false;
    const startedAt = performance.now();
    const stage = (name: string, diagnostic?: string): void => logWorkerLifecycle({
      stage: name,
      runId: control.runId,
      nodeId: node.id,
      agentSessionId: node.agentSessionId ?? "",
      cli: node.cli,
      elapsedMs: Math.round(performance.now() - startedAt),
      ...(diagnostic ? { diagnostic } : {}),
    });
    if (this.workerStateRoot) {
      if (node.sandbox !== "read-only") throw new WorkflowContractError("业务写Worker必须通过已授权Workspace执行器，不能回退普通ACP启动。");
      stage("scratch_start");
      const scratch = await prepareSessionScratch(this.workerStateRoot, node.cwd);
      stage("scratch_ready");
      const capability = adapterById(runtime.verifiedAdapter.adapterId)?.skills;
      stage("skills_start");
      const prepared = capability === undefined && this.skillsRoot === undefined
        ? { launcher: resolveWorkerLauncher(runtime), session: undefined, evidence: null }
        : await prepareSessionSkills({ scratch, launcher: resolveWorkerLauncher(runtime), capability, libraryRoot: this.skillsRoot });
      stage("skills_ready");
      const transport = ownedAcpTransport({ groups: new WriterProcessGroups(), bindWriter: async () => {} });
      worker = new AcpWorkerExecutor(prepared.launcher, value => new AcpSessionClient(value, transport, "allow"), runtimeProvenance(runtime, prepared.evidence), identity => this.createControlMcp(identity, scratch), undefined, true, undefined, prepared.session, prepared.evidence && capability ? { expected: prepared.evidence.names, match: capability.advertisedMatch } : undefined);
      owned = true;
    } else worker = this.createWorker(resolveWorkerLauncher(runtime), runtimeProvenance(runtime));
    worker.bindControl(control);
    const key = keyOf(node);
    this.#workers.set(key, worker);
    stage("worker_bound");
    try {
      stage("execute_start");
      const result = await worker.execute(node);
      stage("execute_end");
      if (owned) { this.#closing.set(key, worker); await this.finalizeCompleted(node); }
      return result;
    } catch (error) {
      stage("execute_error", error instanceof Error ? error.message : String(error));
      // 异常也尽力核验退出，但原错误仍是权威诊断；未知退出不认领或重派发。
      if (owned) {
        this.#closing.set(key, worker);
        try { await this.finalizePartial(node); } catch { /* 保留句柄，不掩盖原执行/退出错误。 */ }
      }
      throw error;
    } finally { this.#workers.delete(key); }
  }

  async pause(node: AgentNodeSnapshot, signal?: AbortSignal): Promise<void> { return this.require(node).pause(node, signal); }
  /** 正常或completed重放只核验本Engine留下的句柄；无句柄不重新启动CLI。
   * 只读节点没有业务文件交接；跨Engine复用结果仍由Journal/provenance复核。
   */
  async finalizeCompleted(node: AgentNodeSnapshot): Promise<void> {
    const key = keyOf(node), worker = this.#closing.get(key);
    if (!worker) return;
    await worker.finalizeCompleted(node);
    this.#closing.delete(key);
  }
  /** 中断收尾核验与completed同实现，不改变业务状态。 */
  finalizePartial(node: AgentNodeSnapshot): Promise<void> { return this.finalizeCompleted(node); }
  async recover(node: AgentNodeSnapshot, signal?: AbortSignal): Promise<{}> { return this.require(node).recover(node, signal); }
  async stop(node: AgentNodeSnapshot): Promise<void> { return this.require(node).stop(node); }
  private require(node: AgentNodeSnapshot): AcpWorkerExecutor { const worker = this.#workers.get(keyOf(node)); if (!worker) throw new Error(`节点 ${node.id} 没有可控制的本机 CLI ACP 会话。`); return worker; }
}
function keyOf(node: AgentNodeSnapshot): string { return `${node.id}:${node.agentSessionId ?? ""}`; }
