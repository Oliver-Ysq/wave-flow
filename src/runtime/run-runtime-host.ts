import type { RunJournal } from "../journal/run-journal";
import type { JournalEvent } from "../journal/types";
import type { JsonObject } from "../shared/json";
import type { AuthorAgentRequest, NormalizedAgentRequest } from "../shared/workflow-types";
import type { DecisionGateRequest, WorkflowExecutionHost } from "./workflow-host";
import type { ExecutionBatch, PhaseVisit } from "./workflow-host";
import type { AgentNodeExecutor } from "./run-types";
import { RunStateMachine, validateGateAnswer } from "./run-state-machine";
import { WorkflowContractError } from "../workflow/errors";
import { isDeepStrictEqual } from "node:util";

/** 将 Workflow 作者 API 映射为耐久 Run 状态事实的 Runtime Host。 */
export class RunRuntimeHost implements WorkflowExecutionHost {
  #logicalSequence = 0;
  #journalSequence = 0;
  #backgroundFailure: Error | null = null;
  #replayPrefix = true;
  #stopping = new Set<string>();
  #schedulingPaused = false;
  #schedulingGate: Promise<void> | null = null;
  #releaseSchedulingGate: (() => void) | null = null;
  #currentPhaseVisit: PhaseVisit | null = null;
  #phaseVisitSequence = 0;
  #phaseOccurrences = new Map<string, number>();
  #replayAttemptStarted = false;
  /** stop/退出已撤销全部排队启动许可；等待中的节点在名额复核处拒绝，不再 durable running。 */
  #schedulingAborted = false;
  /** 并行replay分支共享同一次attempt初始化，避免重复落run/attempt/phase开始事实。 */
  #replayAttemptStarting: Promise<PhaseVisit> | null = null;
  #replayPhaseTitle: string | null = null;
  /** 同一 Run 所有耐久事实的互斥尾链：核验、Journal 追加与内存 apply 原子完成。 */
  #mutationTail: Promise<unknown> = Promise.resolve();
  /** 等待用户答案的决策门；stop 时必须拒绝，避免 Workflow 永远悬挂。 */
  #gateWaiters = new Map<string, { readonly resolve: (answer: JsonObject) => void; readonly reject: (error: Error) => void }>();

  constructor(
    private readonly journal: RunJournal,
    private readonly state: RunStateMachine,
    private readonly executor: AgentNodeExecutor,
    initialJournalSequence = 0,
    private readonly replay = false,
    /** interrupted Run 的 running 事实延迟到首个重跑节点经过调用指纹核验后。 */
    private readonly resumeInterrupted = false,
    /** 执行配置：assigned 只读兼容；script 模式承载逐节点 CLI（nodeClis）与动态兜底（cli）。 */
    private readonly executionConfig: import("../harness/types").ExecutionConfigSnapshot | null = null,
    /**
     * 本次 attempt 启动时的技能库摘要；空库为 null。
     *
     * 只用于回放复用判定：与节点耐久 provenance 的 skills.digest 不一致时，
     * 旧 completed 结果不得复用，从该节点起重跑。它不参与业务完成判定。
     */
    private readonly skillsDigest: string | null = null,
  ) {
    this.#journalSequence = initialJournalSequence;
    if (!replay) this.#logicalSequence = initialJournalSequence;
    const snapshot = state.snapshot();
    for (const visit of snapshot.phaseVisits) {
      this.#phaseVisitSequence = Math.max(this.#phaseVisitSequence, visit.phaseVisitId);
      this.#phaseOccurrences.set(visit.title, Math.max(this.#phaseOccurrences.get(visit.title) ?? 0, visit.occurrence));
    }
  }

  /** 返回当前 Run 的耐久存储、状态机与互斥区，供真实执行器注册 ControlServer；不对 Workflow 作者公开。 */
  controlContext(): { readonly journal: RunJournal; readonly state: RunStateMachine; readonly exclusive: <T>(operation: () => Promise<T>) => Promise<T> } { return { journal: this.journal, state: this.state, exclusive: (operation) => this.mutationExclusive(operation) }; }

