import type { HarnessSnapshot, WorkflowRevision } from "./types";
/** 中央视图身份，不构成批准或控制授权。 */
export type WorkbenchRoute = { kind: "conversation" } | { kind: "workflow"; taskId: string; cardId: string; revision: number; section: "plan" | "execution" | "results"; executionId?: string; attempt?: number };

/** 阅读尝试：未指定时跟随最新，合法历史值保持；非法/未来值回退最新，不产生恢复动作。 */
export function readingAttempt(selected: number | undefined, latest: number): number {
  return selected !== undefined && Number.isInteger(selected) && selected >= 1 && selected <= latest ? selected : latest;
}
/** 每卡一个导航项；历史缺卡只读投影，不猜跨版本归属。 */
export function workflowCells(task: HarnessSnapshot): WorkflowRevision[] {
  const cells = new Map<string, WorkflowRevision>();
  for (const revision of task.workflowRevisions) cells.set(revision.cardId ?? `legacy:${revision.revision}`, revision);
  return [...cells.values()];
}
/** 展示资格，最终仍由 Engine 拒绝非法动作。 */
export function editableRevision(task: HarnessSnapshot, revision: WorkflowRevision): boolean {
  return !!task.task && !!revision.cardId && task.status === "idle" && !task.executions.some(item=>item.finishedAt===null||(task.task?.workflowContract==="single-workflow-v1"?item.revision===revision.revision:task.workflowRevisions.find(version=>version.revision===item.revision)?.cardId===revision.cardId)) && !revision.abandonedAt && task.workflowRevisions.filter(item=>item.cardId === revision.cardId).at(-1)?.revision === revision.revision;
}
