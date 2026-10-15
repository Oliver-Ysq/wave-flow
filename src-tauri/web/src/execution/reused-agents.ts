import type { AgentSnapshot, PhaseVisit } from "../types";

/**
 * 一个 Phase 标题下"历史访问已交付、当前 attempt 未重跑、结果被 replay 复用"的节点组。
 * 数据全部来自耐久 phaseVisit / agent 事实，不从 TypeScript 控制流推断归属。
 */
export type ReusedAgentGroup = {
  /** Phase 标题（与 meta 声明一致）。 */
  readonly title: string;
  /** 交付这些节点的历史访问所属 attempt。 */
  readonly sourceAttemptId: number;
  /** 交付这些节点的历史访问是该标题的第几次访问。 */
  readonly sourceOccurrence: number;
  /** 被复用的 completed 节点（按访问内顺序）。 */
  readonly agents: readonly AgentSnapshot[];
};

/**
 * 计算当前 attempt 视野下每个 Phase 的复用节点组：
 * 对每个 Phase 标题，取早于当前 attempt 的最近一次耐久访问，其中 completed 且
 * 当前 attempt 未重新创建同名节点的 Agent 即为被 replay 复用的节点。
 * 非 completed 的历史节点（interrupted/cancelled）不是可复用结果，不进入分组。
 */
export function computeReusedAgents(
  allVisits: readonly PhaseVisit[],
  currentAttemptId: number,
): ReadonlyMap<string, ReusedAgentGroup> {
  const currentAgentIds = new Set<string>();
  for (const visit of allVisits) {
    if (visit.executionAttemptId !== currentAttemptId) continue;
    for (const batch of visit.batches) {
      for (const agent of batch.agents) currentAgentIds.add(agent.id);
    }
  }
  const groups = new Map<string, ReusedAgentGroup>();
  const priorVisits = [...allVisits]
    .filter((visit) => visit.executionAttemptId < currentAttemptId)
    .sort((left, right) =>
      left.executionAttemptId === right.executionAttemptId
        ? left.phaseVisitId - right.phaseVisitId
        : left.executionAttemptId - right.executionAttemptId,
    );
  // 同一标题只采用最近一次历史访问：它才是当前 attempt replay 时的可复用来源。
  const latestByTitle = new Map<string, PhaseVisit>();
  for (const visit of priorVisits) latestByTitle.set(visit.title, visit);
  for (const [title, visit] of latestByTitle) {
    const agents = visit.batches
      .flatMap((batch) => batch.agents)
      .filter((agent) => agent.status === "completed" && !currentAgentIds.has(agent.id));
    if (agents.length === 0) continue;
    groups.set(title, {
      title,
      sourceAttemptId: visit.executionAttemptId,
      sourceOccurrence: visit.occurrence,
      agents,
    });
  }
  return groups;
}