  /**
   * 同一 Run 的耐久事实互斥区。Worker 上报（私有控制 socket）与用户控制（IPC 通道）没有
   * 共享调用栈：complete/block 的磁盘写入窗口内可能插入 stop/exit 的 cancelled，
   * 若校验与 append 分离，非法事件会先落盘再在 apply 时爆炸，使档案永久不可重放。
   * 互斥区内必须先 assertApplicable 核验、再 append、再 apply。
   */
  mutationExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#mutationTail.then(operation);
    this.#mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 互斥区内的标准耐久写入：副本试算可重放后才追加；落盘失败不改动内存状态。 */
  async commitEvent(event: JournalEvent): Promise<void> {
    await this.mutationExclusive(async () => {
      this.state.assertApplicable(event);
      await this.journal.append(event);
      this.state.apply(event);
    });
  }

  /** Runtime 的运行控制只经此窄边界调用执行器，不能直接接触 Adapter 内部。 */
  pauseNode(node: import("./run-types").AgentNodeSnapshot, signal: AbortSignal): Promise<void> {
    if (!this.executor.pause) throw new Error(`节点 ${node.id} 的执行器不支持 pause。`);
    return this.executor.pause(node, signal);
  }

  /** 在原节点会话中恢复；Executor 必须负责取得新的投递确认。 */
  recoverNode(node: import("./run-types").AgentNodeSnapshot, signal: AbortSignal): Promise<import("./run-types").AgentRecovery> {
    if (!this.executor.recover) throw new Error(`节点 ${node.id} 的执行器不支持 recover。`);
    return this.executor.recover(node, signal);
  }

  /** 终止真实节点；与 pause 不同，执行器必须让等待中的 agent() 返回错误。 */
  stopNode(node: import("./run-types").AgentNodeSnapshot): Promise<void> {
    if (!this.executor.stop) throw new Error(`节点 ${node.id} 的执行器不支持 stop。`);
    return this.executor.stop(node);
  }

  /** 普通用户停止后的Git partial收尾；调用前节点必须已耐久cancelled。 */
  finalizePartial(node: import("./run-types").AgentNodeSnapshot): Promise<void> { return this.executor.finalizePartial?.(node) ?? Promise.resolve(); }

