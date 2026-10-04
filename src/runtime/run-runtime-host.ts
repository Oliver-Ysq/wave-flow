import type { RunJournal } from "../journal/run-journal";
import type { JournalEvent } from "../journal/types";
import type { JsonObject } from "../shared/json";
import type { NormalizedAgentRequest } from "../shared/workflow-types";
import type { WorkflowExecutionHost } from "./workflow-host";
import type { AgentNodeExecutor } from "./run-types";
import { RunStateMachine } from "./run-state-machine";
import { WorkflowContractError } from "../workflow/errors";
import { requireCapabilities } from "../adapters/capabilities";

/** 将 Workflow 作者 API 映射为耐久 Run 状态事实的 Runtime Host。 */
export class RunRuntimeHost implements WorkflowExecutionHost {
  #sequence = 0;
  #backgroundFailure: Error | null = null;

  constructor(
    private readonly journal: RunJournal,
    private readonly state: RunStateMachine,
    private readonly executor: AgentNodeExecutor,
    initialSequence = 0,
  ) { this.#sequence = initialSequence; }

  /** 创建、启动并执行节点；只有结果与 Journal 均耐久后才返回对象。 */
  async agent(request: NormalizedAgentRequest): Promise<JsonObject | null> {
    if (request.phase === undefined) throw new WorkflowContractError("agent() 前必须调用 phase() 选择已声明阶段。");
    const nodeId = request.id;
    const created = this.event({
      type: "agent.created",
      nodeId,
      sequence: ++this.#sequence,
      phase: request.phase ?? null,
      request,
    });
    await this.durableApply(created);
    try {
      await this.checkCapabilities(this.state.agent(nodeId));
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      if (this.state.agent(nodeId).status === "queued") {
        await this.durableApply(this.event({ type: "agent.status", nodeId, status: "interrupted", diagnostic }));
      }
      throw error;
    }
    const started = this.event({ type: "agent.status", nodeId, status: "running", agentSessionId: crypto.randomUUID() });
    await this.durableApply(started);
    const node = this.state.agent(nodeId);
    try {
      const result = await this.executor.execute(node);
      if (result === null) {
        const diagnostic = "执行器返回 null，无法验证节点已完成。";
        await this.durableApply(this.event({ type: "agent.status", nodeId, status: "interrupted", diagnostic }));
        throw new Error(diagnostic);
      }
      const resultPath = await this.journal.writeResult(nodeId, result);
      await this.durableApply(this.event({ type: "agent.completed", nodeId, resultPath, result }));
      return result;
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      if (this.state.agent(nodeId).status === "running") {
        await this.durableApply(this.event({ type: "agent.status", nodeId, status: "interrupted", diagnostic }));
      }
      throw error;
    }
  }

  /** 将作者 Phase 切换作为耐久事实记录；状态机的节点归属由请求内捕获的 Phase 决定。 */
  phase(title: string): void {
    void this.captureBackgroundFailure(this.durableApply(this.event({ type: "phase.changed", nodeId: null, title })));
  }

  /** 将作者日志追加为耐久事实；不从文本推断业务状态。 */
  log(message: string): void {
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
