import {useEffect,useState} from "react";
import {api} from "./api";
import type {ExecutionPlanResponse,ExecutionResponse,ExecutionWorkspaceConfig,WorkflowRevision,WorkflowExecution} from "./types";
import {ViewCache} from "./workbench-state";
import {DesignConfirmationCache,WorkspaceConfirmationCache} from "./workflow-design-config";
import {groupWorkersByPhase} from "./conversation/plan-groups";
import {userFacingText} from "./user-facing-text";
import {cliDisplayName} from "./cli-meta";
const plans=new ViewCache<ExecutionPlanResponse>(64);
const confirmations=new DesignConfirmationCache();
const localConfirmations=new ViewCache<string>(64);
const workspaceConfirmations=new WorkspaceConfirmationCache();

/** Workflow 设计与只读 CLI 展示；只有确认按钮发起执行，读取计划不调度 Worker。 */
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
 const [busy,setBusy]=useState(false);
 const [checking,setChecking]=useState(false),[checkAttempt,setCheckAttempt]=useState(0);
 const [planError,setPlanError]=useState<string|null>(null);
 const local=!!revision.localOrigin;
 const moduleRevision=(revision.sourceFormat??(revision.localOrigin?"module":"restricted"))==="module";
 const script=moduleRevision&&!revision.localOrigin;
 useEffect(()=>{let live=true;if(editable){setChecking(true);setPlanError(null);const timeout=setTimeout(()=>{if(!live)return;if(checkAttempt===0){setChecking(true);setCheckAttempt(attempt=>attempt+1);return;}setPlanError("执行环境准备较慢。参数已保留，请稍后重新检查。");setChecking(false);},15_000);const done=()=>clearTimeout(timeout);void api.planExecution(taskId,revision.revision).then(result=>{done();if(live){plans.set(identity,result);setPlan(result);setPlanError(local||script||result.harnessRuntime?null:"还没有选择可用的本地执行工具。请打开右上角执行环境设置完成连接。");}}).catch(error=>{done();if(live&&!String(error).includes("主控必须空闲"))setPlanError(userFacingText(error instanceof Error?error.message:String(error)));}).finally(()=>{if(live)setChecking(false);});}else setChecking(false);return()=>{live=false;};},[taskId,revision.revision,editable,identity,checkAttempt]);
 function cliSelect(id:string,_label:string){
   const assigned=execution&&execution.config?.assignmentMode!=="script"
     ? execution.config?.assignments.find(item=>item.agentId===id)??execution.config?.defaultAssignment
     : null;
   const cli=assigned?.cli??(plan?.previewAgents??revision.preview?.previewAgents??[]).find(worker=>worker.nodeId===id)?.cli;
   return <span>{cli?cliDisplayName(cli):"按源码选择"}</span>;
 }
 function workspaceSummary(){
   const diagnostic=plan?.workspacePlan?.diagnostic;
   return diagnostic ? <p role="alert">{diagnostic}</p> : null;
 }
 async function run(){
   if(!editable||busy||checking||planError||!plan||!local&&!script&&!plan.harnessRuntime)return;
   if(validateBeforeRun&&!validateBeforeRun())return;
   setBusy(true);try{
     let result:ExecutionResponse;
     if(revision.localOrigin){
       if(plan.workspacePlan){
         const workspaces=workspaceConfirmations.get(identity,plan.workspacePlan,true,plan.continuationPlan);
         const confirmation=confirmations.script(identity,input,plan,workspaces);
         result=await api.confirmWorkflow(taskId,revision.revision,confirmation.config,confirmation.id,plan.sceneEvidenceHash);
       }
       else {const key=`${identity}:${plan.sceneEvidenceHash??"first"}`;let requestId=localConfirmations.get(key);if(!requestId){requestId=crypto.randomUUID();localConfirmations.set(key,requestId);}result=await api.confirmWorkflow(taskId,revision.revision,undefined,requestId,plan.sceneEvidenceHash);}
     }
     else {
       let workspaces:ExecutionWorkspaceConfig|undefined;
       if(plan.workspacePlan){
         workspaces=workspaceConfirmations.get(identity,plan.workspacePlan,true,plan.continuationPlan);
       }
       const confirmation=confirmations.script(identity,input,plan,workspaces);
       result=revision.templateOrigin?await api.confirmTemplate(taskId,revision.revision,confirmation.config,confirmation.id,input,plan.sceneEvidenceHash):await api.confirmWorkflow(taskId,revision.revision,confirmation.config,confirmation.id,plan.sceneEvidenceHash,script?input:undefined);
     }
     onCreated(result);
   }catch(error){setError(userFacingText(error instanceof Error?error.message:String(error)));}finally{setBusy(false);}
 }
 const titles=revision.preview?.phaseTitles??[];
 return <section className="workflow-design"><h3>执行步骤</h3>{groupWorkersByPhase(titles,plan?.previewAgents??revision.preview?.previewAgents??[]).map(group=><section key={group.key}><h4>{group.title}</h4>{group.workers.map(worker=><div className="workflow-design-row" key={worker.key}><strong>{worker.name}{worker.loop&&<small>循环/批量调用</small>}</strong>{cliSelect(worker.nodeId??"*",worker.name)}</div>)}</section>)}
   {workspaceSummary()}
   {error&&<p role="alert">{error}</p>}
   {checking&&<small role="status">正在检查执行配置，参数已保留…</small>}
   {planError&&<><p role="alert">{planError}</p>{editable&&<button type="button" className="button-secondary" disabled={checking||busy} onClick={()=>setCheckAttempt(attempt=>attempt+1)}>重新检查执行环境</button>}</>}
   {(editable||blockedConfirmReason)&&<div className="workflow-design-actions"><small>{editable?(plan?.workspacePlan?"确认后开始执行；完成后改动保留在工作区，不会自动写入项目目录。":"确认后开始执行。"):blockedConfirmReason}</small><div className="actions-group">{onAdjustViaChat&&<button type="button" className="button-secondary" onClick={onAdjustViaChat}>通过对话调整</button>}{onAbandonCard&&<button type="button" className="button-secondary" onClick={()=>void onAbandonCard()}>放弃此方案</button>}<button type="button" className="button-primary" disabled={!editable||busy||checking||!!planError||!plan||!local&&!script&&!plan.harnessRuntime} onClick={()=>void run()}>{busy?"正在启动…":"确认并运行"}</button></div></div>}
 </section>;
}
