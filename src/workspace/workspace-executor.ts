import { rm } from "node:fs/promises";
import type { AgentNodeExecutor, AgentNodeSnapshot, AgentRecovery } from "../runtime/run-types";
import type { JsonObject } from "../shared/json";
import type { ControlServer } from "../control/control-server";
import { WorkflowContractError } from "../workflow/errors";
import type { WorkspaceManager } from "./workspace-manager";

/** 能证明写边界与退出的真实节点执行器；普通ACP close不能充当该证明。 */
export type ManagedWriterExecutor = AgentNodeExecutor & {
  bindControl(control: ControlServer): void;
};

/**
 * Runtime与WorkspaceManager间成果交接层；业务状态仍由原Control/Journal管理。
 *
 * 一次Execution只有一个共享worktree：并行写节点直接写同一目录。写者进程证据
 * （pgid、启动指纹、spawn 意图）只记录在 Run Journal；清理与 Execution 交接前
 * 由 Engine 统一做围栏证明。
 */
export class WorkspaceExecutor implements AgentNodeExecutor {
  #active = new Map<string, { node: AgentNodeSnapshot; writer: ManagedWriterExecutor; scratch: string }>();
  /** 已收到 stop 但尚未登记的写节点：execute 在每个启动关口复核。执行器按 Execution attempt 一次性创建，不在同一实例内复用已停止节点。 */
  #startupStops = new Set<string>();
  #control: ControlServer | null = null;
  #recoveryHold: ((nodeId: string) => Promise<void>) | null = null;
  constructor(
    private readonly manager: WorkspaceManager,
    /** 原Run身份，必须与Runtime manifest一致，由Engine提供。 */
    private readonly runId: string,
    /** 本Execution唯一共享worktree；所有写节点共用。 */
    private readonly workspaceId: string,
    /** 只读节点执行器；不使用写workspace。 */
    private readonly readOnly: AgentNodeExecutor,
    /** 已验证隔离启动器工厂，创建时尚不启动业务。 */
    private readonly createWriter: (node: AgentNodeSnapshot, binding: {
      readonly cwd: string;
      readonly scratch: string;
      readonly commonDirectory: string;
      readonly gitDirectory: string;
    }) => Promise<ManagedWriterExecutor> | ManagedWriterExecutor,
  ) {}

