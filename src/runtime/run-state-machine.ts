import Ajv from "ajv";
import type { JournalEvent, RunManifest } from "../journal/types";
import type { AgentNodeSnapshot, AgentNodeStatus, PhaseSnapshot, RunSnapshot, RunStatus } from "./run-types";
import type { JsonSchema } from "../shared/workflow-types";

const terminalAgentStatuses = new Set<AgentNodeStatus>(["completed", "cancelled", "interrupted"]);

/** 由 Journal 事实驱动的内存查询投影；不直接执行 Agent 或写文件。 */
export class RunStateMachine {
  #created = false;
  #status: RunStatus = "running";
  #diagnostic: string | null = null;
  #endedAt: string | null = null;
  #agents = new Map<string, AgentNodeSnapshot>();
  #logicalSequences = new Map<string, number>();
  #recordedSessions = new Set<string>();
  #blockSchemas = new Map<string, JsonSchema | undefined>();

  constructor(readonly manifest: RunManifest) {}

  /** 应用一条已耐久 Journal 事实；非法顺序或转移立即拒绝。 */
  apply(event: JournalEvent): void {
    if (event.runId !== this.manifest.runId) throw new Error("事件不属于当前 Run。");
    if (!this.#created && event.type !== "run.created") throw new Error("Run 的第一条 Journal 事件必须是 run.created。");
    switch (event.type) {
      case "run.created":
        if (this.#created || event.runStatus !== "running" || this.#agents.size !== 0) throw new Error("run.created 事件无效。");
        this.#created = true;
        return;
      case "phase.changed":
      case "log.written":
        return;
      case "agent.created":
        this.#applyAgentCreated(event);
        return;
      case "agent.restarted":
        this.#applyAgentRestarted(event);
        return;
      case "agent.status":
        this.#applyAgentStatus(event.nodeId, event.status, event.at, event.diagnostic, null, event.agentSessionId);
        return;
      case "agent.session":
        this.#applyAgentSession(event);
        return;
      case "agent.completed":
        // 带 validationPath 的 completed 仅能由 ControlServer 写入；它必须有先前耐久的
        // agent.session，防止重开时仅靠伪造 completed 事件绕过受管会话绑定。旧确定性
        // 执行器事件没有 validationPath，保留其兼容读取语义。
        if (event.validationPath !== undefined && (!event.nodeId || !this.#recordedSessions.has(event.nodeId))) throw new Error("Control agent.completed 缺少先前的 agent.session 事实。");
        this.#applyAgentStatus(event.nodeId, "completed", event.at, event.diagnostic, event.result, event.agentSessionId);
        return;
      case "block.created":
        this.#applyBlockCreated(event);
        return;
      case "block.answered":
        this.#applyBlockAnswered(event);
        return;
      case "agent.continued":
        this.#applyBlockContinued(event);
        return;
      case "run.status":
        this.#applyRunStatus(event.status, event.at, event.diagnostic);
        return;
    }
  }

  /** 返回不会泄露内部可变 Map / 数组的 Phase → Agent 查询快照。 */
  snapshot(): RunSnapshot {
    const phases: PhaseSnapshot[] = this.manifest.workflow.phases.map((phase) => ({
      title: phase.title,
      agents: [...this.#agents.values()].filter((agent) => agent.phase === phase.title).sort((left, right) => left.sequence - right.sequence).map(cloneAgent),
    }));
    return {
      id: this.manifest.runId,
      status: this.#status,
      workflow: this.manifest.workflow,
      cwd: this.manifest.workflowProjectCwd,
      createdAt: this.manifest.createdAt,
      endedAt: this.#endedAt,
      diagnostic: this.#diagnostic,
      phases,
    };
  }

  /** 取得可执行节点快照；仅允许当前 running 节点。 */
  agent(nodeId: string): AgentNodeSnapshot {
    const agent = this.#agents.get(nodeId);
    if (!agent) throw new Error(`未知 Agent 节点：${nodeId}`);
    return cloneAgent(agent);
  }

  /** 节点在当前 Workflow 分支中的逻辑调用位置；与追加式展示顺序分离。 */
  logicalSequence(nodeId: string): number {
    const value = this.#logicalSequences.get(nodeId);
    if (!value) throw new Error(`未知 Agent 节点：${nodeId}`);
    return value;
  }

  /**
   * 是否有当前仍在运行或等待人工协助的节点完成真实会话事实耐久记录。
   * 已 completed 节点的旧 session 不能让 resume 在新 attempt 尚未投递时提前返回。
   */
  hasRecordedSession(): boolean {
    return [...this.#recordedSessions].some((nodeId) => {
      const status = this.#agents.get(nodeId)?.status;
      return status === "running" || status === "blocked";
    });
  }

  #applyAgentCreated(event: Extract<JournalEvent, { type: "agent.created" }>): void {
    if (this.#status !== "running") throw new Error("终态 Run 不能创建 Agent 节点。");
    if (event.nodeId === null || this.#agents.has(event.nodeId)) throw new Error("Agent 节点 id 重复或缺失。");
    if (event.phase !== null && !this.manifest.workflow.phases.some((phase) => phase.title === event.phase)) throw new Error("Agent 节点 Phase 未在 manifest 中声明。");
    if (event.sequence !== this.#agents.size + 1) throw new Error("Agent 调用顺序必须连续。");
    this.#agents.set(event.nodeId, {
      id: event.nodeId,
      phase: event.phase,
      sequence: event.sequence,
      cli: event.request.cli,
      sandbox: event.request.sandbox,
      cwd: event.request.cwd,
      label: event.request.label ?? event.nodeId,
      status: "queued",
      result: null,
      diagnostic: null,
      createdAt: event.at,
      startedAt: null,
      endedAt: null,
      agentSessionId: null,
      block: null,
      request: event.request,
    });
    this.#logicalSequences.set(event.nodeId, event.logicalSequence ?? event.sequence);
  }

  /** 显式 resume 对同一节点创建新 attempt；只允许覆盖非 completed 的旧尝试。 */
  #applyAgentRestarted(event: Extract<JournalEvent, { type: "agent.restarted" }>): void {
    if (!event.nodeId) throw new Error("agent.restarted 缺少节点。");
    const agent = this.#agents.get(event.nodeId);
    if (!agent || agent.sequence !== event.sequence || (event.logicalSequence !== undefined && this.logicalSequence(event.nodeId) !== event.logicalSequence) || (agent.status === "completed" && !event.invalidatedByPriorRestart)) throw new Error("agent.restarted 不属于可重跑的旧节点。");
    if (!sameRequest(agent.request, event.request)) throw new Error("agent.restarted 请求与原节点不一致。");
    if (agent.agentSessionId === event.newAgentSessionId) throw new Error("agent.restarted 不得复用旧会话身份。");
    // 旧 attempt 的 agent.session 不能证明新 attempt 已安全投递；resume CLI 必须等候
    // 新会话自己的 session 事实，不能因旧记录提前返回。
    this.#recordedSessions.delete(event.nodeId);
    this.#agents.set(event.nodeId, { ...agent, status: "queued", result: null, diagnostic: "用户显式 resume 创建新 attempt。", startedAt: null, endedAt: null, agentSessionId: event.newAgentSessionId, block: null });
  }

  #applyAgentSession(event: Extract<JournalEvent, { type: "agent.session" }>): void {
    if (!event.nodeId || !event.agentSessionId) throw new Error("agent.session 缺少节点或会话身份。");
    const agent = this.#agents.get(event.nodeId);
    if (!agent || agent.status !== "running" || agent.agentSessionId !== event.agentSessionId) throw new Error("agent.session 必须属于当前 running 节点。");
    if (event.session.runId !== event.runId || event.session.nodeId !== event.nodeId || event.session.agentSessionId !== event.agentSessionId || event.session.cli !== agent.cli) throw new Error("agent.session 会话坐标与节点不匹配。");
    if (this.#recordedSessions.has(event.nodeId)) throw new Error("同一 Agent 节点只能记录一次 agent.session。");
    this.#recordedSessions.add(event.nodeId);
  }

  #applyAgentStatus(nodeId: string | null, status: AgentNodeStatus, at: string, diagnostic: string | null, result: AgentNodeSnapshot["result"] = null, agentSessionId: string | null = null): void {
    if (!nodeId) throw new Error("Agent 状态事件缺少 nodeId。");
    const agent = this.#agents.get(nodeId);
    if (!agent) throw new Error(`未知 Agent 节点：${nodeId}`);
    if (!canTransition(agent.status, status)) throw new Error(`非法 Agent 状态转移：${agent.status} → ${status}`);
    if (agent.agentSessionId !== null && agentSessionId !== null && agent.agentSessionId !== agentSessionId) throw new Error("Agent 状态事件的会话身份不匹配。");
    const updated: AgentNodeSnapshot = {
      ...agent,
      status,
      result,
      diagnostic,
      startedAt: status === "running" && agent.startedAt === null ? at : agent.startedAt,
      endedAt: terminalAgentStatuses.has(status) ? at : agent.endedAt,
      agentSessionId: agent.agentSessionId ?? agentSessionId,
      // block 摘要只在 blocked 节点有意义。被取消、中断或完成后不得继续向
      // CLI/Web 暴露已经失效的人工协助请求。
      block: status === "blocked" ? agent.block : null,
    };
    this.#agents.set(nodeId, updated);
  }

  #applyBlockCreated(event: Extract<JournalEvent, { type: "block.created" }>): void {
    if (!event.nodeId || !event.agentSessionId) throw new Error("block.created 缺少节点或会话身份。");
    const agent = this.#agents.get(event.nodeId);
    if (!agent || agent.status !== "running" || agent.agentSessionId !== event.agentSessionId) throw new Error("block.created 必须属于当前 running 的原 Agent 会话。");
    if (agent.block) throw new Error("同一 Agent 不能同时创建多个 block。");
    this.#applyAgentStatus(event.nodeId, "blocked", event.at, event.diagnostic, null, event.agentSessionId);
    this.#agents.set(event.nodeId, { ...this.#agents.get(event.nodeId)!, block: { blockRequestId: event.blockRequestId, needHelp: event.needHelp, answered: false } });
    this.#blockSchemas.set(event.blockRequestId, event.answerSchema);
  }

  #applyBlockAnswered(event: Extract<JournalEvent, { type: "block.answered" }>): void {
    if (!event.nodeId || !event.agentSessionId) throw new Error("block.answered 缺少节点或会话身份。");
    const agent = this.#agents.get(event.nodeId);
    if (!agent || agent.status !== "blocked" || agent.agentSessionId !== event.agentSessionId || agent.block?.blockRequestId !== event.blockRequestId) throw new Error("block.answered 不属于当前 pending block。");
    validateBlockAnswer(this.#blockSchemas.get(event.blockRequestId), event.answer);
    this.#agents.set(event.nodeId, { ...agent, block: { ...agent.block, answered: true } });
  }

  #applyBlockContinued(event: Extract<JournalEvent, { type: "agent.continued" }>): void {
    if (!event.nodeId || !event.agentSessionId) throw new Error("agent.continued 缺少节点或会话身份。");
    const agent = this.#agents.get(event.nodeId);
    if (!agent || agent.status !== "blocked" || agent.agentSessionId !== event.agentSessionId || agent.block?.blockRequestId !== event.blockRequestId || !agent.block.answered) throw new Error("agent.continued 不属于已回答的 pending block。");
    this.#applyAgentStatus(event.nodeId, "running", event.at, event.diagnostic, null, event.agentSessionId);
    this.#blockSchemas.delete(event.blockRequestId);
  }

