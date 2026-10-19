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
export function WorkflowExecutionSummary({ execution, revision, onOpen,attempt }: {
  /** 原执行登记，未读取节点详情。 */
  execution: WorkflowExecution;
  /** 原执行冻结的方案；历史缺失时不猜归属。 */
  revision?: WorkflowRevision;
  /** 仅打开所属执行。 */
  onOpen: () => void;
  /** 原历史事件尝试号；未知不推断。 */
  attempt?:number;
}) {
  const labels: Record<WorkflowExecution["status"], string> = { running:"已启动", paused:"已暂停", pausing:"正在暂停", recovering:"正在恢复", completed:"执行结束", cancelled:"已停止", interrupted:"已中断" };
  return <p className="task-event">历史记录：{labels[execution.status]} · <button onClick={onOpen}>{revision ? proposalTitle(revision) : "查看执行"}</button></p>;
}
