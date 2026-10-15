import { useEffect, useRef, useState } from "react";
import { ExecutionAssignmentFlow } from "../assignment-flow";
import type {
  ExecutionResponse,
  HarnessSnapshot,
  WorkflowRevision,
} from "../types";

import { groupWorkersByPhase } from "./plan-groups";
import { editableRevision } from "../workbench-navigation";
import { revisionSummaryState } from "./workflow-summary";
import { ViewCache } from "../workbench-state";
import {PersistedDetails} from "../persisted-details";
const assignmentVisibility=new ViewCache<boolean>();

/** 目标摘要：该会话首条用户消息前 80 字；无则"未提供目标"。 */
function goalSummary(harness: HarnessSnapshot): string {
  const first = harness.messages.find((message) => message.role === "user");
  return first ? first.text.slice(0, 80) : "未提供目标";
}

/** 卡片诊断时间；空值显示破折号，不补造时间。 */
const localeTime = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : "—";

/**
 * 计划卡（Workflow 草案卡）：状态、目标摘要、冻结后的 Phase/Worker 预览、
 * 诊断信息折叠与生命周期操作（接受方案 / 拒绝草案 / 创建执行）。
 */
export function WorkflowRevisionCard({
  revision,
  harness,
  onAccept,
  onReject,
  onCreateExecution,
  assignmentRevision,
  onAssignmentCancel,
  onAssignmentCreated,
}: {
  /** 不可变草案记录。 */
  revision: WorkflowRevision;
  /** 当前会话快照（目标摘要与会话状态来源）。 */
  harness: HarnessSnapshot;
  /** 接受并冻结回调。 */
  onAccept: (revision: number) => void;
  /** 拒绝草案回调；返回的最新快照由调用方写回 state。 */
  onReject: (revision: number) => Promise<void>;
  /** 进入分配卡创建执行回调。 */
  onCreateExecution: (revision: number) => void;
  /** 分配卡当前展开的 revision；非 null 时内嵌在卡下方。 */
  assignmentRevision: number | null;
  onAssignmentCancel: () => void;
  onAssignmentCreated: (detail: ExecutionResponse) => void;
}) {
  const rejected = revision.rejectedAt != null;
  const accepted = revision.acceptedAt !== null;
  const state = revisionSummaryState(harness, revision);
  const status = state.status;
  const [confirmingReject, setConfirmingReject] = useState(false);
  const [rejectBusy, setRejectBusy] = useState(false);
  const [rejectError, setRejectError] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const plan = revision.preview;
  const editable = editableRevision(harness, revision);
  const visibilityKey=`${harness.harnessRunId}:${revision.cardId??"legacy"}:${revision.revision}`;
  const restoreAssignment=useRef(assignmentVisibility.get(visibilityKey)===true);
  useEffect(()=>{
    if(editable&&accepted&&restoreAssignment.current)onCreateExecution(revision.revision);
  },[visibilityKey]);
  useEffect(()=>{if(editable&&(!restoreAssignment.current||assignmentRevision===revision.revision)){assignmentVisibility.set(visibilityKey,assignmentRevision===revision.revision);restoreAssignment.current=false;}},[assignmentRevision,visibilityKey,editable]);

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);


  function clickReject() {
    if (!confirmingReject) {
      setConfirmingReject(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmingReject(false), 4_000);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmingReject(false);
    setRejectBusy(true);
    setRejectError(null);
    void onReject(revision.revision)
      .catch((cause) =>
        setRejectError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setRejectBusy(false));
  }

  const executionRunning = harness.executions.some((item) => item.finishedAt === null);
  const phaseTitles = plan?.phaseTitles ?? [];

  return (
    <article className={`conversation-action workflow-revision ${rejected ? "rejected" : ""}`}>
      <div className="wf-plan-head">
        <span>{state.supersededBy ? "历史方案" : "当前方案"} · 第 {revision.revision} 版</span>
        <em className={`wf-plan-status ${rejected ? "rejected" : accepted ? "accepted" : "pending"}`}>
          {status}
        </em>
      </div>
      <p className="wf-plan-goal">{revision.goal ?? "历史方案未保存独立目标"}</p>
      <p className="wf-plan-scope">{revision.scope ?? "历史方案未保存独立范围"}</p>
      {plan && <section className="wf-declared-phases"><h3>声明阶段</h3><div>{plan.phaseTitles.map(title=><span key={title}>{title}</span>)}</div><p>阶段词表，不代表实际调用顺序或依赖关系</p></section>}
      {(
        <div className="wf-plan-preview">
          <h3>Worker 调用示意</h3>
          {!plan ? (
            <p className="wf-plan-note">此历史草案的展示预览不可用，可查看源码；执行分配仍会独立预检。</p>
          ) : (
            <>
              {groupWorkersByPhase(phaseTitles, plan.previewAgents).map((group) => (
                <section className="wf-plan-phase" key={group.key} aria-label={`Phase：${group.title}`}>
                  <h3 className="wf-plan-phase-title">{group.title}</h3>
                  <ul>
                    {group.workers.map((worker) => (
                      <li key={worker.key}>
                        <strong>{worker.name}</strong>
                        {worker.loop && <span className="wf-plan-loop" aria-label="loop：循环／批量调用，实际次数由执行路径决定">loop</span>}
                        <span>{worker.cli === "codex" ? "Codex CLI" : worker.cli === "kimi" ? "Kimi CLI" : "由分配决定"}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {plan.previewAgents.length === 0 && phaseTitles.length > 0 && (
                <p className="wf-plan-note">Phase：{phaseTitles.join("、")}</p>
              )}
              <p className="wf-plan-note">源码示意，实际执行以运行时为准</p>
              {plan.previewAgents.some((agent) => agent.loop) && <p className="wf-plan-note">loop：循环／批量调用，实际次数由执行路径决定</p>}
            </>
          )}
        </div>
      )}
      <div className="wf-plan-actions">
        {editable && !accepted && !rejected && (
          <>
            <button onClick={() => onAccept(revision.revision)}>接受方案</button>
            <button
              className="wf-plan-reject"
              disabled={rejectBusy}
              onClick={clickReject}
            >
              {rejectBusy ? "正在拒绝…" : confirmingReject ? "确认拒绝？" : "拒绝草案"}
            </button>
          </>
        )}
        {editable && accepted && !rejected && assignmentRevision !== revision.revision && (
          <button disabled={executionRunning} onClick={() => onCreateExecution(revision.revision)}>
            {executionRunning ? "等待当前执行结束" : "配置并运行"}
          </button>
        )}
      </div>
      {rejectError && <p className="answer-error">{rejectError}</p>}
      {assignmentRevision === revision.revision && (
        <ExecutionAssignmentFlow
          harnessRunId={harness.harnessRunId}
          revision={revision.revision}
          onCancel={onAssignmentCancel}
          onCreated={onAssignmentCreated}
        />
      )}
      <PersistedDetails identity={`${visibilityKey}:diagnostic`}>
        <summary>诊断信息</summary>
        <dl className="wf-plan-diag">
          <dt>revision</dt>
          <dd>v{revision.revision}</dd>
          <dt>sourceHash</dt>
          <dd>{revision.sourceHash}</dd>
          <dt>创建时间</dt>
          <dd>{localeTime(revision.createdAt)}</dd>
          <dt>接受时间</dt>
          <dd>{localeTime(revision.acceptedAt)}</dd>
          <dt>拒绝时间</dt>
          <dd>{localeTime(revision.rejectedAt)}</dd>
        </dl>
        <PersistedDetails identity={`${visibilityKey}:source`}>
          <summary>查看 workflow.ts</summary>
          <pre>{revision.source}</pre>
        </PersistedDetails>
      </PersistedDetails>
    </article>
  );
}
