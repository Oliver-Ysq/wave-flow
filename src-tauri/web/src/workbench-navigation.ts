import type { HarnessSnapshot, WorkflowRevision } from "./types";
/** 中央视图身份，不构成批准或控制授权。 */
export type WorkbenchRoute = { kind: "conversation" } | { kind: "workflow"; taskId: string; cardId: string; revision: number; section: "plan" | "execution" | "results"; executionId?: string; attempt?: number };
/** 每卡一个导航项；历史缺卡只读投影，不猜跨版本归属。 */
export function workflowCells(task: HarnessSnapshot): WorkflowRevision[] {
  const cells = new Map<string, WorkflowRevision>();
  for (const revision of task.workflowRevisions) cells.set(revision.cardId ?? `legacy:${revision.revision}`, revision);
  return [...cells.values()];
}
/** 展示资格，最终仍由 Engine 拒绝非法动作。 */
export function editableRevision(task: HarnessSnapshot, revision: WorkflowRevision): boolean {
  return !!task.task && !!revision.cardId && task.status === "idle" && !task.executions.some(item=>item.finishedAt===null||task.workflowRevisions.find(version=>version.revision===item.revision)?.cardId===revision.cardId) && !revision.abandonedAt && task.workflowRevisions.filter(item=>item.cardId === revision.cardId).at(-1)?.revision === revision.revision;
}
/** 单链任务（workflowContract==="single-workflow-v1"）侧栏唯一 Workflow 子项：该链最新 revision；旧多卡任务或无修订时为 null，调用方保持原多卡导航。 */
export function singleChainCell(task: HarnessSnapshot): WorkflowRevision | null {
  if (task.task?.workflowContract !== "single-workflow-v1") return null;
  return task.workflowRevisions.at(-1) ?? null;
}
