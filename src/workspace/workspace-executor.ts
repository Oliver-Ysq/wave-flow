import type { AgentNodeExecutor, AgentNodeSnapshot, AgentRecovery } from "../runtime/run-types";
import type { JsonObject } from "../shared/json";
import type { ControlServer } from "../control/control-server";
import { WorkflowContractError } from "../workflow/errors";
import { WorkspaceManager, type WorkspaceLease, type WriterVerifier } from "./workspace-manager";
import { resolveIntegrationSources, type IntegrationCommitContext, type IntegrationSourceSelection } from "./integration-sources";
import { GitRepository } from "./git-repository";

/** Engine冻结的节点到受管workspace绑定；不是作者API，也不从prompt猜测依赖。 */
export type WorkspaceNodeBinding = {
  /** Run内稳定节点id。 */
  readonly nodeId: string;
  /** 已获授权、已由Manager创建的workspace UUID。 */
  readonly workspaceId: string;
  /** 集成节点冻结来源；普通write节点省略，不改变作者agent参数或业务input。 */
  readonly integrationSources?: IntegrationSourceSelection;
};

/** 能证明写边界和退出的真实节点执行器；普通ACP close不能充当该证明。 */
export type ManagedWriterExecutor = AgentNodeExecutor & {
  /** 实际启动进程时在任何业务投递前耐久绑定writer证明身份。 */
  readonly bindWriter: (identity: string) => Promise<void>;
  /** 真实进程组退出核验；不得按业务complete、cancelled或close推断。 */
  readonly verifyExited: WriterVerifier;
  /** 与普通真实执行器相同，仍只经原ControlServer完成业务。 */
  bindControl(control: ControlServer): void;
};

/** Runtime与WorkspaceManager间成果交接层；业务状态仍由原Control/Journal管理。 */
export class WorkspaceExecutor implements AgentNodeExecutor {
  #active = new Map<string, { lease: WorkspaceLease; writer: ManagedWriterExecutor }>();
  #control: ControlServer | null = null;
  constructor(
    private readonly manager: WorkspaceManager,
    /** 原Run身份，必须与Runtime manifest一致，由Engine提供。 */
    private readonly runId: string,
    /** 冻结的明确绑定；未绑定write节点fail closed。 */
    private readonly bindings: readonly WorkspaceNodeBinding[],
    /** 只读节点执行器；不使用写workspace租约。 */
    private readonly readOnly: AgentNodeExecutor,
    /** 已验证隔离启动器工厂，创建时尚不启动业务。 */
    private readonly createWriter: (node: AgentNodeSnapshot, binding: { readonly cwd: string; readonly scratch: string; readonly commonDirectory: string; readonly gitDirectory: string; readonly lease: WorkspaceLease; readonly bindWriter: (identity: string) => Promise<void>; readonly integrationCommits: readonly IntegrationCommitContext[] }) => Promise<ManagedWriterExecutor> | ManagedWriterExecutor,
    /** 原Engine证明不可用时的显式核查；缺省一律拒绝，不自动认领旧PID。 */
    private readonly verifyRecoveredWriter: WriterVerifier = async () => false,
    /** 原Runtime实时节点投影；集成时必填，默认空投影使来源fail closed。 */
    private readonly readRuntimeNodes: () => readonly AgentNodeSnapshot[] = () => [],
  ) {
    if (new Set(bindings.map(binding => binding.nodeId)).size !== bindings.length) throw new WorkflowContractError("节点workspace绑定重复。");
  }

