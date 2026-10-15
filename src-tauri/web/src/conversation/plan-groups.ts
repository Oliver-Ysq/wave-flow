import type { ExecutionPlanResponse } from "../types";

/** 草案预览分组；稳定 key 区分真实标题与无法确定归属的兜底组。 */
export type PlanPhaseGroup = {
  /** React 列表身份；不作为业务 ID。 */
  key: string;
  /** 阶段标题；兜底组显示“归属待运行时确定”。 */
  title: string;
  /** 组内 Agent 按源码出现顺序排列，不表示必定执行。 */
  workers: ExecutionPlanResponse["previewAgents"];
};

/** 按已校验阶段词表分组；不执行脚本、不画依赖、不丢弃未知归属节点。 */
export function groupWorkersByPhase(phaseTitles: readonly string[], workers: ExecutionPlanResponse["previewAgents"]): PlanPhaseGroup[] {
  const byTitle = new Map<string | null, ExecutionPlanResponse["previewAgents"]>();
  for (const worker of workers) {
    const key = worker.phaseTitle ?? null;
    const bucket = byTitle.get(key) ?? [];
    bucket.push(worker);
    byTitle.set(key, bucket);
  }
  const groups: PlanPhaseGroup[] = [];
  for (const title of phaseTitles) {
    const bucket = byTitle.get(title);
    if (bucket?.length) groups.push({ key: `phase:${title}`, title, workers: bucket });
    byTitle.delete(title);
  }
  for (const [title, bucket] of byTitle) {
    groups.push({ key: title === null ? "unknown" : `phase:${title}`, title: title ?? "归属待运行时确定", workers: bucket });
  }
  return groups;
}
