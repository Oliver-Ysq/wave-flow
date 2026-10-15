import type { HarnessSnapshot, WorkflowExecution, WorkflowRevision } from "../types";
import {PersistedDetails} from "../persisted-details";

/** 原版本的展示状态；只派生耐久证据，不提供启动授权。 */
export function revisionSummaryState(task: HarnessSnapshot, revision: WorkflowRevision): { status: string; supersededBy?: number } {
  const newer = revision.cardId ? task.workflowRevisions.filter(item => item.cardId === revision.cardId && item.revision > revision.revision).at(-1) : undefined;
  if (revision.abandonedAt) return { status: "已放弃" };
  if (newer) return { status: `已被第 ${newer.revision} 版替代`, supersededBy: newer.revision };
  if (task.executions.some(item => item.revision === revision.revision)) return { status: "已执行" };
  if (revision.rejectedAt) return { status: "已拒绝，等待修改" };
  return { status: revision.acceptedAt ? "已接受，尚未运行" : "待确认" };
}

/** 方案轻量摘要；只打开原版本，不接受、创建执行或读取重型详情。 */
export function WorkflowProposalSummary({ task, revision, onOpen }: {
  /** 所属任务的耐久投影。 */
  task: HarnessSnapshot;
  /** 事件绑定的原版本，不自动替换为最新版。 */
  revision: WorkflowRevision;
  /** 仅导航到原方案。 */
  onOpen: () => void;
}) {
  const state = revisionSummaryState(task, revision);
  const content = <div className="wf-summary-body">
    <p>{revision.scope || "历史方案未保存独立范围，可打开原方案查看。"}</p>
    {revision.preview ? <>
      <div className="wf-summary-phases" aria-label="声明阶段">{revision.preview.phaseTitles.map(title => <span key={title}>{title}</span>)}</div>
      <small>{revision.preview.phaseTitles.length} 个声明阶段 · {revision.preview.previewAgents.length} 处 Worker 调用示意{revision.preview.previewAgents.some(agent => agent.loop) ? " · 含循环或批量调用" : ""}</small>
      <small>源码示意，实际执行以运行时为准</small>
    </> : <small>历史预览不可用</small>}
  </div>;
  return <article className={`wf-chat-summary ${state.supersededBy ? "historical" : ""}`} aria-label={`工作流方案第 ${revision.revision} 版`}>
    <header><span>{revision.parentRevision ? "方案已更新" : "方案已生成"}</span><span>第 {revision.revision} 版</span></header>
    <h3>{revision.goal || "历史工作流方案"}</h3>
    {state.supersededBy ? <PersistedDetails identity={`${task.harnessRunId}:${revision.cardId}:${revision.revision}:summary`}><summary>展开历史方案摘要</summary>{content}</PersistedDetails> : content}
    <footer><span>{state.status}</span><button onClick={onOpen} aria-label={`查看第 ${revision.revision} 版方案`}>{state.supersededBy ? "查看原方案" : "查看方案"}<span aria-hidden="true"> ↗</span></button></footer>
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
  const labels: Record<WorkflowExecution["status"], string> = { running:"正在执行", paused:"已暂停", pausing:"正在暂停", recovering:"正在恢复", completed:"执行已完成", cancelled:"执行已停止", interrupted:"执行已中断" };
  const excerpt = executionResultExcerpt(execution.summary);
  return <article className="wf-chat-summary execution" aria-label="工作流执行摘要">
    <header><span>{execution.status==="running"?"工作流已启动":"执行记录"}</span><span>基于第 {execution.revision} 版{attempt?` · 第 ${attempt} 次尝试`:""}</span></header>
    <h3>{revision?.goal || "历史工作流执行"}</h3>
    {excerpt ? <p className="wf-summary-result">{excerpt}</p> : <p>{execution.diagnostic || "尚无结果摘要，可查看执行进度与记录。"}</p>}
    <footer><span>{labels[execution.status]}</span><button onClick={onOpen}>查看执行<span aria-hidden="true"> ↗</span></button></footer>
    {execution.status === "completed" && <small>执行完成不代表任务目标已验收</small>}
  </article>;
}
