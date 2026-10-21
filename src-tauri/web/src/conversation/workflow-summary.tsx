import type { HarnessSnapshot, WorkflowExecution, WorkflowRevision } from "../types";
import {PersistedDetails} from "../persisted-details";
import {AbandonedPlan} from "./abandoned-plan";
import {useId,useState} from "react";
import {visibleVersion} from './workflow-versions';

/** 不把完整业务目标当标题；不调用模型，也不截取片段冒充语义摘要。 */
export function proposalTitle(revision:WorkflowRevision):string {
  const description=revision.localOrigin?.meta?.description??revision.templateOrigin?.meta?.description??revision.preview?.description;
  if(description&&Array.from(description).length<=40)return description;
  const name=revision.localOrigin?.meta?.name??revision.templateOrigin?.meta?.name??revision.preview?.workflowName;
  if(name&&Array.from(name).length<=40)return name;
  return revision.goal&&Array.from(revision.goal).length<=40?revision.goal:"工作流方案";
}

/** 原版本的展示状态；只派生耐久证据，不提供启动授权。 */
export function revisionSummaryState(task: HarnessSnapshot, revision: WorkflowRevision): { status: string; supersededBy?: number } {
  const newer = revision.cardId ? task.workflowRevisions.filter(item => item.cardId === revision.cardId && item.revision > revision.revision).at(-1) : undefined;
  if (revision.abandonedAt) return { status: "已放弃" };
  if (newer) return { status: `已被第 ${visibleVersion(task,newer)} 版替代`, supersededBy: newer.revision };
  if (task.executions.some(item => item.revision === revision.revision)) return { status: "已执行" };
  if (revision.rejectedAt) return { status: "已拒绝，等待修改" };
  return { status: revision.acceptedAt ? "已接受，尚未运行" : "待确认" };
}

/** 方案轻量摘要；只打开原版本，不接受、创建执行或读取重型详情。 */
export function WorkflowProposalSummary({ task, revision, onOpen, onAdjust, onTemplate }: {
  /** 所属任务的耐久投影。 */
  task: HarnessSnapshot;
  /** 事件绑定的原版本，不自动替换为最新版。 */
  revision: WorkflowRevision;
  /** 仅导航到原方案。 */
  onOpen: () => void;
  /** 聚焦原Task对话并绑定当前版本；不发送、不批准或执行。 */
  onAdjust?: () => void;
  /** 首次执行前选择预置；仅最新已放弃方案展示。 */ onTemplate?:()=>void;
}) {
  const state = revisionSummaryState(task, revision);
  const abandoned=!!revision.abandonedAt;
  const latest=task.workflowRevisions.at(-1)?.revision===revision.revision;
  const [expanded,setExpanded]=useState(false);
  const bodyId=useId();
  const title=proposalTitle(revision);
  const content = <div className="wf-summary-body">
    <div id={bodyId}>
      {expanded&&revision.goal&&revision.goal!==title&&<p><strong>完整目标：</strong>{revision.goal}</p>}
      <p className={expanded?undefined:"wf-summary-clamp"}>{revision.scope || "范围说明未提供，可打开方案查看。"}</p>
    </div>
    <button type="button" className="wf-summary-expand" aria-expanded={expanded} aria-controls={bodyId} onClick={()=>setExpanded(value=>!value)}>{expanded?"收起":"展开"}</button>
    {revision.preview ? <>
      <div className="wf-summary-phases" aria-label="声明阶段">{revision.preview.phaseTitles.map(title => <span key={title}>{title}</span>)}</div>
      <small>{revision.preview.phaseTitles.length} 个阶段 · {revision.preview.previewAgents.length} 处调用示意{expanded&&revision.preview.previewAgents.some(agent => agent.loop) ? " · 含循环或批量调用" : ""}</small>
      <small>源码示意，实际执行以运行时为准</small>
    </> : <small>历史预览不可用</small>}
  </div>;
  return <article className={`wf-chat-summary proposal ${state.supersededBy ? "historical" : ""}`} aria-label={visibleVersion(task,revision)?`工作流方案第 ${visibleVersion(task,revision)} 版`:'工作流方案'}>
    <header><span>{revision.parentRevision ? "方案已更新" : "方案已生成"}</span>{visibleVersion(task,revision)&&<span>第 {visibleVersion(task,revision)} 版</span>}</header>
    <h3>{title}</h3>
    {state.supersededBy||abandoned ? <PersistedDetails identity={`${task.harnessRunId}:${revision.cardId}:${revision.revision}:${abandoned?"abandoned":"summary"}`}><summary>{abandoned?"展开已放弃方案摘要":"展开历史方案摘要"}</summary>{content}</PersistedDetails> : content}
    {!state.supersededBy&&!revision.abandonedAt&&!revision.localOrigin&&onAdjust&&<small>可直接对话调整方案</small>}
    <footer><span>{state.status}</span>{!state.supersededBy&&!revision.abandonedAt&&!revision.localOrigin&&onAdjust&&<button type="button" onClick={onAdjust} disabled={task.status!=="idle"||task.executions.some(item=>item.finishedAt===null)}>通过对话调整</button>}<button onClick={onOpen} className={state.status==="待确认"||state.status==="已接受，尚未运行" ? "button-primary" : undefined} aria-label={visibleVersion(task,revision)?`查看第 ${visibleVersion(task,revision)} 版方案`:'查看方案'}>{state.supersededBy||abandoned ? "查看原方案" : state.status==="待确认"||state.status==="已接受，尚未运行" ? "去确认方案" : "查看方案"}<span aria-hidden="true"> ↗</span></button></footer>
    {abandoned&&latest&&onAdjust&&task.status!=="completed"&&<AbandonedPlan onRedesign={onAdjust} onTemplate={!task.executions.length?onTemplate:undefined} disabled={task.status!=="idle"||task.executions.some(item=>item.finishedAt===null)}/>}
  </article>;
}

