import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { runsRoot } from "../journal/paths";
import { RunJournal } from "../journal/run-journal";
import { RUNTIME_VERSION, type JournalEvent, type RunManifest } from "../journal/types";
import type { JsonObject } from "../shared/json";
import type { WorkflowModule } from "../shared/workflow-types";
import { executeWorkflow } from "../workflow/execute-workflow";
import { RunRuntimeHost } from "./run-runtime-host";
import { RunStateMachine } from "./run-state-machine";
import type { AgentNodeExecutor, RunSnapshot } from "./run-types";
import { ControlServer } from "../control/control-server";

/** 创建一次耐久 Run 所需的公开配置。 */
export type CreateRunOptions = {
  /** 受信任、已加载的 Workflow 模块。 */
  readonly workflow: WorkflowModule<JsonObject, unknown>;
  /** 本次 Workflow JSON-safe 输入。 */
  readonly input: JsonObject;
  /** Workflow 主文件内容；用于生成本次 Manifest 的 hash。 */
  readonly workflowSource: string;
  /** CLI 创建请求的稳定 UUID；重试时必须保持不变。 */
  readonly clientRequestId: string;
  /** Workflow 所属项目目录；用于相对节点 cwd 解析。 */
  readonly workflowProjectCwd: string;
  /** realpath 后的 Workflow 文件。 */
  readonly workflowPath: string;
  /** 用户级 Run Store 根目录；仅供 daemon / 测试注入。 */
  readonly storeRoot?: string;
  /** 本章可控 Agent 执行器；不启动真实 CLI。 */
  readonly executor: AgentNodeExecutor;
};

/** 本章 Runtime 的创建、执行与查询入口。 */
export class RunRuntime {
  #stopping = false;
  #controlAbort: AbortController | null = null;
  #controlSettled: Promise<void> | null = null;
  #resolveControlSettled: (() => void) | null = null;
  private constructor(
    readonly journal: RunJournal,
    readonly state: RunStateMachine,
    private readonly host: RunRuntimeHost,
    private readonly replay = false,
  ) {}

  /** 创建 Manifest、Journal、状态机与 Host，尚不执行 Workflow。 */
  static async create(options: CreateRunOptions): Promise<RunRuntime> {
    const workflowProjectCwd = await realpath(options.workflowProjectCwd);
    const workflowPath = await realpath(options.workflowPath);
    const manifest: RunManifest = {
      runId: crypto.randomUUID(), clientRequestId: options.clientRequestId, runtimeVersion: RUNTIME_VERSION, workflow: options.workflow.meta,
      workflowHash: createHash("sha256").update(options.workflowSource).digest("hex"), workflowPath, workflowProjectCwd, input: options.input, createdAt: new Date().toISOString(),
    };
    const journal = await RunJournal.create(manifest, options.storeRoot ?? runsRoot());
    const state = new RunStateMachine(manifest);
    state.apply({ type: "run.created", at: manifest.createdAt, runId: manifest.runId, nodeId: null, agentSessionId: null, diagnostic: null, runStatus: "running" });
    const attempt = { type: "execution-attempt.started" as const, at: manifest.createdAt, runId: manifest.runId, nodeId: null, agentSessionId: null, diagnostic: null, executionAttemptId: 1 };
    await journal.append(attempt);
    state.apply(attempt);
    return new RunRuntime(journal, state, new RunRuntimeHost(journal, state, options.executor));
  }

  /** 打开已有 Run 并从已验证 Journal 事实重建 Phase → Agent 查询视图。 */
  static async open(runId: string, executor: AgentNodeExecutor, storeRoot = runsRoot()): Promise<RunRuntime> {
    const opened = await RunJournal.open(runId, storeRoot);
    const state = new RunStateMachine(opened.journal.manifest);
    for (const event of opened.events) state.apply(event);
    const sequence = maximumJournalSequence(opened.events);
    return new RunRuntime(opened.journal, state, new RunRuntimeHost(opened.journal, state, executor, sequence));
  }

  /**
   * 用户显式 resume 后，从 Workflow 起点重放调用轨迹。Host 以 sequence=0 开始逐项
   * 比对 Journal；只复用连续匹配的 completed 节点。
   */
  static async resume(runId: string, executor: AgentNodeExecutor, storeRoot = runsRoot()): Promise<RunRuntime> {
    const opened = await RunJournal.open(runId, storeRoot);
    if (opened.journal.manifest.runtimeVersion !== RUNTIME_VERSION) throw new Error(`resume 仅支持当前 Runtime v${RUNTIME_VERSION} 的 Run；历史 v${opened.journal.manifest.runtimeVersion} 只能读取。`);
    const state = new RunStateMachine(opened.journal.manifest);
    for (const event of opened.events) state.apply(event);
    if (state.snapshot().status !== "running") throw new Error("只有仍为 running 的 Run 可以 resume。");
    const historicalSequence = maximumJournalSequence(opened.events);
    return new RunRuntime(opened.journal, state, new RunRuntimeHost(opened.journal, state, executor, historicalSequence, true), true);
  }

