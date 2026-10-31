import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runsRoot } from "../journal/paths";
import { RunJournal } from "../journal/run-journal";
import { RUNTIME_VERSION, type JournalEvent, type RunManifest } from "../journal/types";
import type { JsonObject } from "../shared/json";
import type { WorkflowModule } from "../shared/workflow-types";
import { executeWorkflow } from "../workflow/execute-workflow";
import { PolicyEnforcingHost } from "./policy-host";
import { RunRuntimeHost } from "./run-runtime-host";
import { readSkillLibraryDigest } from "../skills/library";
import { RunStateMachine } from "./run-state-machine";
import type { AgentNodeExecutor, RunSnapshot } from "./run-types";
import { ControlServer } from "../control/control-server";
import { canRunTransition, canTransition } from "./run-state-machine";

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
  /** 用户级 Run Store 根目录；仅供 Engine / 测试注入。 */
  readonly storeRoot?: string;
  /** 本章可控 Agent 执行器；不启动真实 CLI。 */
  readonly executor: AgentNodeExecutor;
  /** Lead 原生 Execution 的来源绑定；受信任作者入口省略。 */
  readonly lead?: import("../journal/types").RunLeadOrigin;
  /** 固定 Run id；仅 Lead Execution 用来让登记 id 与内嵌 Journal runId 一致，省略时生成随机 UUID。 */
  readonly runId?: string;
  /** 历史 assigned 执行配置；模块 Workflow 省略，节点 cli/model 由作者源码直接决定。 */
  readonly executionConfig?: import("../lead/types").ExecutionConfigSnapshot;
};

