import {useEffect,useState} from "react";
import {api} from "./api";
import type {ExecutionPlanResponse,ExecutionResponse,ExecutionWorkspaceConfig,WorkflowRevision,WorkflowExecution} from "./types";
import {ViewCache} from "./workbench-state";
import {DesignConfirmationCache,WorkspaceConfirmationCache} from "./workflow-design-config";
import {groupWorkersByPhase} from "./conversation/plan-groups";
import {userFacingText} from "./user-facing-text";
import {cliDisplayName} from "./cli-meta";
import type {RuntimeCli} from "./types";
const cliDrafts=new ViewCache<Record<string,string>>(64);
const plans=new ViewCache<ExecutionPlanResponse>(64);
const confirmations=new DesignConfirmationCache();
const localConfirmations=new ViewCache<string>(64);
const workspaceConfirmations=new WorkspaceConfirmationCache();

/** 每个 CLI 只呈现一个安装（优先当前选中项）；安装切换属于执行底座的职责。 */
function oneRuntimePerCli(plan:ExecutionPlanResponse){
  const byCli=new Map<RuntimeCli,ExecutionPlanResponse["pool"][number]>();
  for(const runtime of plan.pool){
    const selected=plan.selectedByCli?.[runtime.cli];
    if(!byCli.has(runtime.cli)||runtime.runtimeId===selected)byCli.set(runtime.cli,runtime);
  }
  return [...byCli.values()];
}

