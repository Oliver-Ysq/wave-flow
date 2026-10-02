import type { JournalEvent, RunManifest } from "../journal/types";
import type { AgentNodeSnapshot, AgentNodeStatus, PhaseSnapshot, RunSnapshot, RunStatus } from "./run-types";

const terminalAgentStatuses = new Set<AgentNodeStatus>(["completed", "failed", "cancelled", "interrupted"]);

/** 由 Journal 事实驱动的内存查询投影；不直接执行 Agent 或写文件。 */
export class RunStateMachine {
  #created = false;
  #status: RunStatus = "running";
  #diagnostic: string | null = null;
  #endedAt: string | null = null;
  #agents = new Map<string, AgentNodeSnapshot>();

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
      case "agent.status":
        this.#applyAgentStatus(event.nodeId, event.status, event.at, event.diagnostic);
        return;
      case "agent.completed":
        this.#applyAgentStatus(event.nodeId, "completed", event.at, null, event.result);
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
      cwd: this.manifest.cwd,
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
      request: event.request,
    });
  }

  #applyAgentStatus(nodeId: string | null, status: AgentNodeStatus, at: string, diagnostic: string | null, result: AgentNodeSnapshot["result"] = null): void {
    if (!nodeId) throw new Error("Agent 状态事件缺少 nodeId。");
    const agent = this.#agents.get(nodeId);
    if (!agent) throw new Error(`未知 Agent 节点：${nodeId}`);
    if (!canTransition(agent.status, status)) throw new Error(`非法 Agent 状态转移：${agent.status} → ${status}`);
    const updated: AgentNodeSnapshot = {
      ...agent,
      status,
      result,
      diagnostic,
      startedAt: status === "running" && agent.startedAt === null ? at : agent.startedAt,
      endedAt: terminalAgentStatuses.has(status) ? at : agent.endedAt,
    };
    this.#agents.set(nodeId, updated);
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
  if (from === "running") return to === "waiting_for_input" || terminalAgentStatuses.has(to);
  if (from === "waiting_for_input") return to === "running" || terminalAgentStatuses.has(to);
  return false;
}

function cloneAgent(agent: AgentNodeSnapshot): AgentNodeSnapshot {
  return { ...agent, request: { ...agent.request, input: agent.request.input ? { ...agent.request.input } : undefined } };
}