  /** 执行 Workflow；完成后以 durable run.status 事实封存聚合状态。 */
  async run(workflow: WorkflowModule<JsonObject, unknown>): Promise<unknown> {
    try {
      const result = await executeWorkflow(workflow, this.journal.manifest.input, this.host, { cwd: this.journal.manifest.workflowProjectCwd });
      await this.host.flush();
      const nodes = this.state.snapshot().phases.flatMap((phase) => phase.agents);
      if (nodes.some((agent) => agent.status !== "completed")) throw new Error("Workflow 返回时仍有未完成 Agent 节点。");
      await this.transitionRun("completed", null);
      return result;
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      if (!this.replay && !this.#stopping && this.state.snapshot().status === "running") await this.transitionRun("interrupted", diagnostic);
      throw error;
    }
  }

  /** 返回当前不可变查询投影。 */
  snapshot(): RunSnapshot { return this.state.snapshot(); }

  /**
   * 等待首个真实节点会话已耐久记录、因全局资源护栏实际等待，或 Run 已终结。
   *
   * daemon 只能在这之后把 running Run 交还给 CLI，避免“任务尚未安全投递”就让用户
   * 误以为可关闭启动过程。多个后续节点仍在后台按 Workflow 正常调度。
   */
  async waitForSafeLaunch(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.state.snapshot().status === "running" && !this.state.hasRecordedSession() && !this.host.hasWaitingStart()) {
      if (Date.now() >= deadline) throw new Error("Run 未在时限内完成首个节点会话投递。");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** 供 daemon 在真实 Agent 启动前创建并注册 ControlServer；不对 Workflow 作者 API 暴露。 */
  controlContext(): { readonly journal: RunJournal; readonly state: RunStateMachine } { return this.host.controlContext(); }

  /** 为当前 Run 创建唯一 ControlServer；真实执行器须在节点启动前绑定它。 */
  createControlServer(): ControlServer {
    const context = this.controlContext();
    return new ControlServer(context.journal, context.state);
  }

  /** 用户暂停：先耐久 intent 并阻断新调度，再由 Executor 停止既有真实节点。 */
  async pause(): Promise<RunSnapshot> {
    if (this.state.snapshot().status !== "running") throw new Error("只有 running 的 Run 可以 pause。 ");
    await this.transitionRun("pausing", "用户请求暂停。 ");
    this.host.pauseScheduling();
    const control = this.beginControl();
    const targets = this.state.snapshot().phases.flatMap((phase) => phase.agents).filter((node) => node.status === "running" || node.status === "blocked");
    try {
      for (const node of targets) {
        await this.applyAgentStatus(node.id, "pausing", node.agentSessionId, "正在停止当前 Agent 回合与受管工具。 ");
        await this.host.pauseNode(this.state.agent(node.id), control.signal);
        await this.applyAgentStatus(node.id, "paused", node.agentSessionId, "当前回合和受管背景终端已停止。 ");
      }
      await this.transitionRun("paused", "用户暂停完成。 ");
      return this.snapshot();
    } catch (error) {
      if (this.#stopping && control.signal.aborted) throw error;
      const diagnostic = `暂停未确认：${error instanceof Error ? error.message : String(error)}`;
      for (const node of this.state.snapshot().phases.flatMap((phase) => phase.agents).filter((item) => item.status === "pausing")) {
        await this.applyAgentStatus(node.id, "interrupted", node.agentSessionId, diagnostic);
      }
      await this.transitionRun("interrupted", diagnostic);
      throw error;
    } finally { this.endControl(control); }
  }

  /** 用户恢复：同一会话创建新的继续回合，成功后才放开后续 Workflow 调度。 */
  async recover(): Promise<RunSnapshot> {
    if (this.state.snapshot().status !== "paused") throw new Error("只有 paused 的 Run 可以 recover。 ");
    await this.transitionRun("recovering", "用户请求恢复。 ");
    const control = this.beginControl();
    const targets = this.state.snapshot().phases.flatMap((phase) => phase.agents).filter((node) => node.status === "paused");
    try {
      for (const node of targets) {
        await this.applyAgentStatus(node.id, "recovering", node.agentSessionId, "正在同一会话创建继续回合。 ");
        const recovery = await this.host.recoverNode(this.state.agent(node.id), control.signal);
        if (recovery.appServer) {
          const event: JournalEvent = { type: "agent.recovered", at: new Date().toISOString(), runId: this.journal.manifest.runId, nodeId: node.id, agentSessionId: node.agentSessionId, diagnostic: "同一 thread 的恢复回合已确认。", appServer: recovery.appServer };
          await this.journal.append(event);
          this.state.apply(event);
        }
        const viewer = this.host.viewerSession(this.state.agent(node.id));
        if (viewer) {
          const event: JournalEvent = { type: "agent.viewer", at: new Date().toISOString(), runId: this.journal.manifest.runId, nodeId: node.id, agentSessionId: node.agentSessionId, diagnostic: "恢复后 viewer 已重建。", session: viewer };
          await this.journal.append(event);
          this.state.apply(event);
        }
        await this.applyAgentStatus(node.id, node.block ? "blocked" : "running", node.agentSessionId, node.block ? "恢复后继续等待原 block。" : "已在同一会话恢复。 ");
      }
      this.host.resumeScheduling();
      await this.transitionRun("running", "用户恢复完成。 ");
      return this.snapshot();
    } catch (error) {
      if (this.#stopping && control.signal.aborted) throw error;
      const diagnostic = `恢复未确认：${error instanceof Error ? error.message : String(error)}`;
      for (const node of this.state.snapshot().phases.flatMap((phase) => phase.agents).filter((item) => item.status === "recovering")) {
        await this.applyAgentStatus(node.id, "interrupted", node.agentSessionId, diagnostic);
      }
      await this.transitionRun("interrupted", diagnostic);
      throw error;
    } finally { this.endControl(control); }
  }

  /** 用户停止是终态；不允许后续 recover 或隐式重跑。 */
  async stop(): Promise<RunSnapshot> {
    const status = this.state.snapshot().status;
    if (status !== "running" && status !== "pausing" && status !== "paused" && status !== "recovering") throw new Error("只有运行中或暂停控制中的 Run 可以 stop。 ");
    this.host.pauseScheduling();
    this.#stopping = true;
    const activeControl = this.#controlAbort;
    activeControl?.abort();
    // pause/recover 可能正写入 agent/run 状态；先等待它因 abort 完成 finally 清理，
    // 再执行 stop，避免两个控制操作并发写状态机。
    if (activeControl && this.#controlSettled) await this.#controlSettled;
    const targets = this.state.snapshot().phases.flatMap((phase) => phase.agents).filter((node) => node.status === "running" || node.status === "blocked" || node.status === "pausing" || node.status === "paused" || node.status === "recovering");
    try {
      for (const node of targets) {
        this.host.beginStop(node.id);
        await this.host.stopNode(node);
        await this.applyAgentStatus(node.id, "cancelled", node.agentSessionId, "用户停止 Run。 ");
      }
      await this.transitionRun("cancelled", "用户停止 Run。 ");
      return this.snapshot();
    } catch (error) {
      const diagnostic = `停止未确认：${error instanceof Error ? error.message : String(error)}`;
      await this.transitionRun("interrupted", diagnostic);
      throw error;
    } finally {
      this.#stopping = false;
    }
  }

  /** daemon 在排队 stop 前立刻抢占 App Server 控制调用，避免等待其 15 秒超时。 */
  requestStop(): void {
    this.#stopping = true;
    this.#controlAbort?.abort();
  }

  /** pause/recover 各自拥有一个可被 stop 抢占的控制信号。 */
  private beginControl(): AbortController {
    if (this.#controlAbort) throw new Error("已有 Run 控制操作正在进行。 ");
    const controller = new AbortController();
    this.#controlAbort = controller;
    this.#controlSettled = new Promise<void>((resolve) => { this.#resolveControlSettled = resolve; });
    return controller;
  }

  private endControl(controller: AbortController): void {
    if (this.#controlAbort === controller) {
      this.#controlAbort = null;
      this.#resolveControlSettled?.();
      this.#resolveControlSettled = null;
      this.#controlSettled = null;
    }
  }

  private async applyAgentStatus(nodeId: string, status: import("./run-types").AgentNodeStatus, agentSessionId: string | null, diagnostic: string): Promise<void> {
    const event: JournalEvent = { type: "agent.status", at: new Date().toISOString(), runId: this.journal.manifest.runId, nodeId, agentSessionId, diagnostic, status };
    await this.journal.append(event);
    this.state.apply(event);
  }

  private async transitionRun(status: import("./run-types").RunStatus, diagnostic: string | null): Promise<void> {
    const event: JournalEvent = { type: "run.status", at: new Date().toISOString(), runId: this.journal.manifest.runId, nodeId: null, agentSessionId: null, diagnostic, status };
    await this.journal.append(event);
    this.state.apply(event);
  }
}

/** 当前尝试视图会隐藏旧分支；展示序号必须始终从整个 Journal 的历史最大值续写。 */
function maximumJournalSequence(events: readonly JournalEvent[]): number {
  return events.reduce((maximum, event) => event.type === "agent.created" ? Math.max(maximum, event.sequence) : maximum, 0);
}
