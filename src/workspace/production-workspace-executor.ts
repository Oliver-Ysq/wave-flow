import type * as acp from "@agentclientprotocol/sdk";
import { AcpSessionClient } from "../adapters/acp-session";
import type { ControlServer } from "../control/control-server";
import type { RunRuntime } from "../runtime/run-runtime";
import { AcpWorkerExecutor } from "../runtime/acp-worker-executor";
import { RuntimeAcpWorkerExecutor } from "../runtime/runtime-acp-worker-executor";
import type { AgentNodeSnapshot } from "../runtime/run-types";
import type { CliRuntimeRegistry } from "../runtimes/registry";
import { resolveWorkerLauncher, runtimeProvenance } from "../runtimes/worker-launcher-resolver";
import { WorkflowContractError } from "../workflow/errors";
import { validateExecutionWorkspaces, type ExecutionWorkspaceConfig } from "./execution-workspaces";
import { ownedAcpTransport } from "./managed-acp-transport";
import { WorkspaceManager } from "./workspace-manager";
import { WorkspaceExecutor } from "./workspace-executor";
import { WriterProcessGroups } from "./writer-process-group";

/** Engine受管Workspace路径；首次执行/恢复沿用冻结Git授权，不重新让主控生成配置。 */
export class ProductionWorkspaceExecutor {
  #delegate: WorkspaceExecutor | null = null;
  #runtime: RunRuntime | null = null;
  readonly #groups = new WriterProcessGroups();
  readonly config: ExecutionWorkspaceConfig;
  constructor(
    config: ExecutionWorkspaceConfig,
    private readonly stateRoot: string,
    private readonly engineInstanceId: string,
    private readonly runtimes: CliRuntimeRegistry,
    /** 单节点私有Control MCP，由Engine注册；scratch仅给受管writer。 */
    private readonly controlMcp: (identity: { runId: string; nodeId: string; agentSessionId: string; capability: string }, scratch?: string) => acp.McpServer,
    private readonly fallbackRuntimeId: string | null,
  ) { this.config = validateExecutionWorkspaces(config); }

  /** wireControl阶段先创建/复核受管worktree，完成后才允许Run后台执行。 */
  async bindRuntime(runtime: RunRuntime, control: ControlServer): Promise<void> {
    if (this.#runtime) throw new WorkflowContractError("受管Workspace执行器已接线。");
    if (runtime.journal.manifest.workflowProjectCwd !== this.config.authorization.repository) throw new WorkflowContractError("Git成果授权与Execution项目不一致。");
    this.#runtime = runtime;
    const manager = await WorkspaceManager.open(this.stateRoot, this.engineInstanceId);
    // 无论首次还是续作都先冻结本Execution的原授权与交接HEAD；重复调用幂等。
    if (!this.config.continuation) await manager.create(this.config.workspaceId, this.config.authorization);
    await manager.prepareExecution(runtime.journal.manifest.runId, this.config);
    const readOnly = new RuntimeAcpWorkerExecutor(this.runtimes, (identity, scratch) => this.controlMcp(identity, scratch), undefined, this.fallbackRuntimeId, `${this.stateRoot}/read-only-scratch`);
    const delegate = new WorkspaceExecutor(manager, runtime.journal.manifest.runId, this.config.workspaceId, readOnly, async (node, binding) => {
      const selected = node.request.assignedRuntimeId ? await this.runtimes.resolveWorkerById(node.request.assignedRuntimeId) : await this.runtimes.resolveWorker(node.cli);
      const launcher = resolveWorkerLauncher(selected);
      const transport = ownedAcpTransport({ groups: this.#groups, bindWriter: binding.bindWriter });
      // cwd用于工作分离，不是安全隔离；可信CLI沿用原生配置，业务状态仍由Control仲裁。
      const worker = new AcpWorkerExecutor(launcher, value => new AcpSessionClient(value, transport, "allow"), runtimeProvenance(selected), identity => this.controlMcp(identity, binding.scratch), undefined, true);
      return {
        bindWriter: binding.bindWriter,
        verifyExited: async lease => Boolean(lease.writerIdentity && this.#groups.hasExited(lease.writerIdentity)),
        bindControl: value => worker.bindControl(value),
        execute: actual => worker.execute(actual),
        finalizeCompleted: actual => worker.finalizeCompleted(actual),
        finalizePartial: actual => worker.finalizeCompleted(actual),
        pause: (actual, signal) => worker.pause(actual, signal),
        recover: (actual, signal) => worker.recover(actual, signal),
        stop: actual => worker.stop(actual),
      };
    }, async lease => Boolean(lease.writerIdentity && this.#groups.hasExited(lease.writerIdentity)));
    delegate.bindControl(control); this.#delegate = delegate;
  }

  execute(node: AgentNodeSnapshot) { return this.require().execute(node); }
  finalizeCompleted(node: AgentNodeSnapshot) { return this.require().finalizeCompleted(node); }
  finalizePartial(node: AgentNodeSnapshot) { return this.require().finalizePartial(node); }
  pause(node: AgentNodeSnapshot, signal?: AbortSignal) { return this.require().pause(node, signal); }
  recover(node: AgentNodeSnapshot, signal?: AbortSignal) { return this.require().recover(node, signal); }
  stop(node: AgentNodeSnapshot) { return this.require().stop(node); }
  /** Execution释放只清当前Engine会话资源；含租约的worktree绝不自动删除。 */
  close(): void { /* 保留本Engine的writer退出核验句柄供用户显式收尾；不重新派发。 */ }
  private require(): WorkspaceExecutor { if (!this.#delegate) throw new WorkflowContractError("受管Workspace尚未完成Engine接线。"); return this.#delegate; }
}
