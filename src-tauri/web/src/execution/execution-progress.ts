import type { AgentStatus, RunSnapshot } from "../types";

/** 待办卡中的一个静态枚举 Agent 节点条目。 */
export type ExecutionProgressItem = {
  /** Run 内稳定节点 id。 */
  id: string;
  /** 面向界面展示的节点名称。 */
  label: string;
  /** 节点当前权威状态（直接来自快照投影，不做本地推断）。 */
  status: AgentStatus;
};

/** 执行进度汇总：completed 只统计 completed 节点，total 为静态枚举节点总数。 */
export type ExecutionProgress = {
  /** 按 Phase 声明顺序、批次顺序排列的全部已创建节点。 */
  items: ExecutionProgressItem[];
  /** 状态为 completed 的节点数。 */
  completed: number;
  /** 真实分母：计划静态枚举的 Worker 总数（含尚未创建的节点）；未知时为已创建节点数。 */
  total: number;
  /** 真实分母是否来自计划静态枚举；false 表示只能证明已创建节点数。 */
  totalFromPlan: boolean;
};

/**
 * 从 Run 权威快照统计执行进度。
 * 已创建节点按快照投影逐一列出；分母优先取调用方提供的计划静态 Worker 数
 * （执行配置快照的 assignments 数），否则退化为已创建节点数并标 totalFromPlan=false，
 * 绝不把"已创建节点数"伪装成全部计划节点数。
 */
export function computeExecutionProgress(
  snapshot: RunSnapshot,
  plannedTotal?: number,
): ExecutionProgress {
  const items: ExecutionProgressItem[] = [];
  for (const phase of snapshot.phases) {
    for (const batch of phase.batches) {
      for (const agent of batch.agents) {
        items.push({ id: agent.id, label: agent.label, status: agent.status });
      }
    }
  }
  const fromPlan = plannedTotal !== undefined && plannedTotal >= items.length;
  return {
    items,
    completed: items.filter((item) => item.status === "completed").length,
    total: fromPlan ? plannedTotal : items.length,
    totalFromPlan: fromPlan,
  };
}