/** 有界原结果摘要；不生成验收结论，也不递归展开完整结果。 */
export function executionResultExcerpt(result: WorkflowExecution["summary"]): string | null {
  if (result === null) return null;
  const text = JSON.stringify(result);
  return text.length > 240 ? `${text.slice(0,240)}…（查看完整结果）` : text;
}

/** 执行摘要与方案摘要采用同一信息层级；状态来自原 Execution。 */
export function WorkflowExecutionSummary({ execution, revision, onOpen, onOpenResults, attempt, version, featured=false }: {
  /** 原执行登记，未读取节点详情。 */
  execution: WorkflowExecution;
  /** 原执行冻结的方案；历史缺失时不猜归属。 */
  revision?: WorkflowRevision;
  /** 运行中进入进度；终态默认进入原执行页。 */
  onOpen: () => void;
  /** 终态直接打开结果页；缺失时退回执行页。 */
  onOpenResults?: () => void;
  /** 原历史事件尝试号；未知不推断。 */
  attempt?:number;
  /** 展示用方案版本序号；仅多版本时提供，不参与执行身份。 */
  version?:number|null;
  /** 是否为最近一次执行；只有最近一次用卡片，旧执行保持一行历史。 */
  featured?:boolean;
}) {
  const labels: Record<WorkflowExecution["status"], string> = { running:"已启动", paused:"已暂停", pausing:"正在暂停", recovering:"正在恢复", completed:"执行结束", cancelled:"已停止", interrupted:"已中断" };
  const title = revision ? proposalTitle(revision) : "查看执行";
  const statusLabel = labels[execution.status];
  const live = execution.status === "running" || execution.status === "recovering";
  const active = live || execution.status === "paused" || execution.status === "pausing";
  const finished = !active;
  // 最近一次执行无论进行中还是已结束都保持同一张卡片，避免结束后再出现一条重复的历史记录。
  if (featured || execution.status === "running") {
    const meta = [statusLabel, version ? `第 ${version} 版方案` : null, attempt && attempt > 1 ? `第 ${attempt} 次尝试` : null].filter(Boolean).join(" · ");
    const action = finished ? (execution.status === "completed" ? "查看结果" : "查看记录") : "查看进度";
    const tone = execution.status === "completed" ? "success" : execution.status === "interrupted" ? "interrupted" : execution.status === "cancelled" ? "cancelled" : active ? "active" : "neutral";
    const open = finished && execution.status === "completed" && onOpenResults ? onOpenResults : onOpen;
    return <button type="button" className={`execution-live-card ${live ? "is-live" : "is-finished"} status-${tone}`} onClick={open} aria-label={`${action}：${title}（${meta}）`}>
      <span className="execution-live-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M12 3v3.2" />
          <rect x="4.4" y="6.8" width="15.2" height="11.4" rx="3.2" />
          <circle cx="9.1" cy="12.2" r="1" />
          <circle cx="14.9" cy="12.2" r="1" />
          <path d="M9.6 15.7h4.8" />
        </svg>
      </span>
      <span className="execution-live-copy">
        <strong>{title}</strong>
        <small><i className="execution-live-dot" aria-hidden="true" />{meta}</small>
      </span>
      <span className="execution-live-action" aria-hidden="true">{action} <span>→</span></span>
    </button>;
  }
  return <p className="task-event">历史记录：{statusLabel} · <button onClick={onOpen}>{title}</button></p>;
}

export type ExecutionHistoryEntry = NonNullable<HarnessSnapshot["executionHistory"]>[number];
/** 同一执行会同时留下 created 与 finished 历史；只保留最新一条，避免“已启动”卡片在结束后残留。 */
export function latestExecutionEntries(task: HarnessSnapshot): ExecutionHistoryEntry[] {
  const byExecution = new Map<string, ExecutionHistoryEntry>();
  for (const item of task.executionHistory ?? []) {
    const current = byExecution.get(item.executionId);
    if (!current || Date.parse(item.at) >= Date.parse(current.at)) byExecution.set(item.executionId, item);
  }
  return [...byExecution.values()].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}
