import type { AgentNodeExecutor, AgentNodeSnapshot, AgentRecovery } from "../runtime/run-types";
import type { JsonObject } from "../shared/json";
import type { ControlServer } from "../control/control-server";
import { WorkflowContractError } from "../workflow/errors";
import { WorkspaceManager, type WorkspaceLease, type WriterVerifier } from "./workspace-manager";

/** 能证明写边界和退出的真实节点执行器；普通ACP close不能充当该证明。 */
export type ManagedWriterExecutor = AgentNodeExecutor & {
  /** 实际启动进程时在任何业务投递前耐久绑定writer证明身份。 */
  readonly bindWriter: (identity: string) => Promise<void>;
  /** 真实进程组退出核验；不得按业务complete、cancelled或close推断。 */
  readonly verifyExited: WriterVerifier;
  /** 与普通真实执行器相同，仍只经原ControlServer完成业务。 */
  bindControl(control: ControlServer): void;
};

/**
 * Runtime与WorkspaceManager间成果交接层；业务状态仍由原Control/Journal管理。
 * 一次Execution只有一个共享worktree：并行写节点同时持有租约、直接写同一目录，
 * 节点结束只释放自己的租约；最终封存与自动应用由Execution收尾统一完成。
 */
export class WorkspaceExecutor implements AgentNodeExecutor {
  #active = new Map<string, { lease: WorkspaceLease; writer: ManagedWriterExecutor }>();
  #control: ControlServer | null = null;
  constructor(
    private readonly manager: WorkspaceManager,
    /** 原Run身份，必须与Runtime manifest一致，由Engine提供。 */
    private readonly runId: string,
    /** 本Execution唯一共享worktree；所有写节点共用。 */
    private readonly workspaceId: string,
    /** 只读节点执行器；不使用写workspace租约。 */
    private readonly readOnly: AgentNodeExecutor,
    /** 已验证隔离启动器工厂，创建时尚不启动业务。 */
    private readonly createWriter: (node: AgentNodeSnapshot, binding: { readonly cwd: string; readonly scratch: string; readonly commonDirectory: string; readonly gitDirectory: string; readonly lease: WorkspaceLease; readonly bindWriter: (identity: string) => Promise<void> }) => Promise<ManagedWriterExecutor> | ManagedWriterExecutor,
    /** 原Engine证明不可用时的显式核查；缺省一律拒绝，不自动认领旧PID。 */
    private readonly verifyRecoveredWriter: WriterVerifier = async () => false,
  ) {}

  /** Engine在Runtime创建后绑定唯一Control；后续动态writer立即继承，不能自建完成通道。 */
  bindControl(control: ControlServer): void {
    if (this.#control) throw new WorkflowContractError("WorkspaceExecutor已绑定ControlServer。");
    this.#control = control;
    const candidate = this.readOnly as AgentNodeExecutor & { bindControl?: (value: ControlServer) => void };
    candidate.bindControl?.(control);
  }

  async execute(node: AgentNodeSnapshot): Promise<JsonObject | null> {
    if (node.sandbox !== "workspace-write") {
      // 写Execution的所有节点共享同一worktree；只读复核必须看到未提交改动，而不是主项目目录。
      const workspace = await this.manager.inspect(this.workspaceId);
      return this.readOnly.execute({ ...node, cwd: workspace.cwd, request: { ...node.request, cwd: workspace.cwd } });
    }
    const workspace = await this.manager.inspect(this.workspaceId);
    const lease = await this.manager.acquire(this.workspaceId, { runId: this.runId, nodeId: node.id, attempt: node.executionAttemptId });
    let current = lease;
    const bindWriter = async (identity: string) => { current = await this.manager.bindWriter(current, identity); };
    let writer: ManagedWriterExecutor;
    try {
      const scratch = await this.manager.createScratch(lease.leaseId);
      writer = await this.createWriter(node, { cwd: workspace.cwd, scratch, commonDirectory: workspace.commonDirectory, gitDirectory: workspace.gitDirectory, lease, bindWriter });
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
      // 已启动writer失败保留现场/租约；停止不自动回滚共享worktree中其他节点的改动。
      throw error;
    }
  }

  /** 节点completed后释放自己的租约；成果由Execution收尾统一封存，不产生逐节点commit。 */
  async finalizeCompleted(node: AgentNodeSnapshot): Promise<void> {
    if (node.sandbox !== "workspace-write") { await this.readOnly.finalizeCompleted?.(node); return; }
    const active = this.#active.get(node.id), lease = active?.lease;
    if (!lease || lease.runId !== this.runId || lease.nodeId !== node.id || lease.attempt !== node.executionAttemptId) {
      // Replay不重新执行writer：共享worktree没有逐节点成果可核验，交由Execution收尾。
      // 不匹配时不得删除表中entry：它可能属于同节点的新attempt，误删会丢失活跃writer的控制句柄。
      return;
    }
    try {
      await active?.writer.finalizeCompleted?.(node);
      await this.manager.release(lease, active?.writer.verifyExited ?? this.verifyRecoveredWriter);
    } catch (error) {
      // IO/Adapter错误也属于宿主交接失败，不能被parallel/pipeline按普通业务错误吞为null。
      if (error instanceof WorkflowContractError) throw error;
      throw new WorkflowContractError(`writer交接失败：${error instanceof Error ? error.message : String(error)}`);
    }
    this.#active.delete(node.id);
  }

  /** 用户stop后释放租约；共享worktree中的改动保留，不生成partial commit。 */
  async finalizePartial(node: AgentNodeSnapshot): Promise<void> {
    if (node.sandbox !== "workspace-write") { await this.readOnly.finalizePartial?.(node); return; }
    const active = this.#active.get(node.id), lease = active?.lease;
    if (!lease || lease.runId !== this.runId || lease.nodeId !== node.id || lease.attempt !== node.executionAttemptId) { return; }
    try {
      await active?.writer.finalizePartial?.(node);
      await this.manager.release(lease, active?.writer.verifyExited ?? this.verifyRecoveredWriter);
      this.#active.delete(node.id);
    } catch (error) { throw new WorkflowContractError(`停止现场交接失败，租约与现场保留：${error instanceof Error ? error.message : String(error)}`); }
  }

  async pause(node: AgentNodeSnapshot, signal?: AbortSignal): Promise<void> { const delegate = this.delegate(node); if (!delegate.pause) throw new WorkflowContractError("执行器不支持pause。"); await delegate.pause(node, signal); }
  async recover(node: AgentNodeSnapshot, signal?: AbortSignal): Promise<AgentRecovery> { const delegate = this.delegate(node); if (!delegate.recover) throw new WorkflowContractError("执行器不支持recover。"); return delegate.recover(node, signal); }
  async stop(node: AgentNodeSnapshot): Promise<void> { const delegate = this.delegate(node); if (!delegate.stop) throw new WorkflowContractError("执行器不支持stop。"); await delegate.stop(node); }
  private delegate(node: AgentNodeSnapshot): AgentNodeExecutor { if (node.sandbox !== "workspace-write") return this.readOnly; const active = this.#active.get(node.id); if (!active) throw new WorkflowContractError("写节点没有当前Engine可控制的执行器。"); return active.writer; }
}
