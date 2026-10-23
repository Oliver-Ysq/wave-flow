import type { RunSnapshot } from "../types";
import { computeExecutionProgress } from "./execution-progress";

/**
 * 执行进度概览：完成度、冻结方案与分配叙事合并为一行；
 * 节点级状态只由下方 Phase/Agent 行表达，不再重复渲染 chips 清单。
 */
export function ExecutionProgressCard({
  snapshot,
  dynamicCount = 0,
  plannedTotal,
  allVisits,
  meta,
}: {
  /** 当前 Execution/Run 的权威快照。 */
  snapshot: RunSnapshot;
  /** 该 revision 静态无法枚举的动态节点数；0 表示无动态节点。 */
  dynamicCount?: number;
  /** 计划静态枚举的 Worker 总数（执行配置快照的 assignments 数）；未知时不传。 */
  plannedTotal?: number;
  /** 已读取的全部耐久访问；用于标明历史完成节点，不触发执行或授权 replay。 */
  allVisits?: RunSnapshot["phaseVisits"];
  /** 冻结方案版本、执行者数量与分配规则；与完成度同行展示。 */
  meta?: string;
}) {
  const progress = computeExecutionProgress(snapshot, plannedTotal, allVisits);
  /** 顶部只补当前动作，不堆节点清单；详细轨迹仍由下方 Phase/Agent 行承载。 */
  const terminal = ["completed", "cancelled", "interrupted"].includes(snapshot.status);
  const current = terminal ? undefined
    : progress.items.find((item) => ["running", "blocked", "paused", "pausing", "recovering"].includes(item.status))
      ?? (snapshot.status === "running" ? progress.items.find((item) => item.status === "queued") : undefined);
  const currentLabel = !current ? null
    : snapshot.status === "paused" || snapshot.status === "pausing" ? "已暂停"
    : snapshot.status === "recovering" ? "正在恢复"
    : current.status === "blocked" ? "等待你的回答"
    : current.status === "queued" ? "准备启动"
    : "正在执行";
  return (
    <section className="wf-progress-card" aria-label="执行进度">
      <header>
        <strong>
          {dynamicCount > 0
            ? `${progress.completed} 完成 · 动态节点数量待定`
            : `${progress.completed}/${progress.total} 完成`}
        </strong>
        {meta && <small>{meta}</small>}
        {dynamicCount > 0 && (
          <small>静态节点共 {progress.total} 个；动态节点在执行时确定</small>
        )}
        {dynamicCount === 0 && !progress.totalFromPlan && (
          <small>分母为已创建节点；计划总数未提供</small>
        )}
      </header>
      {current && (
        <p className="wf-progress-current" role="status">
          {currentLabel}：{current.label}
        </p>
      )}
    </section>
  );
}