/** Workflow设计与CLI内联选择；只有确认按钮发起执行，读取计划不调度Worker。 */
export function WorkflowDesign({taskId,revision,editable,blockedConfirmReason,onAdjustViaChat,onAbandonCard,onCreated,input,execution,validateBeforeRun}:{
 /** 确认前由参数区校验并定位错误；false不发请求、不批准。 */ validateBeforeRun?:()=>boolean;
 /** 此版本的原执行，历史CLI以冻结配置为准，不拿源码字面量冒充生效值。 */ execution?:WorkflowExecution;
 /** 参数区当前完整草稿；确认时校验并耐久，不要求先单独保存。 */ input?:Record<string,unknown>;
 /** 原Task UUID，响应不能控制其他任务。 */ taskId:string;
 /** 展示与批准绑定的不可变版本。 */ revision:WorkflowRevision;
 /** 当前候选资格，后台忙碌时保留列表但禁运行。 */ editable:boolean;
 /** 当前可确认但被瞬时条件（主控忙碌/未终结执行）挡住时的原因；非 null 时行动点保持可见但禁用。 */ blockedConfirmReason?:string|null;
 /** 聚焦对话并绑定当前版本调整；提供时行动栏展示该入口。 */ onAdjustViaChat?:()=>void;
 /** 用户显式放弃整卡；提供时行动栏展示该入口。 */ onAbandonCard?:()=>Promise<void>;
 /** 原Execution创建结果，父层按身份处理。 */ onCreated:(result:ExecutionResponse)=>void;
}){
 const identity=`${taskId}:${revision.cardId??"legacy"}:${revision.revision}`;
 const [plan,setPlan]=useState<ExecutionPlanResponse|null>(plans.get(identity)??null),[error,setError]=useState<string|null>(null);
 const [choices,setChoices]=useState<Record<string,string>>(cliDrafts.get(identity)??{}),[busy,setBusy]=useState(false);
 const [checking,setChecking]=useState(false),[checkAttempt,setCheckAttempt]=useState(0);
 const [planError,setPlanError]=useState<string|null>(null);
 const local=!!revision.localOrigin;
 useEffect(()=>{let live=true;if(editable){setChecking(true);const timeout=setTimeout(()=>{if(live){setPlanError("执行配置检查超时（如果 macOS 刚弹出文件夹访问授权——常见于项目位于桌面、文稿等受保护目录——请点允许后重新检查；也可能正与其他窗口/进程抢占执行环境）。参数和 CLI 选择已保留。");setChecking(false);}},15_000);const done=()=>clearTimeout(timeout);void api.planExecution(taskId,revision.revision).then(result=>{done();if(live){plans.set(identity,result);setPlan(result);setPlanError(local||result.harnessRuntime?null:"尚未设置已验证的 Wave Flow CLI，请在执行环境设置中选择。");}}).catch(error=>{done();if(live&&!String(error).includes("主控必须空闲"))setPlanError(userFacingText(error instanceof Error?error.message:String(error)));}).finally(()=>{if(live)setChecking(false);});}else setChecking(false);return()=>{live=false;};},[taskId,revision.revision,editable,identity,checkAttempt]);
 function cliSelect(id:string,label:string){
   if(revision.localOrigin){const cli=(plan?.previewAgents??revision.preview?.previewAgents??[]).find(worker=>worker.nodeId===id)?.cli;return <span>{cli ? cliDisplayName(cli) : "运行时决定"}</span>;}
   if(execution){const assignment=execution.config?.assignments.find(item=>item.agentId===id)??execution.config?.defaultAssignment;return <span>{assignment?cliDisplayName(assignment.cli):"历史CLI配置未知"}</span>;}
   if(!editable&&!blockedConfirmReason){
     const cli=revision.preview?.previewAgents.find(worker=>worker.nodeId===id)?.cli;
     return <span>{cli?cliDisplayName(cli):'运行时决定'}</span>;
   }
   if(!plan){
     if(checking)return <span className="cli-pending" role="status">正在检查可用 CLI…</span>;
     if(planError)return <span>检查未完成 · 见下方错误</span>;
     return <span className="cli-pending">Wave Flow 处理结束后显示可用 CLI</span>;
   }
   const options=oneRuntimePerCli(plan);
   if(options.length===0)return <span>没有已验证的 CLI</span>;
   if(options.length===1){const only=options[0]!;return <span>{cliDisplayName(only.cli)}</span>;}
   const preferred=choices[id]&&options.some(runtime=>runtime.runtimeId===choices[id])?choices[id]:options.find(runtime=>runtime.runtimeId===plan.harnessRuntime?.runtimeId)?.runtimeId??options[0]!.runtimeId;
   return <select aria-label={`${label} CLI`} disabled={!editable||busy} value={preferred} onChange={event=>setChoices(current=>{const next={...current,[id]:event.target.value};cliDrafts.set(identity,next);return next;})}>{options.map(runtime=><option key={runtime.runtimeId} value={runtime.runtimeId}>{cliDisplayName(runtime.cli)}</option>)}</select>;
 }
 function workspaceSummary(){
   if(!plan?.workspacePlan)return null;
   const continuation=plan.continuationPlan;
   const dirtyPaths=plan.workspacePlan.dirtyPaths;
   return <p className="workflow-workspace-summary">
     {plan.workspacePlan.diagnostic
       ? plan.workspacePlan.diagnostic
       : continuation
         ? `接续上次执行的工作区（${continuation.head.slice(0, 12)}）；所有写节点共享同一 worktree。`
         : `基准 ${plan.workspacePlan.baseCommit?.slice(0, 12) ?? "不可用"}；所有写节点共享同一 worktree。`}
     {dirtyPaths.length
       ? ` ${dirtyPaths.length} 项未提交改动不纳入（保留不动）；主工作区不干净时首次自动应用会被确定性跳过，请先提交或暂存这些改动，再到执行页点“重新整理改动”（不会重新执行 Workflow）。`
       : " 完成后自动应用到主工作区，保持未提交、不 push。"}
   </p>;
 }
 async function run(){
   if(!editable||busy||checking||planError||!plan||!revision.localOrigin&&!plan.harnessRuntime)return;
   if(validateBeforeRun&&!validateBeforeRun())return;
   setBusy(true);try{
     let result:ExecutionResponse;
     if(revision.localOrigin){
       if(plan.workspacePlan){
         const localChoices:Record<string,string>={};for(const worker of plan.workers){if(!worker.cli)throw new Error(`本地写节点 ${worker.id} 的CLI必须为固定字面量。`);const runtimeId=plan.selectedByCli[worker.cli]??plan.pool.find(item=>item.cli===worker.cli)?.runtimeId;if(!runtimeId)throw new Error(`没有已验证的 ${worker.cli} Runtime。`);localChoices[worker.id]=runtimeId;}
         const workspaces=workspaceConfirmations.get(identity,plan.workspacePlan,true,plan.continuationPlan);const confirmation=confirmations.get(identity,input,localChoices,plan,workspaces);result=await api.confirmWorkflow(taskId,revision.revision,confirmation.config,confirmation.id,plan.sceneEvidenceHash);}
       else {const key=`${identity}:${plan.sceneEvidenceHash??"first"}`;let requestId=localConfirmations.get(key);if(!requestId){requestId=crypto.randomUUID();localConfirmations.set(key,requestId);}result=await api.confirmWorkflow(taskId,revision.revision,undefined,requestId,plan.sceneEvidenceHash);}
     }
     else {
       let workspaces:ExecutionWorkspaceConfig|undefined;
       if(plan.workspacePlan){
         workspaces=workspaceConfirmations.get(identity,plan.workspacePlan,true,plan.continuationPlan);
       }
       const confirmation=confirmations.get(identity,input,choices,plan,workspaces);result=revision.templateOrigin?await api.confirmTemplate(taskId,revision.revision,confirmation.config,confirmation.id,input,plan.sceneEvidenceHash):await api.confirmWorkflow(taskId,revision.revision,confirmation.config,confirmation.id,plan.sceneEvidenceHash);
     }
     onCreated(result);
   }catch(error){setError(error instanceof Error?error.message:String(error));}finally{setBusy(false);}
 }
 const titles=revision.preview?.phaseTitles??[];
 return <section className="workflow-design"><h3>执行步骤</h3>{groupWorkersByPhase(titles,plan?.previewAgents??revision.preview?.previewAgents??[]).map(group=><section key={group.key}><h4>{group.title}</h4>{group.workers.map(worker=><div className="workflow-design-row" key={worker.key}><strong>{worker.name}{worker.loop&&<small>循环/批量调用</small>}</strong>{cliSelect(worker.nodeId??"*",worker.name)}</div>)}</section>)}
   {workspaceSummary()}
   {!!plan?.dynamicCount&&!revision.localOrigin&&<section className="workflow-design-default"><div className="workflow-design-row"><span>其余动态 Worker 默认使用</span>{cliSelect("*","动态Worker")}</div></section>}
   {plan&&plan.pool.length===1&&editable&&<small>需要更多选择时，先在执行底座设置中验证其他 CLI。</small>}
   {error&&<p role="alert">{error}</p>}
   {checking&&<small role="status">正在检查执行配置，参数和 CLI 选择已保留…</small>}
   {planError&&<><p role="alert">执行配置检查未完成：{planError}。参数与选择已保留，请重新检查后运行。</p>{editable&&<button type="button" className="button-secondary" disabled={checking||busy} onClick={()=>setCheckAttempt(attempt=>attempt+1)}>重新检查执行配置</button>}</>}
   {(editable||blockedConfirmReason)&&<div className="workflow-design-actions"><small>{editable?(plan?.workspacePlan?(plan.workspacePlan.dirtyPaths.length?"确认后锁定方案并开始执行；主工作区有未提交改动，本次自动应用会被确定性跳过，执行页可继续整理。":"确认后锁定方案并开始执行；完成后自动应用到主工作区（未提交、不 push）。"):"确认后锁定方案并开始执行。"):blockedConfirmReason}</small><div className="actions-group">{onAdjustViaChat&&<button type="button" className="button-secondary" onClick={onAdjustViaChat}>通过对话调整</button>}{onAbandonCard&&<button type="button" className="button-secondary" onClick={()=>void onAbandonCard()}>放弃此方案</button>}<button type="button" className="button-primary" disabled={!editable||busy||checking||!!planError||!plan||!revision.localOrigin&&!plan.harnessRuntime} onClick={()=>void run()}>{busy?"正在启动…":"确认并运行"}</button></div></div>}
 </section>;
}
