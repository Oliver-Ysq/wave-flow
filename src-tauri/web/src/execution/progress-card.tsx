import type { RunSnapshot } from "../types";
import { computeExecutionProgress } from "./execution-progress";

/** 节点状态在待办卡上的展示文案与修饰类。 */
function itemMark(status: string): { text: string; className: string } {
  switch (status) {
    case "completed":
      return { text: "已完成", className: "completed" };
    case "running":
    case "recovering":
      return { text: "进行中", className: "running" };
    case "blocked":
      return { text: "等待输入", className: "blocked" };
    case "cancelled":
      return { text: "已停止", className: "stopped" };
    case "interrupted":
      return { text: "已中断", className: "stopped" };
    case "pausing":
    case "paused":
      return { text: "已暂停", className: "pending" };
    default:
      return { text: "排队中", className: "pending" };
  }
}

/**
 * 待办卡：执行进度勾选清单。数据与团队面板同源（同一个 Run 权威快照），
 * 不另发请求；动态节点只以"数量待定"提示，不伪造分母或百分比。
 */
export function ExecutionProgressCard({
  snapshot,
  dynamicCount = 0,
  plannedTotal,
  allVisits,
}: {
  /** 当前 Execution/Run 的权威快照。 */
  snapshot: RunSnapshot;
  /** 该 revision 静态无法枚举的动态节点数；0 表示无动态节点。 */
  dynamicCount?: number;
  /** 计划静态枚举的 Worker 总数（执行配置快照的 assignments 数）；未知时不传。 */
  plannedTotal?: number;
  /** 已读取的全部耐久访问；用于标明历史完成节点，不触发执行或授权 replay。 */
  allVisits?: RunSnapshot["phaseVisits"];
}) {
  const progress = computeExecutionProgress(snapshot, plannedTotal, allVisits);
  return (
    <section className="wf-progress-card" aria-label="执行进度">
      <header>
        <strong>
          {dynamicCount > 0
            ? `${progress.completed} 完成 · 动态节点数量待定`
            : `${progress.completed}/${progress.total} 完成`}
        </strong>
        {dynamicCount > 0 && (
          <small>静态节点共 {progress.total} 个；动态节点在执行时确定</small>
        )}
        {dynamicCount === 0 && !progress.totalFromPlan && (
          <small>分母为已创建节点；计划总数未提供</small>
        )}
      </header>
      <ul>
        {progress.items.map((item) => {
          const mark = itemMark(item.status);
          return (
            <li key={item.id} className={mark.className}>
              <span className="wf-progress-check" aria-hidden="true">
                {item.status === "completed" ? "✓" : ""}
              </span>
              <span className="wf-progress-label">{item.label}</span>
              <em>{mark.text}</em>
            </li>
          );
        })}
        {progress.items.length === 0 && <li className="pending">尚未创建节点</li>}
      </ul>
    </section>
  );
}
