import { useRef,useState } from "react";
import {HistorySidebar} from "./history-sidebar";
import type { HarnessSnapshot, WorkflowExecution, WorkflowRevision } from "../types";
import { proposalTitle } from "./workflow-summary";
import { visibleVersion } from "./workflow-versions";

/** 原执行状态的人话名称；不以总结成功推断目标验收。 */
export function executionLabel(execution: WorkflowExecution): string {
  return { running: "执行中", paused: "已暂停", pausing: "正在暂停", recovering: "正在恢复", completed: "执行结束", cancelled: "已停止", interrupted: "已中断" }[execution.status];
}

/** 未执行方案的状态；实际执行过的方案不会归为废弃。 */
export function proposalLabel(task: HarnessSnapshot, revision: WorkflowRevision): string {
  if (task.executions.some(item => item.revision === revision.revision)) return "已用于执行";
  if (revision.abandonedAt) return "已放弃 · 未执行";
  if (task.workflowRevisions.at(-1)?.revision !== revision.revision) return "已被取代 · 未执行";
  if (revision.rejectedAt) return "需要修改 · 未执行";
  return revision.acceptedAt ? "已确认 · 未执行" : "待确认 · 未执行";
}

/** 只展示该执行最新尝试的总结状态；旧尝试的中断不冒充当前待办。 */
export function currentExecutionSummaries(task: HarnessSnapshot, executionId: string) {
  const summaries = task.impactSummaries?.filter(item => item.executionId === executionId && !item.supersededBy) ?? [];
  const attempts = [...summaries.map(item => item.attempt), ...(task.executionHistory ?? []).filter(item => item.executionId === executionId).map(item => item.attempt ?? 1)];
  const latestAttempt = Math.max(1, ...attempts);
  return summaries.filter(item => item.attempt === latestAttempt);
}

/** 仅未结束执行的回答请求属于当前待办；历史attention保留但不触发提醒。 */
export function hasActiveExecutionQuestions(task: HarnessSnapshot): boolean {
  return task.executions.some(execution => {
    const attention = task.executionAttention?.[execution.executionId];
    return execution.finishedAt === null && Boolean(attention && attention.workerRequests + attention.scriptGates > 0);
  });
}

/** 与后台总结门禁一致，保留所有未被替代的中断义务；归档只读不再提醒重试。 */
export function interruptedSummaryObligations(task: HarnessSnapshot) {
  return task.status === "completed" ? [] : task.impactSummaries?.filter(item => !item.supersededBy && item.status === "interrupted") ?? [];
}

/** 总结提示对应原执行的工作名，不套用当前方案。 */
export function summaryWorkLabel(task: HarnessSnapshot, executionId: string): string {
  const execution = task.executions.find(item => item.executionId === executionId);
  const revision = execution && task.workflowRevisions.find(item => item.revision === execution.revision);
  return revision ? proposalTitle(revision) : "历史执行";
}

/** 当前信息与历史只投影原档案；浏览不批准、恢复或改变执行。 */
export function TaskActivity({ task, visible=true, onPlan, onExecution, onResults, onAdjust, onTemplate }: {
  /** 对话当前可见性；打开详情时隐藏历史，返回恢复原阅读状态。 */ visible?:boolean;
  /** 当前任务权威快照；不建立第二套业务状态。 */ task: HarnessSnapshot;
  /** 打开指定冻结方案，保留原版本身份。 */ onPlan: (revision: WorkflowRevision) => void;
  /** 打开指定执行的过程，不自动恢复。 */ onExecution: (executionId: string) => void;
  /** 打开指定执行的结果与总结，不自动重试。 */ onResults: (executionId: string) => void;
  /** 聚焦当前方案的对话调整，不发送。 */ onAdjust: (revision: WorkflowRevision) => void;
  /** 首次执行前重选预置，沿用现有来源门禁。 */ onTemplate: () => void;
}) {
  const [history, setHistory] = useState(false);
  const historyButton=useRef<HTMLButtonElement>(null);
  const closeHistory=()=>{setHistory(false);requestAnimationFrame(()=>historyButton.current?.focus());};
  const openRecord=(action:()=>void)=>{action();};
  const latest = task.workflowRevisions.at(-1);
  const execution = latest && task.executions.find(item => item.revision === latest.revision);
  const active = task.executions.find(item => item.finishedAt === null);
  const current = active ?? execution;
  const revision = active ? task.workflowRevisions.find(item => item.revision === active.revision) : latest;
  const summaries = current ? currentExecutionSummaries(task, current.executionId) : [];
  const summary = summaries.find(item => item.status !== "completed" && item.status !== "cancelled");
  const attention = current && task.executionAttention?.[current.executionId];
  const needsAnswer = current?.finishedAt === null && attention && attention.workerRequests + attention.scriptGates > 0;
  const state = current ? needsAnswer ? "需要你的回答" : current.finishedAt && summary ? summary.status === "interrupted" ? "总结未完成" : summary.status === "pending" ? "准备总结" : "正在总结" : executionLabel(current) : revision ? proposalLabel(task, revision).replace(" · 未执行", "") : task.status === "running" ? "正在准备方案" : "尚无方案";
  const ended = Boolean(current?.finishedAt);
  const canAdjust = revision && !revision.localOrigin && !execution && !active && task.status === "idle";
  const revisionVersion = revision ? visibleVersion(task, revision) : null;
  // 只有“待确认”的方案才把主按钮文案改成去确认；执行中/已确认仍叫查看方案。
  const pendingRevision = !current && state === "待确认";
  const planActionLabel = revision?.abandonedAt
    ? "查看原方案"
    : pendingRevision
      ? `去确认方案${revisionVersion ? `（第 ${revisionVersion} 版）` : ""}`
      : "查看方案";
  return <section className="task-activity" aria-label="当前工作与历史">
    <div className="task-current">
      <div className="task-current-copy"><strong>{revision ? proposalTitle(revision) : "通过对话描述目标"}</strong>{!current && revision ? <button type="button" className="task-state" title="查看当前方案" aria-label={`查看当前方案（${state}）`} onClick={() => onPlan(revision)}><span role="status">{state}</span></button> : <span role="status">{state}</span>}</div>
      <div className="task-current-actions">
        {current ? <button className="button-primary" onClick={() => needsAnswer || !ended ? onExecution(current.executionId) : onResults(current.executionId)}>{needsAnswer ? "去回答" : ended ? "查看结果" : "查看进度"}</button> : revision && <button className="button-primary" onClick={() => onPlan(revision)}>{planActionLabel}</button>}
        {canAdjust && <button onClick={() => onAdjust(revision)}>{revision.abandonedAt ? "重新设计" : "调整"}</button>}
        {revision?.abandonedAt && !task.executions.length && task.status !== "completed" && <button onClick={onTemplate}>选择预置</button>}
        <button ref={historyButton} aria-expanded={history} onClick={() => history?closeHistory():setHistory(true)}>历史{task.executions.length ? ` · ${task.executions.length}` : ""}</button>
      </div>
    </div>
    {history&&visible&&<HistorySidebar task={task} onClose={closeHistory} onPlan={item=>openRecord(()=>onPlan(item))} onExecution={id=>openRecord(()=>onExecution(id))} onResults={id=>openRecord(()=>onResults(id))}/>}
  </section>;
}