  /** stop 期间执行器 rejection 不代表异常；Runtime 会把节点收敛为 cancelled。 */
  beginStop(nodeId: string): void { this.#stopping.add(nodeId); }
  endStop(nodeId: string): void { this.#stopping.delete(nodeId); }

  /** 是否已有节点确实因 Engine 全局资源名额等待。 */
  hasWaitingStart(): boolean { return this.executor.hasWaitingStart?.() === true; }

  /**
   * 名额到手不代表启动许可仍然有效：等待期间用户可能已 pause/stop。
   * stop/退出（含 Run 已终态）直接归还名额并拒绝；pause 先归还名额、挂到调度闸门，
   * recover 后重新排队——queued 节点不得占住名额，也不得绕过闸门 durable running。
   */
  private async acquireStartSlot(nodeId: string): Promise<void> {
    for (;;) {
      if (this.#schedulingAborted) throw new WorkflowContractError("Run 已停止，排队节点不再启动。");
      await this.executor.waitForStart?.(this.state.agent(nodeId));
      if (this.#schedulingAborted || isTerminalRunStatus(this.state.snapshot().status)) {
        this.executor.cancelStart?.(this.state.agent(nodeId));
        throw new WorkflowContractError("Run 已停止，排队节点不再启动。");
      }
      if (!this.#schedulingPaused) return;
      this.executor.cancelStart?.(this.state.agent(nodeId));
      await this.#schedulingGate;
    }
  }

  /** Run pause 后阻断尚未进入启动阶段的新节点；已启动节点由 Executor 单独停止。 */
  pauseScheduling(): void {
    if (this.#schedulingPaused) return;
    this.#schedulingPaused = true;
    this.#schedulingGate = new Promise<void>((resolve) => { this.#releaseSchedulingGate = resolve; });
  }

  /** recover 已确认所有原节点可继续后，放开被 pause 挡住的 Workflow 调度。 */
  resumeScheduling(): void {
    if (!this.#schedulingPaused) return;
    this.#schedulingPaused = false;
    this.#releaseSchedulingGate?.();
    this.#releaseSchedulingGate = null;
    this.#schedulingGate = null;
  }

  /**
   * stop/退出撤销所有尚未 durable running 的启动许可：唤醒调度闸门与名额等待者，
   * 让它们在复核处带着明确诊断失败并归还名额，而不是悬挂或启动真实 Worker。
   */
  abortQueuedStarts(): void {
    this.#schedulingAborted = true;
    this.resumeScheduling();
  }

  /** 创建、启动并执行节点；只有结果与 Journal 均耐久后才返回对象。 */
  async agent(request: AuthorAgentRequest, executionBatch: ExecutionBatch, phaseVisit: PhaseVisit): Promise<JsonObject | null> {
    while (this.#schedulingPaused) await this.#schedulingGate;
    if (this.#schedulingAborted) throw new WorkflowContractError("Run 已停止，不再调度新 Agent 节点。");
    // 生效请求必须先于指纹比较与 agent.created 落盘：Journal 记录的永远是实际生效的
    // cli（脚本字面量或本次执行选择的 CLI）与 assignedRuntimeId，而不是省略形式。
    const effectiveRequest = this.resolveRequest(request);
    if (effectiveRequest.phase === undefined) throw new WorkflowContractError("agent() 前必须调用 phase() 选择已声明阶段。");
    const nodeId = effectiveRequest.id;
    const logicalSequence = ++this.#logicalSequence;
    let existing: import("./run-types").AgentNodeSnapshot | null = null;
    try { existing = this.state.agent(nodeId); } catch {}
    if (existing) {
      if (!this.replay || this.state.logicalSequence(nodeId) !== logicalSequence || existing.phase !== (effectiveRequest.phase ?? null) || fingerprint(existing.request) !== fingerprint(effectiveRequest)) throw new WorkflowContractError(`resume 的第 ${logicalSequence} 个 agent() 调用与 Journal 节点不匹配：${nodeId}；旧=${fingerprint(existing.request)}；新=${fingerprint(effectiveRequest)}`);
      // replay 复用除请求指纹外还要复核 provenance：旧 attempt 实际落过的 Runtime
      // （含启动前回退）与当前分配快照不一致时，旧结果不可复用，从该节点开始新 attempt。
      const provenanceMatches = this.assignmentProvenanceMatches(nodeId);
      if (existing.status === "completed" && this.#replayPrefix && provenanceMatches) {
        // 业务JSON可复用不代表可以跳过退出核验与租约释放。宿主先补交接，不能重跑业务。
        await this.executor.finalizeCompleted?.(existing);
        if (this.executor.finalizeCompleted && this.resumeInterrupted) {
          // 纯Git收尾恢复没有新Worker，不伪造executionAttempt；仅在收尾核验成功后恢复Run调度。
          await this.mutationExclusive(async () => {
            const status = this.state.snapshot().status;
            if (status !== "interrupted" && status !== "cancelled") return;
            const event = this.event({ type: "run.status", nodeId: null, status: "running", diagnostic: "用户显式resume，原completed节点宿主成果交接已恢复；未重跑业务Worker。" });
            this.state.assertApplicable(event); await this.journal.append(event); this.state.apply(event);
          });
        }
        return existing.result;
      }
      if ((existing.status === "running" || existing.status === "blocked") && this.#replayPrefix) throw new WorkflowContractError(`resume 遇到仍存活或未确认丢失的节点：${nodeId}；先恢复其 Control 或将其明确标记为 interrupted。`);
      const invalidatedByPriorRestart = !this.#replayPrefix || (existing.status === "completed" && !provenanceMatches);
      // 复用资格按逻辑调用顺序撤销，必须先于任何await；否则并行后续调用
      // 会在首个重跑节点等待Journal时把旧completed结果混入新attempt。
      this.#replayPrefix = false;
      const replayVisit = await this.ensureReplayAttempt(phaseVisit.title || effectiveRequest.phase!);
      const restarted = this.event({ type: "agent.restarted", nodeId, sequence: existing.sequence, logicalSequence, newAgentSessionId: crypto.randomUUID(), invalidatedByPriorRestart, executionAttemptId: replayVisit.executionAttemptId, phaseVisitId: replayVisit.phaseVisitId, request: effectiveRequest });
      await this.durableApply(restarted);
    } else {
      const activeVisit = this.replay ? await this.ensureReplayAttempt(phaseVisit.title || effectiveRequest.phase!) : phaseVisit;
      const created = this.event({ type: "agent.created", nodeId, sequence: ++this.#journalSequence, logicalSequence, phase: effectiveRequest.phase ?? null, executionAttemptId: activeVisit.executionAttemptId, phaseVisitId: activeVisit.phaseVisitId, executionBatch, request: effectiveRequest });
      await this.durableApply(created);
    }
    // 全局 Engine 的名额必须在节点进入 running 前取得。这样超限节点可被权威
    // 快照如实显示为 queued，而不会先伪装成已启动的 ACP Worker。
    await this.acquireStartSlot(nodeId);
    const restartedSession = existing && this.replay ? this.state.agent(nodeId).agentSessionId : null;
    const started = this.event({ type: "agent.status", nodeId, status: "running", agentSessionId: restartedSession ?? crypto.randomUUID() });
    try {
      await this.durableApply(started);
    } catch (error) {
      // 名额已取得但 running 事实未耐久时，节点从未真正进入执行器；必须归还，
      // 否则一次 Journal 写入错误会永久耗尽全局会话名额。
      this.executor.cancelStart?.(this.state.agent(nodeId));
      throw error;
    }
    const node = this.state.agent(nodeId);
    try {
      // running 落盘与真实启动之间仍可能发生 stop；即使 stop 快照没看到这个节点，
      // 撤销标记也会阻止它在终态 Run 中启动真实 Worker。
      if (this.#schedulingAborted || isTerminalRunStatus(this.state.snapshot().status)) {
        this.executor.cancelStart?.(node);
        throw new WorkflowContractError("Run 已停止，启动许可已撤销。");
      }
      const result = await this.executeWithStartupRecovery(nodeId, node);
      // 真实执行器的 complete 已由 ControlServer 按证据顺序写入 Journal；不能重复写入。
      const current = this.state.agent(nodeId);
      if (current.status === "completed") {
        if (result === null || !isDeepStrictEqual(current.result, result)) throw new Error("真实执行器返回结果与已耐久的 complete 结果不一致。");
        await this.executor.finalizeCompleted?.(current);
        return result;
      }
      if (result === null) {
        const diagnostic = "执行器返回 null，无法验证节点已完成。";
        await this.durableApply(this.event({ type: "agent.status", nodeId, status: "interrupted", diagnostic }));
        throw new Error(diagnostic);
      }
      const resultPath = await this.journal.writeResult(nodeId, result, node.agentSessionId ?? undefined);
      await this.durableApply(this.event({ type: "agent.completed", nodeId, agentSessionId: node.agentSessionId, resultPath, result }));
      await this.executor.finalizeCompleted?.(this.state.agent(nodeId));
      return result;
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      // 执行器失败意味着节点不可能再继续（包括 Worker 在 blocked 等待答案时死亡）；
      // 任意非终态节点都必须诚实收敛为 interrupted，不得留下终态 Run 与非终态节点并存的投影。
      // 与pause/recover失败收敛共享互斥区；锁外读取会在磁盘等待期间过期。
      // Journal fail closed 时收敛写入必然失败；保留节点自身的首个错误向外抛出。
      try {
        await this.mutationExclusive(async () => {
          const status = this.state.agent(nodeId).status;
          if (status === "completed" || status === "cancelled" || status === "interrupted" || this.#stopping.has(nodeId)) return;
          const event = this.event({ type: "agent.status", nodeId, status: "interrupted", diagnostic });
          this.state.assertApplicable(event);
          await this.journal.append(event);
          this.state.apply(event);
        });
      } catch { /* Journal 已 fail closed；不吞掉下方的首个失败。 */ }
      throw error;
    }
  }

  /**
   * 启动超时发生在 agent.session 耐久前，没有业务副作用。先给用户友好提示，
   * 再让执行器自动重试一次；不把“如何恢复”交给用户，也不重发已投递任务。
   */
  private async executeWithStartupRecovery(nodeId: string, node: import("./run-types").AgentNodeSnapshot): Promise<JsonObject | null> {
    try {
      return await this.executor.execute(node);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.state.agent(nodeId);
      // 只读 Runtime 自己已有启动重试；宿主只兜底写 Worker，避免同一错误重试两层。
      if (node.sandbox === "read-only" || !message.includes("ACP Worker 启动超时") || this.#stopping.has(nodeId) || this.state.hasNodeSession(nodeId, current.agentSessionId)) throw error;
      await this.durableApply(this.event({ type: "log.written", nodeId, agentSessionId: current.agentSessionId, diagnostic: null, message: "本地执行环境正在自动恢复，请稍候…" }));
      try {
        return await this.executor.execute(this.state.agent(nodeId));
      } catch (retryError) {
        const after = this.state.agent(nodeId);
        // 第二次已经建立 session（可能已投递任务）后失败，错误必须原样上抛；不能
        // 用“启动失败可重试”掩盖可能已有副作用的 prompt 失败。
        if (this.state.hasNodeSession(nodeId, after.agentSessionId)) throw retryError;
        // 首次是启动超时且 session 未建立；重试若因租约/清理等任何原因失败，仍按
        // 启动失败向用户呈现一个可执行动作，不把底层清理细节推到主界面。
        throw new Error("本地执行环境暂时不可用，已自动恢复仍未成功。请重试。");
      }
    }
  }

  /** 将作者 Phase 切换作为耐久事实记录；状态机的节点归属由请求内捕获的 Phase 决定。 */
  phase(title: string): PhaseVisit {
    if (this.replay && !this.#replayAttemptStarted) {
      this.#replayPhaseTitle = title;
      return this.#currentPhaseVisit ?? { executionAttemptId: this.state.snapshot().currentExecutionAttemptId + 1, phaseVisitId: 0, title, occurrence: 0 };
    }
    const executionAttemptId = this.state.snapshot().currentExecutionAttemptId;
    const visit: PhaseVisit = { executionAttemptId, phaseVisitId: ++this.#phaseVisitSequence, title, occurrence: (this.#phaseOccurrences.get(title) ?? 0) + 1 };
    this.#phaseOccurrences.set(title, visit.occurrence);
    this.#currentPhaseVisit = visit;
    void this.captureBackgroundFailure(this.durableApply(this.event({ type: "phase.entered", nodeId: null, ...visit })));
    return visit;
  }

  /** 将作者日志追加为耐久事实；不从文本推断业务状态。 */
  log(message: string): void {
    if (this.replay) return;
    void this.captureBackgroundFailure(this.durableApply(this.event({ type: "log.written", nodeId: null, message })));
  }

  /**
   * 脚本显式决策门：先耐久 gate.created 再等待用户答案；replay 时同一 id 的
   * 问题与 Schema 必须完全一致，已回答的直接返回耐久答案，不重复写入。
   */
  async decisionGate(request: DecisionGateRequest, phaseVisit: PhaseVisit | null): Promise<JsonObject> {
    const existing = this.state.gate(request.id);
    if (existing) {
      if (existing.question !== request.question || !isDeepStrictEqual(existing.answerSchema, request.answerSchema)) throw new WorkflowContractError(`decisionGate 与已耐久决策门不匹配：${request.id}`);
      if (!this.replay) throw new WorkflowContractError(`decisionGate 的 id 在同一 Run 内必须唯一：${request.id}`);
      if (existing.answer !== null) return existing.answer;
      // completed 前缀后的未答 gate 也是恢复边界；校验原问题/Schema 后建立新 attempt，
      // 不能让外层已运行而内层仍 cancelled，且不能自动回答或重跑 completed 前缀。
      await this.ensureReplayAttempt(phaseVisit?.title ?? this.#replayPhaseTitle ?? "default");
      return this.waitForGateAnswer(request.id);
    }
    // resume 首个重跑节点会把脚本 phase() 的占位访问（phaseVisitId=0）替换为
    // 新 attempt 的真实耐久访问；后续首次创建 gate 必须绑定这个新身份。
    const activeVisit = this.replay
      ? await this.ensureReplayAttempt(phaseVisit?.title ?? this.#replayPhaseTitle ?? "default")
      : phaseVisit;
    const created = this.event({ type: "gate.created", nodeId: null, gateId: request.id, question: request.question, answerSchema: request.answerSchema, executionAttemptId: this.state.snapshot().currentExecutionAttemptId, phaseVisitId: activeVisit?.phaseVisitId ?? null });
    await this.durableApply(created);
    return this.waitForGateAnswer(request.id);
  }

  /** Engine 答题入口：先于 Journal 写入校验 Schema；答案只唤醒等待同一 gate 的脚本调用。 */
  async answerGate(gateId: string, answer: JsonObject): Promise<void> {
    const gate = this.state.gate(gateId);
    if (!gate) throw new WorkflowContractError(`未知决策门：${gateId}`);
    if (gate.answer !== null) throw new WorkflowContractError(`决策门已回答：${gateId}`);
    // Schema 拒绝必须先发生于任何耐久写入，否则坏答案会污染 Journal 并阻断重开。
    validateGateAnswer(gate.answerSchema, answer);
    await this.durableApply(this.event({ type: "gate.answered", nodeId: null, gateId, answer }));
    const waiter = this.#gateWaiters.get(gateId);
    if (waiter) {
      this.#gateWaiters.delete(gateId);
      waiter.resolve(answer);
    }
  }

  /** stop 时拒绝全部 pending 决策门，让 Workflow 调用栈随节点一起收敛。 */
  rejectPendingGates(diagnostic: string): void {
    for (const waiter of this.#gateWaiters.values()) waiter.reject(new Error(diagnostic));
    this.#gateWaiters.clear();
  }

  private waitForGateAnswer(gateId: string): Promise<JsonObject> {
    // resume 建立 attempt 期间答案可能先耐久；注册等待者前复核，避免丢失唤醒。
    const saved = this.state.gate(gateId)?.answer;
    if (saved !== null && saved !== undefined) return Promise.resolve(saved);
    return new Promise<JsonObject>((resolve, reject) => {
      this.#gateWaiters.set(gateId, { resolve, reject });
    });
  }

  /** 等待同步作者 API 排队的 Journal 写入，供 Run 收尾前建立 durable barrier。 */
  async flush(): Promise<void> {
    await this.journal.flush();
    if (this.#backgroundFailure) throw this.#backgroundFailure;
  }

  /**
   * 把作者请求解析为生效请求。
   *
   * 优先级：历史 assigned 分配 > 脚本字面量 `cli` > 该节点的执行级选择（`nodeClis[id]`）
   * > 动态节点兜底（`cli`）。都没有时，在任何 Journal 事实或 Worker 会话之前以契约错误
   * 拒绝——省略 cli 不是"让宿主随便挑一个"，而是"必须由本次执行逐节点明确选择"。
   */
  private resolveRequest(request: AuthorAgentRequest): NormalizedAgentRequest {
    const config = this.executionConfig;
    const assigned = config && config.assignmentMode !== "script"
      ? config.assignments.find((item) => item.agentId === request.id) ?? config.defaultAssignment
      : null;
    // 脚本模式：源码字面量优先，其次该节点自己的选择，最后是动态节点兜底。
    const scriptCli = config?.assignmentMode === "script" ? config.nodeClis?.[request.id] ?? config.cli : undefined;
    const cli = assigned?.cli ?? request.cli ?? scriptCli;
    if (!cli) {
      throw new WorkflowContractError(`agent() 节点 ${request.id} 未声明 cli，且本次执行没有为它选择 CLI；请在确认页为每个节点选择本机已验证的 CLI，或在源码中写死 cli。`);
    }
    return {
      ...request,
      cli,
      ...(assigned ? { model: undefined, assignedRuntimeId: assigned.runtimeId } : {}),
    };
  }

  /** 当前节点的分配与已耐久 session provenance 是否一致；缺任一证据时不否决复用。 */
  private assignmentProvenanceMatches(nodeId: string): boolean {
    const recorded = this.state.nodeSessionRuntime(nodeId);
    if (!recorded) return true;
    // 技能库变化优先于分配快照：同一 CLI 下更换 skill 内容也不能复用旧结果。
    if ((recorded.skills?.digest ?? null) !== this.skillsDigest) return false;
    const config = this.executionConfig;
    if (!config || config.assignmentMode === "script") return true;
    const assignment = config.assignments.find((item) => item.agentId === nodeId) ?? config.defaultAssignment;
    return recorded.runtimeId === assignment.runtimeId && recorded.adapterId === assignment.adapterId && recorded.adapterVersion === assignment.adapterVersion;
  }

  private event(event: Record<string, unknown>): JournalEvent {    return {
      ...event,
      at: new Date().toISOString(),
      runId: this.state.manifest.runId,
      agentSessionId: event.agentSessionId ?? null,
      diagnostic: event.diagnostic ?? null,
    } as unknown as JournalEvent;
  }

  private async durableApply(event: JournalEvent): Promise<void> {
    await this.commitEvent(event);
  }

  /** resume 的已完成前缀不产生事实；首个重跑节点才开启新尝试与第一轮阶段访问。 */
  private async ensureReplayAttempt(title: string): Promise<PhaseVisit> {
    if (this.#replayAttemptStarted && this.#currentPhaseVisit) return this.#currentPhaseVisit;
    return this.#replayAttemptStarting ??= this.startReplayAttempt(title);
  }

  /** 仅由单飞入口调用；初始化失败保留同一拒绝，不在同次执行内重试写事实。 */
  private async startReplayAttempt(title: string): Promise<PhaseVisit> {
    if (this.resumeInterrupted && (this.state.snapshot().status === "interrupted" || this.state.snapshot().status === "cancelled")) {
      await this.durableApply(this.event({
        type: "run.status",
        nodeId: null,
        diagnostic: "用户显式 resume，已通过首个节点调用校验并创建新的 executionAttempt。",
        status: "running",
      }));
    }
    const executionAttemptId = this.state.snapshot().currentExecutionAttemptId + 1;
    await this.durableApply(this.event({ type: "execution-attempt.started", nodeId: null, executionAttemptId }));
    const visit: PhaseVisit = { executionAttemptId, phaseVisitId: 1, title: this.#replayPhaseTitle ?? title, occurrence: 1 };
    await this.durableApply(this.event({ type: "phase.entered", nodeId: null, ...visit }));
    this.#replayAttemptStarted = true;
    this.#currentPhaseVisit = visit;
    this.#phaseVisitSequence = 1;
    this.#phaseOccurrences = new Map([[visit.title, 1]]);
    return visit;
  }

  private async captureBackgroundFailure(operation: Promise<void>): Promise<void> {
    try {
      await operation;
    } catch (error) {
      this.#backgroundFailure ??= error instanceof Error ? error : new Error(String(error));
    }
  }
}

/** JSON-safe 请求的键排序指纹；字段写入顺序不能影响 resume 是否复用。 */
function fingerprint(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${fingerprint(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Run 是否已封存终态；终态后不得再接受任何业务启动事实。 */
function isTerminalRunStatus(status: import("./run-types").RunStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "interrupted";
}