  #applyRunStatus(status: RunStatus, at: string, diagnostic: string | null): void {
    if (this.#status !== "running") throw new Error(`非法 Run 状态转移：${this.#status} → ${status}`);
    if (status === "completed" && [...this.#agents.values()].some((agent) => agent.status !== "completed")) throw new Error("Run completed 前所有 Agent 必须完成。");
    this.#status = status;
    this.#diagnostic = diagnostic;
    this.#endedAt = at;
  }
}

function canTransition(from: AgentNodeStatus, to: AgentNodeStatus): boolean {
  if (from === "queued") return to === "running" || to === "cancelled" || to === "interrupted";
  if (from === "running") return to === "blocked" || terminalAgentStatuses.has(to);
  if (from === "blocked") return to === "running" || terminalAgentStatuses.has(to);
  return false;
}

function cloneAgent(agent: AgentNodeSnapshot): AgentNodeSnapshot {
  return { ...agent, request: { ...agent.request, input: agent.request.input ? { ...agent.request.input } : undefined } };
}

function sameRequest(left: import("../shared/workflow-types").NormalizedAgentRequest, right: import("../shared/workflow-types").NormalizedAgentRequest): boolean {
  return canonical(left) === canonical(right);
}

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 重开 Journal 时必须重新验证答案，防止篡改 block.answered 绕过原 answer-schema。 */
function validateBlockAnswer(schema: JsonSchema | undefined, answer: import("../shared/json").JsonObject): void {
  if (!schema) return;
  const validator = new Ajv({ allErrors: true, strict: false }).compile(schema);
  if (!validator(answer)) throw new Error(`block.answered 结果不符合 answer-schema：${new Ajv({ allErrors: true, strict: false }).errorsText(validator.errors)}`);
}