/** RunRuntime.run 的可选执行约束。 */
export type RunExecutionOptions = {
  /** 生成模块 Execution 的资源护栏；本地来源 Run 省略。提供时以 PolicyEnforcingHost 包装内部宿主。 */
  readonly policy?: import("./policy-host").WorkflowPolicy;
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
  ) {}

  /** 创建 Manifest、Journal、状态机与 Host，尚不执行 Workflow。 */
  static async create(options: CreateRunOptions): Promise<RunRuntime> {
    const workflowProjectCwd = await realpath(options.workflowProjectCwd);
    const workflowPath = await realpath(options.workflowPath);
    const manifest: RunManifest = {
      runId: options.runId ?? crypto.randomUUID(), clientRequestId: options.clientRequestId, runtimeVersion: RUNTIME_VERSION, workflow: options.workflow.meta,
      workflowHash: createHash("sha256").update(options.workflowSource).digest("hex"), workflowPath, workflowProjectCwd, input: options.input, lead: options.lead, createdAt: new Date().toISOString(),
    };
    const journal = await RunJournal.create(manifest, options.storeRoot ?? runsRoot());
    const state = new RunStateMachine(manifest);
    state.apply({ type: "run.created", at: manifest.createdAt, runId: manifest.runId, nodeId: null, agentSessionId: null, diagnostic: null, runStatus: "running" });
    const attempt = { type: "execution-attempt.started" as const, at: manifest.createdAt, runId: manifest.runId, nodeId: null, agentSessionId: null, diagnostic: null, executionAttemptId: 1 };
    await journal.append(attempt);
    state.apply(attempt);
    return new RunRuntime(journal, state, new RunRuntimeHost(journal, state, options.executor, 0, false, false, options.executionConfig ?? null));
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
  static async resume(runId: string, executor: AgentNodeExecutor, storeRoot = runsRoot(), executionConfig: import("../lead/types").ExecutionConfigSnapshot | null = null, skillsRoot?: string): Promise<RunRuntime> {
    // 技能库非法时拒绝恢复，避免用残缺技能环境重跑；空库返回 null，维持旧行为。
    const skillsDigest = await readSkillLibraryDigest(skillsRoot ?? join(dirname(storeRoot), "skills"));
    const opened = await RunJournal.open(runId, storeRoot);
    if (opened.journal.manifest.runtimeVersion !== RUNTIME_VERSION) throw new Error(`resume 仅支持当前 Runtime v${RUNTIME_VERSION} 的 Run；历史 v${opened.journal.manifest.runtimeVersion} 只能读取。`);
    const state = new RunStateMachine(opened.journal.manifest);
    for (const event of opened.events) state.apply(event);
    const priorStatus = state.snapshot().status;
    if (priorStatus !== "running" && priorStatus !== "interrupted" && priorStatus !== "cancelled") throw new Error("只有 running、interrupted 或 cancelled 的 Run 可以 resume。");
    const historicalSequence = maximumJournalSequence(opened.events);
    const resumeInterrupted = priorStatus === "interrupted" || priorStatus === "cancelled";
    return new RunRuntime(opened.journal, state, new RunRuntimeHost(
      opened.journal,
      state,
      executor,
      historicalSequence,
      true,
      resumeInterrupted,
      executionConfig,
      skillsDigest,
    ));
  }

  /** 执行 Workflow；完成后以 durable run.status 事实封存聚合状态。options.policy 用于生成模块的资源护栏。 */
  async run(workflow: WorkflowModule<JsonObject, unknown>, options: RunExecutionOptions = {}): Promise<unknown> {
    const host: import("./workflow-host").WorkflowExecutionHost = options.policy ? new PolicyEnforcingHost(this.host, options.policy) : this.host;
    try {
      const result = await executeWorkflow(workflow, this.journal.manifest.input, host, { cwd: this.journal.manifest.workflowProjectCwd });
      await this.host.flush();
      const nodes = this.state.snapshot().phases.flatMap((phase) => phase.agents);
      if (nodes.some((agent) => agent.status !== "completed")) throw new Error("Workflow 返回时仍有未完成 Agent 节点。");
      await this.transitionRun("completed", null);
      return result;
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      // replay 在首个重跑节点前被拒绝时 Run 仍是旧终态（interrupted/cancelled 不能
      // 再写 interrupted），由 status === "running" 守卫天然跳过；一旦新 attempt 已
      // 开始（Run 已回 running），失败必须同样封存终态，否则残留"running Run +
      // interrupted 节点"的损坏投影，下一次 resume 与启动收敛都会被误导。
      // Journal fail closed 时封存写入必然失败；绝不因此吞掉上方的首个失败。
      if (!this.#stopping && this.state.snapshot().status === "running") {
        try { await this.transitionRun("interrupted", diagnostic); } catch { /* Journal 已 fail closed，保留原始错误。 */ }
      }
      throw error;
    }
  }

  /** 返回当前不可变查询投影。 */
  snapshot(): RunSnapshot { return this.state.snapshot(); }

  /**
   * 等待首个真实节点会话已耐久记录、因全局资源护栏实际等待，或 Run 已终结。
   *
   * Engine 只能在这之后把 running Run 交还给 CLI，避免“任务尚未安全投递”就让用户
   * 误以为可关闭启动过程。多个后续节点仍在后台按 Workflow 正常调度。
   */
  async waitForSafeLaunch(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.state.snapshot().status === "running" && !this.state.hasRecordedSession() && !this.host.hasWaitingStart()) {
      if (Date.now() >= deadline) throw new Error("Run 未在时限内完成首个节点会话投递。");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** 供 Engine 在真实 Agent 启动前创建并注册 ControlServer；不对 Workflow 作者 API 暴露。 */
  controlContext(): { readonly journal: RunJournal; readonly state: RunStateMachine; readonly exclusive: <T>(operation: () => Promise<T>) => Promise<T> } { return this.host.controlContext(); }

  /** 启动/恢复收敛的耐久写入；与 Worker/控制路径共用同一互斥区与可重放核验。 */
  async commitConvergence(event: JournalEvent): Promise<void> { await this.host.commitEvent(event); }

  /** 用户对脚本决策门提交答案；Schema 校验通过并耐久后才唤醒等待中的脚本。 */
  answerGate(gateId: string, answer: JsonObject): Promise<void> { return this.host.answerGate(gateId, answer); }

  /** 为当前 Run 创建唯一 ControlServer；真实执行器须在节点启动前绑定它。 */
  createControlServer(): ControlServer {
    const context = this.controlContext();
    return new ControlServer(context.journal, context.state, context.exclusive);
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
      await this.interruptControlWorkers(diagnostic);
      await this.transitionRunIfLive("interrupted", diagnostic);
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
        if (recovery.acp) {
          const event: JournalEvent = { type: "agent.recovered", at: new Date().toISOString(), runId: this.journal.manifest.runId, nodeId: node.id, agentSessionId: node.agentSessionId, diagnostic: "同一 ACP session 的恢复回合已启动。", acp: recovery.acp };
          await this.host.commitEvent(event);
        }
        await this.applyAgentStatus(node.id, node.block ? "blocked" : "running", node.agentSessionId, node.block ? "恢复后继续等待原 block。" : "已在同一会话恢复。 ");
      }
      this.host.resumeScheduling();
      await this.transitionRun("running", "用户恢复完成。 ");
      return this.snapshot();
    } catch (error) {
      if (this.#stopping && control.signal.aborted) throw error;
      const diagnostic = `恢复未确认：${error instanceof Error ? error.message : String(error)}`;
      await this.interruptControlWorkers(diagnostic);
      await this.transitionRunIfLive("interrupted", diagnostic);
      throw error;
    } finally { this.endControl(control); }
  }

  /** 控制部分失败使整个Run无法继续；先耐久收敛全部活跃节点，再尽力释放原会话。 */
  private async interruptControlWorkers(diagnostic: string): Promise<void> {
    this.host.pauseScheduling();
    for (const node of this.state.snapshot().phases.flatMap(phase => phase.agents)) {
      if (!await this.applyAgentStatusIfLive(node.id, "interrupted", node.agentSessionId, diagnostic)) continue;
      // 已成功暂停/恢复的其他会话也须释放；底层清理不响应不能阻塞本地终态落盘。
      void this.host.stopNode(node).catch(() => undefined);
    }
  }

  /** 用户停止是终态；不允许后续 recover 或隐式重跑。 */
  async stop(): Promise<RunSnapshot> {
    const status = this.state.snapshot().status;
    if (status !== "running" && status !== "pausing" && status !== "paused" && status !== "recovering") throw new Error("只有运行中或暂停控制中的 Run 可以 stop。 ");
    this.host.pauseScheduling();
    // 撤销仍在等名额/调度闸门的 queued 节点的启动许可：它们必须在复核处失败并
    // 归还名额，绝不能在 stop 释放名额后启动真实 Worker。
    this.host.abortQueuedStarts();
    this.#stopping = true;
    // 等待用户答案的决策门不属于任何节点；stop 必须主动拒绝它们，Workflow 调用栈才能退出。
    this.host.rejectPendingGates("用户停止 Run，决策门不再等待答案。 ");
    const activeControl = this.#controlAbort;
    activeControl?.abort();
    // pause/recover 可能正写入 agent/run 状态；先等待它因 abort 完成 finally 清理，
    // 再执行 stop，避免两个控制操作并发写状态机。
    if (activeControl && this.#controlSettled) await this.#controlSettled;
    const targets = this.state.snapshot().phases.flatMap((phase) => phase.agents).filter((node) => node.status === "queued" || node.status === "running" || node.status === "blocked" || node.status === "pausing" || node.status === "paused" || node.status === "recovering");
    let stopError: Error | undefined;
    try {
      for (const node of targets) {
        // 节点可能在停止期间自行 complete（Worker 控制 socket 与 IPC 是两条通道）；
        // 已终态的节点保持其已完成证据，不再落 cancelled。
        if (!canTransition(this.state.agent(node.id).status, "cancelled")) continue;
        this.host.beginStop(node.id);
        try {
          // queued 节点从未进入执行器，没有真实会话可停；直接耐久 cancelled。
          if (this.state.agent(node.id).status === "queued") {
            await this.applyAgentStatusIfLive(node.id, "cancelled", node.agentSessionId, "用户停止 Run。 ");
            continue;
          }
          try { await this.host.stopNode(node); }
          catch (error) {
            stopError ??= error instanceof Error ? error : new Error(String(error));
            const diagnostic = `停止未确认：${error instanceof Error ? error.message : String(error)}`;
            await this.applyAgentStatusIfLive(node.id, "interrupted", node.agentSessionId, diagnostic);
            continue;
          }
          await this.applyAgentStatusIfLive(node.id, "cancelled", node.agentSessionId, "用户停止 Run。 ");
        } catch (error) {
          // Journal fail closed 时仍继续停止其余真实 Worker，不能用首个落盘失败换取进程泄漏。
          stopError ??= error instanceof Error ? error : new Error(String(error));
          try { await this.applyAgentStatusIfLive(node.id, "interrupted", node.agentSessionId, `停止未确认：${error instanceof Error ? error.message : String(error)}`); } catch { /* 保留首个失败并继续。 */ }
        }
      }
      if (stopError !== undefined) throw stopError;
      await this.transitionRunIfLive("cancelled", "用户停止 Run。 ");
      return this.snapshot();
    } catch (error) {
      const diagnostic = `停止未确认：${error instanceof Error ? error.message : String(error)}`;
      if (this.state.snapshot().status !== "cancelled") await this.transitionRun("interrupted", diagnostic);
      throw error;
    } finally {
      for (const node of targets) this.host.endStop(node.id);
      this.#stopping = false;
    }
  }

  /**
   * Desktop 明确退出的快速收敛路径。
   *
   * 先 durable-first 写入 cancelled，随后才尽力停止已启动的 Worker；不等待 ACP
   * cancel 或子进程退出确认。这样用户退出的授权事实不会被“CLI 是否及时响应”改写。
   */
  async cancelForDesktopExit(engineInstanceId: string): Promise<RunSnapshot> {
    const status = this.state.snapshot().status;
    if (status === "completed" || status === "cancelled" || status === "interrupted") return this.snapshot();
    let exitError: Error | undefined;
    try { await this.host.commitEvent({ type: "desktop.exit_requested", at: new Date().toISOString(), runId: this.journal.manifest.runId, nodeId: null, agentSessionId: null, diagnostic: "用户退出 Wave Flow。 ", engineInstanceId }); }
    catch (error) { exitError = error instanceof Error ? error : new Error(String(error)); }
    this.host.pauseScheduling(); this.#stopping = true;
    this.host.abortQueuedStarts();
    this.host.rejectPendingGates("退出 Wave Flow，决策门不再等待答案。 ");
    const activeControl = this.#controlAbort;
    activeControl?.abort();
    // pause/recover 可能正写入 agent/run 状态；先等它完成 finally 清理再写
    // cancelled，避免 cancelled 之后又落一条非法 paused/recovering 事件——
    // 那会让该 Run 的 Journal 重放永久失败。只等本地控制操作清理，不等 Worker。
    if (activeControl && this.#controlSettled) await this.#controlSettled;
    const targets = this.state.snapshot().phases.flatMap((phase) => phase.agents).filter((node) =>
      node.status === "queued" || node.status === "running" || node.status === "blocked" || node.status === "pausing" || node.status === "paused" || node.status === "recovering",
    );
    for (const node of targets) {
      // 与并发 complete 交错时已终态节点保持原证据，只收敛仍存活的节点。
      // Journal 已 fail closed 时仍必须向所有已启动 Worker 发停止信号。
      try { await this.applyAgentStatusIfLive(node.id, "cancelled", node.agentSessionId, "退出 Wave Flow 时停止。 "); } catch { /* 最终 transition 会携带首个失败；先继续停止真实进程。 */ }
      if (node.status !== "queued" && this.state.agent(node.id).status !== "completed" && this.host.stopNode) {
        this.host.beginStop(node.id);
        void this.host.stopNode(node).catch(() => undefined).finally(() => this.host.endStop(node.id));
      }
    }
    if (exitError) throw exitError;
    await this.transitionRunIfLive("cancelled", "退出 Wave Flow 时停止。 ");
    return this.snapshot();
  }

  /** Engine 在排队 stop 前立刻抢占当前 ACP 控制调用。 */
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
    await this.host.commitEvent(event);
  }

  /**
   * 收敛类写入（stop/退出）：节点可能恰好在写入前自行 complete。已终态的节点跳过
   * 而不是落一条非法转移——cancelled 写在 completed 之后会让 Journal 永久不可重放。
   * 返回是否真的写入了该状态。
   */
  private async applyAgentStatusIfLive(nodeId: string, status: import("./run-types").AgentNodeStatus, agentSessionId: string | null, diagnostic: string): Promise<boolean> {
    return this.host.mutationExclusive(async () => {
      if (!canTransition(this.state.agent(nodeId).status, status)) return false;
      const event: JournalEvent = { type: "agent.status", at: new Date().toISOString(), runId: this.journal.manifest.runId, nodeId, agentSessionId, diagnostic, status };
      this.state.assertApplicable(event);
      await this.journal.append(event);
      this.state.apply(event);
      return true;
    });
  }

  private async transitionRun(status: import("./run-types").RunStatus, diagnostic: string | null): Promise<void> {
    const event: JournalEvent = { type: "run.status", at: new Date().toISOString(), runId: this.journal.manifest.runId, nodeId: null, agentSessionId: null, diagnostic, status };
    await this.host.commitEvent(event);
  }

  /** 收敛类 Run 转移：Run 恰已终态时跳过，不覆盖已封存的结果。 */
  private async transitionRunIfLive(status: import("./run-types").RunStatus, diagnostic: string | null): Promise<boolean> {
    return this.host.mutationExclusive(async () => {
      if (!canRunTransition(this.state.snapshot().status, status)) return false;
      const event: JournalEvent = { type: "run.status", at: new Date().toISOString(), runId: this.journal.manifest.runId, nodeId: null, agentSessionId: null, diagnostic, status };
      this.state.assertApplicable(event);
      await this.journal.append(event);
      this.state.apply(event);
      return true;
    });
  }
}

/** 当前尝试视图会隐藏旧分支；展示序号必须始终从整个 Journal 的历史最大值续写。 */
function maximumJournalSequence(events: readonly JournalEvent[]): number {
  return events.reduce((maximum, event) => event.type === "agent.created" ? Math.max(maximum, event.sequence) : maximum, 0);
}