  /** Engine在Runtime创建后绑定唯一Control；后续动态writer立即继承，不能自建完成通道。 */
  bindControl(control: ControlServer): void {
    if (this.#control) throw new WorkflowContractError("WorkspaceExecutor已绑定ControlServer。");
    this.#control = control;
    const candidate = this.readOnly as AgentNodeExecutor & { bindControl?: (value: ControlServer) => void };
    candidate.bindControl?.(control);
  }

  bindRecoveryHold(handler: (nodeId: string) => Promise<void>): void {
    if (this.#recoveryHold) throw new WorkflowContractError("WorkspaceExecutor已绑定恢复暂停。");
    this.#recoveryHold = handler;
    this.readOnly.bindRecoveryHold?.(handler);
    for (const active of this.#active.values()) active.writer.bindRecoveryHold?.(handler);
  }

  async execute(node: AgentNodeSnapshot): Promise<JsonObject | null> {
    if (node.sandbox !== "workspace-write") {
      // 写Execution的所有节点共享同一worktree；只读复核必须看到未提交改动。
      const workspace = await this.manager.inspect(this.workspaceId);
      return this.readOnly.execute({ ...node, cwd: workspace.cwd, request: { ...node.request, cwd: workspace.cwd } });
    }
    this.#assertStartupNotStopped(node);
    const workspace = await this.manager.inspect(this.workspaceId);
    // 授权、清理状态、冲突与交接 HEAD 门禁。
    await this.manager.assertWriterAllowed(this.workspaceId, this.runId, node.id);
    this.#assertStartupNotStopped(node);
    const scratch = await this.manager.createScratch(`${node.id}:${node.executionAttemptId ?? 0}`);
    const writer = await this.createWriter(node, {
      cwd: workspace.cwd,
      scratch,
      commonDirectory: workspace.commonDirectory,
      gitDirectory: workspace.gitDirectory,
    });
    if (!this.#control) throw new WorkflowContractError("WorkspaceExecutor尚未绑定ControlServer。");
    writer.bindControl(this.#control);
    if (this.#recoveryHold) writer.bindRecoveryHold?.(this.#recoveryHold);
    this.#active.set(node.id, { node, writer, scratch });
    // stop 在初始化最后窗口到达：writer 尚未投递业务，关闭后拒绝启动。
    if (this.#startupStops.has(node.id)) {
      this.#active.delete(node.id);
      try {
        await writer.stop?.(node);
        // 只有 writer 确认关闭后才删除 scratch；失败时保留现场给恢复核验。
        await removeScratch(scratch);
      } catch { /* 保留现场。 */ }
      throw new WorkflowContractError("节点已停止，不再投递业务。");
    }
    try {
      const result = await writer.execute({ ...node, cwd: workspace.cwd, request: { ...node.request, cwd: workspace.cwd } });
      // 节点结束前必须完成 writer 退出核验；未核验不得交接。
      if (writer.finalizeCompleted) await writer.finalizeCompleted(node);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const startupFailure = message.includes("ACP Worker 启动超时")
        && !(node.agentSessionId && this.#control?.hasRecordedNodeSession(node.id, node.agentSessionId));
      if (startupFailure) {
        // 启动超时发生在任务投递前，未产生业务副作用；必须等 writer 退出核验后再允许重试。
        try {
          if (writer.finalizePartial) await writer.finalizePartial(node);
          else await writer.stop?.(node);
          this.#active.delete(node.id);
          await removeScratch(scratch);
        } catch {
          // 不复用“启动超时”错误文本：RunRuntimeHost 只对可安全重试的启动失败自动重试。
          throw new Error("启动失败后旧写入进程尚未确认退出，已保留现场；请稍后重试。");
        }
      }
      // 已启动 writer 失败保留现场；停止不自动回滚共享 worktree 中其他节点的改动。
      throw error;
    }
  }

  /** 节点completed后做 writer 退出核验；不产生逐节点 commit，也不收集成果快照。 */
  async finalizeCompleted(node: AgentNodeSnapshot): Promise<void> {
    if (node.sandbox !== "workspace-write") { await this.readOnly.finalizeCompleted?.(node); return; }
    const active = this.#active.get(node.id);
    if (!active || active.node.executionAttemptId !== node.executionAttemptId) return;
    try {
      await active.writer.finalizeCompleted?.(node);
    } catch (error) {
      if (error instanceof WorkflowContractError) throw error;
      throw new WorkflowContractError(`writer交接失败：${error instanceof Error ? error.message : String(error)}`);
    }
    this.#active.delete(node.id);
    await removeScratch(active.scratch);
  }

  /** 用户stop后核验 writer 退出；共享worktree中的改动保留。 */
  async finalizePartial(node: AgentNodeSnapshot): Promise<void> {
    if (node.sandbox !== "workspace-write") { await this.readOnly.finalizePartial?.(node); return; }
    const active = this.#active.get(node.id);
    if (!active || active.node.executionAttemptId !== node.executionAttemptId) return;
    try {
      await active.writer.finalizePartial?.(node);
    } catch (error) { throw new WorkflowContractError(`停止现场交接失败，现场保留：${error instanceof Error ? error.message : String(error)}`); }
    this.#active.delete(node.id);
    await removeScratch(active.scratch);
  }

  /** interrupted 节点清理 writer 退出核验引用；核验仍由 finalize 负责。 */
  discard(node: AgentNodeSnapshot): void {
    if (node.sandbox !== "workspace-write") { this.readOnly.discard?.(node); return; }
    const active = this.#active.get(node.id);
    active?.writer.discard?.(node);
    // 节点已中断、会话已关闭：scratch 不再被使用；删除失败不影响业务状态。
    if (active) void removeScratch(active.scratch);
  }

  async pause(node: AgentNodeSnapshot, signal?: AbortSignal): Promise<void> { const delegate = this.delegate(node); if (!delegate.pause) throw new WorkflowContractError("执行器不支持pause。"); await delegate.pause(node, signal); }
  async recover(node: AgentNodeSnapshot, signal?: AbortSignal): Promise<AgentRecovery> { const delegate = this.delegate(node); if (!delegate.recover) throw new WorkflowContractError("执行器不支持recover。"); return delegate.recover(node, signal); }
  async stop(node: AgentNodeSnapshot): Promise<void> {
    if (node.sandbox !== "workspace-write") { if (!this.readOnly.stop) throw new WorkflowContractError("执行器不支持stop。"); await this.readOnly.stop(node); return; }
    // 先登记停止意图：尚未 active 的写节点不误报“没有执行器”；execute 的各关口复核此意图。
    this.#startupStops.add(node.id);
    const active = this.#active.get(node.id);
    if (!active) return;
    if (!active.writer.stop) throw new WorkflowContractError("执行器不支持stop。");
    await active.writer.stop(node);
  }

  /** execute 启动关口：命中停止意图即拒绝。 */
  #assertStartupNotStopped(node: AgentNodeSnapshot): void {
    if (this.#startupStops.has(node.id)) throw new WorkflowContractError("节点已停止，不再启动 writer 或投递业务。");
  }
  private delegate(node: AgentNodeSnapshot): AgentNodeExecutor { if (node.sandbox !== "workspace-write") return this.readOnly; const active = this.#active.get(node.id); if (!active) throw new WorkflowContractError("写节点没有当前Engine可控制的执行器。"); return active.writer; }
}

/** 删除节点私有 scratch；只清理本执行器创建的目录，失败不影响业务事实。 */
async function removeScratch(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => { /* 目录可能已被清理。 */ });
}
