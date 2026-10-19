import { useRef, useState } from "react";
import type {
  ExecutionResponse,
  HarnessSnapshot,
  WorkflowRevision,
} from "../types";

import { editableRevision } from "../workbench-navigation";
import { revisionSummaryState } from "./workflow-summary";
import {versionLabel} from './workflow-versions';
import { ViewCache } from "../workbench-state";
import {PersistedDetails} from "../persisted-details";
import {CompactParameterForm as ParameterForm} from "../forms/compact-parameter-form";
import {api} from "../api";
import {WorkflowDesign} from "../workflow-design";
import {suggestedParameters} from "../forms/parameter-defaults";
import {validateAnswer,type SchemaFieldError} from "../forms/schema-support";
import {isJsonObject} from "../../../../src/shared/json";
const parameterDrafts=new ViewCache<Record<string,unknown>>();

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
 * 诊断信息折叠、参数版本编辑和一次最终确认。
 */
export function WorkflowRevisionCard({
  revision,
  harness,
  onAssignmentCreated,
  onSaved,
  onLocalRevision,
  onAdjustViaChat,
  onAbandonCard,
  hideGoal=false,
}: {
  /** 不可变草案记录。 */
  revision: WorkflowRevision;
  /** 当前会话快照（目标摘要与会话状态来源）。 */
  harness: HarnessSnapshot;
  /** 唯一确认成功后的原执行详情；不再使用独立分配卡。 */
  onAssignmentCreated: (detail: ExecutionResponse) => void;
  /** 保存返回原任务快照；父层按身份更新并展示新版本，不由响应切到其他任务。 */
  onSaved?: (task: HarnessSnapshot) => void;
  /** 用户显式重新预检本地文件并编辑参数；只打开准备界面，不直接保存/执行。 */
  onLocalRevision?:()=>void;
  /** 聚焦对话并绑定当前版本调整；只准备输入上下文，不发送。 */
  onAdjustViaChat?:()=>void;
  /** 用户显式放弃整卡；不可逆耐久事实。 */
  onAbandonCard?:()=>Promise<void>;
  /** 详情页页头已有目标时隐藏重复标题；对话内独立卡片缺省仍展示。 */
  hideGoal?:boolean;
}) {
  const rejected = revision.rejectedAt != null;
  const accepted = revision.acceptedAt !== null;
  const state = revisionSummaryState(harness, revision);
  const status = state.status;
  const editable = editableRevision(harness, revision);
  const currentCandidate=!!revision.cardId&&!revision.abandonedAt&&harness.workflowRevisions.filter(item=>item.cardId===revision.cardId).at(-1)?.revision===revision.revision&&!harness.executions.some(item=>harness.task?.workflowContract==="single-workflow-v1"?item.revision===revision.revision:harness.workflowRevisions.find(version=>version.revision===item.revision)?.cardId===revision.cardId);
  // 可确认但被瞬时条件挡住时给出原因，而不是隐藏行动点；拒绝/放弃/已执行/非最新版不算可确认。
  const blockedConfirmReason = editable||rejected||!currentCandidate ? null
    : harness.status==="running" ? "Wave Flow 正在处理，结束后可确认运行。"
    : harness.status==="interrupted" ? "Wave Flow 已中断，恢复或发送消息后可确认运行。"
    : "有执行尚未结束，终结后才能确认新运行。";
  const visibilityKey=`${harness.harnessRunId}:${revision.cardId??"legacy"}:${revision.revision}`;
  const [saving,setSaving]=useState(false);
  const [validationErrors,setValidationErrors]=useState<SchemaFieldError[]>([]);
  const saveRequest=useRef<{payload:string;id:string}|null>(null);
  const [inputDraft,setInputDraft]=useState<Record<string,unknown>>(()=>revision.templateOrigin?suggestedParameters(revision.templateOrigin.inputSchema,parameterDrafts.get(visibilityKey)??revision.input??{}):{});
  const unsaved=JSON.stringify(inputDraft)!==JSON.stringify(revision.templateOrigin?suggestedParameters(revision.templateOrigin.inputSchema,revision.input??{}):{});
  const latest=harness.workflowRevisions.filter(item=>item.cardId===revision.cardId).at(-1);
  const canTransfer=unsaved&&!currentCandidate&&!!latest?.templateOrigin&&latest.templateOrigin.sourceHash===revision.templateOrigin?.sourceHash&&editableRevision(harness,latest);
  const [transferError,setTransferError]=useState<string|null>(null);
  const canReviseTemplate=harness.task?.workflowContract==="single-workflow-v1"&&!!revision.templateOrigin&&harness.status==="idle"&&!harness.executions.some(item=>item.finishedAt===null)&&latest?.revision===revision.revision&&harness.executions.some(item=>item.revision===revision.revision);
  async function prepareParameters(){
    const input=revision.input??{};if(!isJsonObject(input))throw new Error("原模板参数不是合法JSON对象，不能准备新版。");
    setSaving(true);const payload=`parameters:${revision.revision}`;if(saveRequest.current?.payload!==payload)saveRequest.current={payload,id:crypto.randomUUID()};
    try{const origin=revision.templateOrigin!;const result=await api.saveTemplate(harness.harnessRunId,saveRequest.current.id,{id:origin.id,version:origin.version,sourceHash:origin.sourceHash,input},revision.cardId,revision.revision);onSaved?.(result.harness);}finally{setSaving(false);}
  }
  async function saveInput(input:Record<string,unknown>,target:WorkflowRevision=revision){
    if(!target.templateOrigin)return;
    const payload=JSON.stringify({input,revision:target.revision});if(saveRequest.current?.payload!==payload)saveRequest.current={payload,id:crypto.randomUUID()};
    setSaving(true);try{const response=await api.saveTemplate(harness.harnessRunId,saveRequest.current.id,{id:target.templateOrigin.id,version:target.templateOrigin.version,sourceHash:target.templateOrigin.sourceHash,input:input as never},target.cardId,target.revision);onSaved?.(response.harness);}finally{setSaving(false);}
  }

  return (
    <article className={`conversation-action workflow-revision ${rejected ? "rejected" : ""}`}>
      <div className="wf-plan-head">
        {versionLabel(harness,revision)&&<span>{versionLabel(harness,revision)}</span>}
        <em className={`wf-plan-status ${rejected ? "rejected" : accepted ? "accepted" : "pending"}`}>
          {status}
        </em>
      </div>
      {!hideGoal&&<p className="wf-plan-goal">{revision.goal ?? "历史方案未保存独立目标"}</p>}
      <p className="wf-plan-scope">{revision.scope ?? "历史方案未保存独立范围"}</p>
      {canReviseTemplate&&onSaved&&<button disabled={saving} onClick={()=>void prepareParameters().catch(error=>setTransferError(String(error)))}>准备参数新版本</button>}
      {harness.task?.workflowContract==="single-workflow-v1"&&harness.status==="idle"&&!revision.localOrigin&&latest?.revision===revision.revision&&harness.executions.some(item=>item.revision===revision.revision)&&!harness.executions.some(item=>item.finishedAt===null)&&onSaved&&<button disabled={saving} onClick={()=>{setSaving(true);const payload=`config:${revision.revision}`;if(saveRequest.current?.payload!==payload)saveRequest.current={payload,id:crypto.randomUUID()};void api.prepareConfigurationRevision(harness.harnessRunId,revision.revision,saveRequest.current.id).then(result=>onSaved(result.harness)).catch(error=>setTransferError(String(error))).finally(()=>setSaving(false));}}>保留源码，准备 CLI 配置新版本</button>}
      {revision.localOrigin&&<><p>本地来源：{revision.localOrigin.path}</p><p>参数与源码已冻结；编辑文件后须重新预检。</p><pre>{JSON.stringify(revision.input,null,2)}</pre>{harness.status==="idle"&&!harness.executions.some(item=>item.finishedAt===null)&&latest?.revision===revision.revision&&onLocalRevision&&<button type="button" disabled={saving} onClick={onLocalRevision}>重新预检并准备新版本</button>}{transferError&&<p role="alert">{transferError}</p>}</>}
      {revision.templateOrigin&&<><p>预置来源：{revision.templateOrigin.id} · v{revision.templateOrigin.version}</p>{(currentCandidate||unsaved&&!harness.executions.some(item=>item.revision===revision.revision))?<ParameterForm validationErrors={validationErrors} identity={`${visibilityKey}:input`} key={`${visibilityKey}:input`} schema={revision.templateOrigin.inputSchema} initialValue={inputDraft} onDraft={input=>{parameterDrafts.set(visibilityKey,input);setInputDraft(input);}} blockedReason={!currentCandidate?"Wave Flow 已准备新版本。你的未保存修改仍保留在这里；请查看新版本后再决定如何修改，旧版不能提交。":!editable?"Wave Flow 或执行正在处理；保留参数，结束后可保存。":undefined} busy={saving} onSubmit={async input=>{
        await saveInput(input);
      }}/>:<pre>{JSON.stringify(revision.input,null,2)}</pre>}</>}
      {canTransfer&&<><button className="button-secondary" disabled={saving} onClick={()=>{const errors=validateAnswer(latest!.templateOrigin!.inputSchema,inputDraft);setValidationErrors(errors);if(errors.length)return;void saveInput(inputDraft,latest).catch(error=>setTransferError(String(error)));}}>将我的修改保存为当前方案的新版本</button><small>保留 Wave Flow 准备的新版本；你的参数将另存为未批准版本，不会自动执行。</small>{transferError&&<p role="alert">{transferError}</p>}</>}
      <WorkflowDesign taskId={harness.harnessRunId} revision={revision} editable={editable&&!rejected} blockedConfirmReason={rejected?null:blockedConfirmReason} onAdjustViaChat={onAdjustViaChat} onAbandonCard={onAbandonCard} onCreated={onAssignmentCreated} input={inputDraft} validateBeforeRun={()=>{const errors=revision.templateOrigin?validateAnswer(revision.templateOrigin.inputSchema,inputDraft):[];setValidationErrors(errors);return !errors.length;}} execution={harness.executions.find(item=>item.revision===revision.revision)}/>
      {transferError&&!revision.localOrigin&&!canTransfer&&<p role="alert">{transferError}</p>}
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