  /** Engine在Runtime创建后绑定唯一Control；后续动态writer立即继承，不能自建完成通道。 */
  bindControl(control: ControlServer): void {
    if (this.#control) throw new WorkflowContractError("WorkspaceExecutor已绑定ControlServer。");
    this.#control = control;
    const candidate = this.readOnly as AgentNodeExecutor & { bindControl?: (value: ControlServer) => void };
    candidate.bindControl?.(control);
  }

  async execute(node: AgentNodeSnapshot): Promise<JsonObject | null> {
    if (node.sandbox !== "workspace-write") return this.readOnly.execute(node);
    const binding = this.binding(node);
    const workspace = await this.manager.inspect(binding.workspaceId);
    const integrationCommits = binding.integrationSources ? await resolveIntegrationSources({ runId: this.runId, integrationNode: node, nodes: this.readRuntimeNodes(), selection: binding.integrationSources, bindings: this.bindings, manager: this.manager, targetCommonDirectory: workspace.commonDirectory }) : [];
    const lease = await this.manager.acquire(binding.workspaceId, { runId: this.runId, nodeId: node.id, attempt: node.executionAttemptId }, integrationCommits.map(item => item.commit));
    let current = lease;
    const bindWriter = async (identity: string) => { current = await this.manager.bindWriter(current, identity); };
    let writer: ManagedWriterExecutor;
    try {
      const scratch = await this.manager.createScratch(lease.leaseId);
      writer = await this.createWriter(node, { cwd: workspace.cwd, scratch, commonDirectory: workspace.commonDirectory, gitDirectory: workspace.gitDirectory, lease, bindWriter, integrationCommits });
      if (!this.#control) throw new WorkflowContractError("WorkspaceExecutor尚未绑定ControlServer。");
      writer.bindControl(this.#control);
    }
    catch (error) { await this.manager.abandonUnstarted(lease); throw error; }
    const active = { get lease() { return current; }, writer };
    this.#active.set(node.id, active);
    try {
      const result = await writer.execute({ ...node, cwd: workspace.cwd, request: { ...node.request, cwd: workspace.cwd } });
      if (!current.writerIdentity) throw new WorkflowContractError("写执行器未耐久绑定真实writer身份，拒绝交接。");
      return result;
    } catch (error) {
      if (!current.writerIdentity) { await this.manager.abandonUnstarted(current); this.#active.delete(node.id); }
      // 已启动writer失败保留现场/租约，停止不自动生成partial commit。
      throw error;
    }
  }

  /** 原completed节点正常收尾或resume补保存；不调用execute、不改变结果JSON。 */
  async finalizeCompleted(node: AgentNodeSnapshot): Promise<void> {
    if (node.sandbox !== "workspace-write") { await this.readOnly.finalizeCompleted?.(node); return; }
    const binding = this.binding(node), workspace = await this.manager.inspect(binding.workspaceId);
    const existing = workspace.results.find(result => result.runId === this.runId && result.nodeId === node.id && result.attempt === node.executionAttemptId && result.ready);
    if (existing) {
      const allowed=this.manager.authorizationFor(workspace,this.runId).nodes.find(item=>item.nodeId===node.id);
      if(!allowed)throw new WorkflowContractError("已保存成果缺少原提交授权。");
      const repo=await GitRepository.open(workspace.cleanedAt?workspace.authorization.repository:workspace.cwd);
      if(repo.commonDirectory!==workspace.commonDirectory)throw new WorkflowContractError("成果仓库身份漂移。");
      await repo.verifyCommitObject(existing.commit,existing.startCommit,existing.paths);
      if(!workspace.cleanedAt){
        const latest=workspace.results.at(-1),state=await repo.inspect();
        if(workspace.lease||!latest?.ready||state.head!==latest.commit||state.changedPaths.length||state.conflicts.length)throw new WorkflowContractError("持续worktree现场漂移或尚未交接，拒绝复用旧成果。");
      }
      return;
    }
    const active = this.#active.get(node.id), lease = active?.lease ?? workspace.lease;
    if (!lease || lease.runId !== this.runId || lease.nodeId !== node.id || lease.attempt !== node.executionAttemptId) throw new WorkflowContractError("completed节点缺少对应Git成果租约，不能只复用JSON。");
    try {
      await active?.writer.finalizeCompleted?.(node);
      await this.manager.finish(lease, true, active?.writer.verifyExited ?? this.verifyRecoveredWriter);
    } catch (error) {
      // IO/Adapter错误也属于宿主交接失败，不能被parallel/pipeline按普通业务错误吞为null。
      if (error instanceof WorkflowContractError) throw error;
      throw new WorkflowContractError(`Git成果交接失败：${error instanceof Error ? error.message : String(error)}`);
    }
    this.#active.delete(node.id);
  }

  /** 普通stop后保存partial；不要求业务complete，不允许下游/集成当ready使用。 */
  async finalizePartial(node: AgentNodeSnapshot): Promise<void> {
    if (node.sandbox !== "workspace-write") { await this.readOnly.finalizePartial?.(node); return; }
    const binding=this.binding(node),workspace=await this.manager.inspect(binding.workspaceId),active=this.#active.get(node.id),lease=active?.lease??workspace.lease;
    if(!lease||lease.runId!==this.runId||lease.nodeId!==node.id||lease.attempt!==node.executionAttemptId)return;
    try {
      await active?.writer.finalizePartial?.(node);
      await this.manager.finish(lease,false,active?.writer.verifyExited??this.verifyRecoveredWriter);
      this.#active.delete(node.id);
    } catch (error) { throw new WorkflowContractError(`停止现场保存失败，租约与现场保留：${error instanceof Error?error.message:String(error)}`); }
  }

  async pause(node: AgentNodeSnapshot, signal?: AbortSignal): Promise<void> { const delegate = this.delegate(node); if (!delegate.pause) throw new WorkflowContractError("执行器不支持pause。"); await delegate.pause(node, signal); }
  async recover(node: AgentNodeSnapshot, signal?: AbortSignal): Promise<AgentRecovery> { const delegate = this.delegate(node); if (!delegate.recover) throw new WorkflowContractError("执行器不支持recover。"); return delegate.recover(node, signal); }
  async stop(node: AgentNodeSnapshot): Promise<void> { const delegate = this.delegate(node); if (!delegate.stop) throw new WorkflowContractError("执行器不支持stop。"); await delegate.stop(node); }
  private delegate(node: AgentNodeSnapshot): AgentNodeExecutor { if (node.sandbox !== "workspace-write") return this.readOnly; const active = this.#active.get(node.id); if (!active) throw new WorkflowContractError("写节点没有当前Engine可控制的执行器。"); return active.writer; }
  private binding(node: AgentNodeSnapshot): WorkspaceNodeBinding { const binding = this.bindings.find(item => item.nodeId === node.id); if (!binding) throw new WorkflowContractError("写节点未绑定明确授权的受管workspace。"); return binding; }
}
