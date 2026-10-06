import type { RunJournal } from "../journal/run-journal";
import type { JournalEvent } from "../journal/types";
import type { JsonObject } from "../shared/json";
import type { NormalizedAgentRequest } from "../shared/workflow-types";
import type { WorkflowExecutionHost } from "./workflow-host";
import type { ExecutionBatch, PhaseVisit } from "./workflow-host";
import type { AgentNodeExecutor } from "./run-types";
import { RunStateMachine } from "./run-state-machine";
import { WorkflowContractError } from "../workflow/errors";
import { requireCapabilities } from "../adapters/capabilities";
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
  #replayPhaseTitle: string | null = null;

  constructor(
    private readonly journal: RunJournal,
    private readonly state: RunStateMachine,
    private readonly executor: AgentNodeExecutor,
    initialJournalSequence = 0,
    private readonly replay = false,
  ) {
    this.#journalSequence = initialJournalSequence;
    if (!replay) this.#logicalSequence = initialJournalSequence;
    const snapshot = state.snapshot();
    for (const visit of snapshot.phaseVisits) {
      this.#phaseVisitSequence = Math.max(this.#phaseVisitSequence, visit.phaseVisitId);
      this.#phaseOccurrences.set(visit.title, Math.max(this.#phaseOccurrences.get(visit.title) ?? 0, visit.occurrence));
    }
  }

  /** 返回当前 Run 的耐久存储与状态机，供真实执行器注册 ControlServer；不对 Workflow 作者公开。 */
  controlContext(): { readonly journal: RunJournal; readonly state: RunStateMachine } { return { journal: this.journal, state: this.state }; }

  /** Runtime 的运行控制只经此受限边界调用执行器，不能直接接触 Adapter 内部。 */
  pauseNode(node: import("./run-types").AgentNodeSnapshot, signal: AbortSignal): Promise<void> {
    if (!this.executor.pause) throw new Error(`节点 ${node.id} 的执行器不支持 pause。`);
    return this.executor.pause(node, signal);
  }

  /** 在原节点会话中恢复；Executor 必须负责取得新的投递确认。 */
  recoverNode(node: import("./run-types").AgentNodeSnapshot, signal: AbortSignal): Promise<import("./run-types").AgentRecovery> {
    if (!this.executor.recover) throw new Error(`节点 ${node.id} 的执行器不支持 recover。`);
    return this.executor.recover(node, signal);
  }

  /** 恢复后取得新 viewer identity，写入 Journal 供 daemon 重启认领。 */
  viewerSession(node: import("./run-types").AgentNodeSnapshot): import("../sessions/types").SessionIdentity | null {
    return this.executor.viewerSession?.(node) ?? null;
  }

  /** 终止真实节点；与 pause 不同，执行器必须让等待中的 agent() 返回错误。 */
  stopNode(node: import("./run-types").AgentNodeSnapshot): Promise<void> {
    if (!this.executor.stop) throw new Error(`节点 ${node.id} 的执行器不支持 stop。`);
    return this.executor.stop(node);
  }

  /** stop 期间执行器 rejection 不代表异常；Runtime 会把节点收敛为 cancelled。 */
  beginStop(nodeId: string): void { this.#stopping.add(nodeId); }
  endStop(nodeId: string): void { this.#stopping.delete(nodeId); }

  /** 是否已有节点确实因 daemon 全局资源名额等待。 */
  hasWaitingStart(): boolean { return this.executor.hasWaitingStart?.() === true; }

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

  /** 创建、启动并执行节点；只有结果与 Journal 均耐久后才返回对象。 */
  async agent(request: NormalizedAgentRequest, executionBatch: ExecutionBatch, phaseVisit: PhaseVisit): Promise<JsonObject | null> {
    while (this.#schedulingPaused) await this.#schedulingGate;
    if (request.phase === undefined) throw new WorkflowContractError("agent() 前必须调用 phase() 选择已声明阶段。");
    const nodeId = request.id;
    const logicalSequence = ++this.#logicalSequence;
    let existing: import("./run-types").AgentNodeSnapshot | null = null;
    try { existing = this.state.agent(nodeId); } catch {}
    if (existing) {
      if (!this.replay || this.state.logicalSequence(nodeId) !== logicalSequence || existing.phase !== (request.phase ?? null) || fingerprint(existing.request) !== fingerprint(request)) throw new WorkflowContractError(`resume 的第 ${logicalSequence} 个 agent() 调用与 Journal 节点不匹配：${nodeId}；旧=${fingerprint(existing.request)}；新=${fingerprint(request)}`);
      if (existing.status === "completed" && this.#replayPrefix) return existing.result;
      if ((existing.status === "running" || existing.status === "blocked") && this.#replayPrefix) throw new WorkflowContractError(`resume 遇到仍存活或未确认丢失的节点：${nodeId}；先恢复其 Control 或将其明确标记为 interrupted。`);
      const replayVisit = await this.ensureReplayAttempt(phaseVisit.title || request.phase!);
      const invalidatedByPriorRestart = !this.#replayPrefix;
      const restarted = this.event({ type: "agent.restarted", nodeId, sequence: existing.sequence, logicalSequence, newAgentSessionId: crypto.randomUUID(), invalidatedByPriorRestart, executionAttemptId: replayVisit.executionAttemptId, phaseVisitId: replayVisit.phaseVisitId, request });
      await this.durableApply(restarted);
      this.#replayPrefix = false;
    } else {
      const activeVisit = this.replay ? await this.ensureReplayAttempt(phaseVisit.title || request.phase!) : phaseVisit;
      const created = this.event({ type: "agent.created", nodeId, sequence: ++this.#journalSequence, logicalSequence, phase: request.phase ?? null, executionAttemptId: activeVisit.executionAttemptId, phaseVisitId: activeVisit.phaseVisitId, executionBatch, request });
      await this.durableApply(created);
    }
    try {
      await this.checkCapabilities(this.state.agent(nodeId));
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      if (this.state.agent(nodeId).status === "queued") {
        await this.durableApply(this.event({ type: "agent.status", nodeId, status: "interrupted", diagnostic }));
      }
      throw error;
    }
    // 全局 daemon 的名额必须在节点进入 running 前取得。这样超限节点可被权威
    // 快照如实显示为 queued，而不会先伪装成已启动的 tmux/App Server 会话。
    await this.executor.waitForStart?.(this.state.agent(nodeId));
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
      const result = await this.executor.execute(node);
      // 真实执行器的 complete 已由 ControlServer 按证据顺序写入 Journal；不能重复写入。
      const current = this.state.agent(nodeId);
      if (current.status === "completed") {
        if (result === null || !isDeepStrictEqual(current.result, result)) throw new Error("真实执行器返回结果与已耐久的 complete 结果不一致。");
        return result;
      }
      if (result === null) {
        const diagnostic = "执行器返回 null，无法验证节点已完成。";
        await this.durableApply(this.event({ type: "agent.status", nodeId, status: "interrupted", diagnostic }));
        throw new Error(diagnostic);
      }
      const resultPath = await this.journal.writeResult(nodeId, result, node.agentSessionId ?? undefined);
      await this.durableApply(this.event({ type: "agent.completed", nodeId, agentSessionId: node.agentSessionId, resultPath, result }));
      return result;
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      if (this.state.agent(nodeId).status === "running" && !this.#stopping.has(nodeId)) {
        await this.durableApply(this.event({ type: "agent.status", nodeId, status: "interrupted", diagnostic }));
      }
      throw error;
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

  /** 等待同步作者 API 排队的 Journal 写入，供 Run 收尾前建立 durable barrier。 */
  async flush(): Promise<void> {
    await this.journal.flush();
    if (this.#backgroundFailure) throw this.#backgroundFailure;
  }

  private event(event: Record<string, unknown>): JournalEvent {
    return {
      ...event,
      at: new Date().toISOString(),
      runId: this.state.manifest.runId,
      agentSessionId: event.agentSessionId ?? null,
      diagnostic: event.diagnostic ?? null,
    } as unknown as JournalEvent;
  }

  private async durableApply(event: JournalEvent): Promise<void> {
    await this.journal.append(event);
    this.state.apply(event);
  }

  /** resume 的已完成前缀不产生事实；首个重跑节点才开启新尝试与第一轮阶段访问。 */
  private async ensureReplayAttempt(title: string): Promise<PhaseVisit> {
    if (this.#replayAttemptStarted && this.#currentPhaseVisit) return this.#currentPhaseVisit;
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

  private async checkCapabilities(node: import("./run-types").AgentNodeSnapshot): Promise<void> {
    const requirements = this.executor.requiredCapabilities?.(node);
    if (!requirements || Object.keys(requirements).length === 0) return;
    if (!this.executor.probeCapabilities) throw new Error("执行器声明了启动能力需求，但未提供运行期能力重检。");
    const snapshot = await this.executor.probeCapabilities();
    requireCapabilities(Object.fromEntries(Object.entries(requirements).map(([name, read]) => [name, read(snapshot)])));
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
