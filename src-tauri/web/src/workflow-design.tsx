import {useEffect,useState} from "react";
import {api} from "./api";
import type {ExecutionPlanResponse,ExecutionResponse,ExecutionWorkspaceConfig,RuntimeCli,WorkflowRevision,WorkflowExecution} from "./types";
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
export function WorkflowDesign({taskId,revision,editable,blockedConfirmReason,onAdjustViaChat,onSaveAsLocal,savingAsLocal,saveAsLocalError,onCreated,input,execution,validateBeforeRun,onSourceDrift}:{
 /** 确认前由参数区校验并定位错误；false不发请求、不批准。 */ validateBeforeRun?:()=>boolean;
 /** 本地来源在启动前被判定已变化时调用，用于揭示“重新预检”入口。 */ onSourceDrift?:()=>void;
 /** 此版本的原执行，历史CLI以冻结配置为准，不拿源码字面量冒充生效值。 */ execution?:WorkflowExecution;
 /** 参数区当前完整草稿；确认时校验并耐久，不要求先单独保存。 */ input?:Record<string,unknown>;
 /** 原Task UUID，响应不能控制其他任务。 */ taskId:string;
 /** 展示与批准绑定的不可变版本。 */ revision:WorkflowRevision;
 /** 当前候选资格，后台忙碌时保留列表但禁运行。 */ editable:boolean;
 /** 当前可确认但被瞬时条件（主控忙碌/未终结执行）挡住时的原因；非 null 时行动点保持可见但禁用。 */ blockedConfirmReason?:string|null;
 /** 聚焦对话并绑定当前版本调整；提供时行动栏展示该入口。 */ onAdjustViaChat?:()=>void;
 /** 保存并接管为本地 Workflow；提供时行动栏展示该入口（不可放弃方案，只能通过对话调整）。 */ onSaveAsLocal?:()=>Promise<void>|void;
 /** 保存为本地进行中；期间禁用保存与确认，避免并发写同一任务。 */ savingAsLocal?:boolean;
 /** 保存为本地失败原因；在行动栏内如实展示，不静默吞掉。 */ saveAsLocalError?:string|null;
 /** 原Execution创建结果，父层按身份处理。 */ onCreated:(result:ExecutionResponse)=>void;
}){
 const identity=`${taskId}:${revision.cardId??"legacy"}:${revision.revision}`;
 const [plan,setPlan]=useState<ExecutionPlanResponse|null>(plans.get(identity)??null),[error,setError]=useState<string|null>(null);
 const [busy,setBusy]=useState(false);
 const [checking,setChecking]=useState(false),[checkAttempt,setCheckAttempt]=useState(0);
 const [planError,setPlanError]=useState<string|null>(null);
 /** 逐节点 CLI 选择；只对源码中省略 cli 的字面量节点生效。 */
 const [nodeClis,setNodeClis]=useState<Record<string,RuntimeCli>>({});
 /** 动态节点（循环/变量 id）的兜底 CLI。 */
 const [dynamicCli,setDynamicCli]=useState<RuntimeCli|null>(null);
 const local=!!revision.localOrigin;
 const moduleRevision=(revision.sourceFormat??(revision.localOrigin?"module":"restricted"))==="module";
 const script=moduleRevision&&!revision.localOrigin;
 useEffect(()=>{let live=true;if(editable){setChecking(true);setPlanError(null);const timeout=setTimeout(()=>{if(!live)return;if(checkAttempt===0){setChecking(true);setCheckAttempt(attempt=>attempt+1);return;}setPlanError("执行环境准备较慢。参数已保留，请稍后重新检查。");setChecking(false);},15_000);const done=()=>clearTimeout(timeout);void api.planExecution(taskId,revision.revision).then(result=>{done();if(live){plans.set(identity,result);setPlan(result);/* 唯一候选可以预填；多个候选保持未选，必须由用户逐节点决定。 */const suggested=result.cliChoices?.suggested??null;setNodeClis(current=>{if(!suggested)return current;const next={...current};for(const node of result.cliChoices?.nodes??[])if(!next[node.nodeId])next[node.nodeId]=suggested;return next;});setDynamicCli(current=>current??suggested);setPlanError(local||script||result.harnessRuntime?null:"还没有选择可用的本地执行工具。请打开右上角执行环境设置完成连接。");}}).catch(error=>{done();if(live&&!String(error).includes("主控必须空闲"))setPlanError(userFacingText(error instanceof Error?error.message:String(error)));}).finally(()=>{if(live)setChecking(false);});}else setChecking(false);return()=>{live=false;};},[taskId,revision.revision,editable,identity,checkAttempt]);
 const cliChoices=plan?.cliChoices??null;
 /** 每个省略 cli 的节点必须各自选好；动态字符串节点还必须有兜底。 */
 const missingCliNodes=cliChoices?(cliChoices.nodes.map(node=>node.nodeId).filter(id=>!nodeClis[id]).length>0||cliChoices.dynamicCount>0&&!dynamicCli):false;
 function cliSelect(id:string|null,_label:string){
   const assigned=execution&&execution.config?.assignmentMode!=="script"
     ? execution.config?.assignments.find(item=>item.agentId===id)??execution.config?.defaultAssignment
     : null;
   const declared=(plan?.previewAgents??revision.preview?.previewAgents??[]).find(worker=>worker.nodeId===id)?.cli;
   const cli=assigned?.cli??declared??null;
   if(cli)return <span>{cliDisplayName(cli)}</span>;
   // 源码没写 CLI 的字面量节点：每个节点各自选择，互不牵连。
   if(id&&cliChoices?.nodes.some(node=>node.nodeId===id))return <select aria-label={`${_label} 使用的 CLI`} value={nodeClis[id]??""} disabled={!editable||busy||cliChoices.available.length===0} onChange={event=>{const value=event.target.value;setNodeClis(current=>({...current,[id]:value as RuntimeCli}));}}><option value="" disabled>选择 CLI</option>{cliChoices.available.map(value=><option key={value} value={value}>{cliDisplayName(value)}</option>)}</select>;
   // 动态/无法静态枚举的节点：显示兜底选择结果。
   return <span>{dynamicCli?`${cliDisplayName(dynamicCli)}（动态节点兜底）`:"动态节点：启动时选择"}</span>;
 }
 function workspaceSummary(){
   const diagnostic=plan?.workspacePlan?.diagnostic;
   return diagnostic ? <p role="alert">{diagnostic}</p> : null;
 }
 async function run(){
   if(!editable||busy||checking||planError||!plan||missingCliNodes||!local&&!script&&!plan.harnessRuntime)return;
   if(validateBeforeRun&&!validateBeforeRun())return;
   setBusy(true);try{
     let result:ExecutionResponse;
     // 逐节点选择：只给需要选择的字面量节点提交条目；兜底只在存在动态节点时提交。
     const chosenNodes=cliChoices?Object.fromEntries(cliChoices.nodes.map(node=>[node.nodeId,nodeClis[node.nodeId]!]).filter(([,value])=>!!value)) as Record<string,RuntimeCli>:{};
     const fallback=cliChoices&&cliChoices.dynamicCount>0?dynamicCli:null;
     if(revision.localOrigin){
       if(plan.workspacePlan||Object.keys(chosenNodes).length>0||fallback){
         const workspaces=plan.workspacePlan?workspaceConfirmations.get(identity,plan.workspacePlan,true,plan.continuationPlan):undefined;
         const confirmation=confirmations.script(identity,input,plan,workspaces,fallback,chosenNodes);
         result=await api.confirmWorkflow(taskId,revision.revision,confirmation.config,confirmation.id,plan.sceneEvidenceHash);
       }
       else {const key=`${identity}:${plan.sceneEvidenceHash??"first"}`;let requestId=localConfirmations.get(key);if(!requestId){requestId=crypto.randomUUID();localConfirmations.set(key,requestId);}result=await api.confirmWorkflow(taskId,revision.revision,undefined,requestId,plan.sceneEvidenceHash);}
     }
     else {
       let workspaces:ExecutionWorkspaceConfig|undefined;
       if(plan.workspacePlan){
         workspaces=workspaceConfirmations.get(identity,plan.workspacePlan,true,plan.continuationPlan);
       }
       const confirmation=confirmations.script(identity,input,plan,workspaces,fallback,chosenNodes);
       result=revision.templateOrigin?await api.confirmTemplate(taskId,revision.revision,confirmation.config,confirmation.id,input,plan.sceneEvidenceHash):await api.confirmWorkflow(taskId,revision.revision,confirmation.config,confirmation.id,plan.sceneEvidenceHash,script?input:undefined);
     }
     onCreated(result);
   }catch(error){
     const message=userFacingText(error instanceof Error?error.message:String(error));
     if(/启动前已变化|文件已变化|重新预检/.test(message))onSourceDrift?.();
     setError(message);
   }finally{setBusy(false);}
 }
 const titles=revision.preview?.phaseTitles??[];
 return <section className="workflow-design"><h3>执行步骤</h3>{groupWorkersByPhase(titles,plan?.previewAgents??revision.preview?.previewAgents??[]).map(group=><section key={group.key}><h4>{group.title}</h4>{group.workers.map(worker=><div className="workflow-design-row" key={worker.key}><strong>{worker.name}{worker.loop&&<small>循环/批量调用</small>}</strong>{cliSelect(worker.nodeId??null,worker.name)}</div>)}</section>)}
   {cliChoices&&cliChoices.dynamicCount>0&&<div className="workflow-cli-choice"><label><span>动态节点兜底 CLI（{cliChoices.dynamicCount} 个动态调用）</span><select aria-label="动态节点兜底 CLI" value={dynamicCli??""} disabled={!editable||busy||cliChoices.available.length===0} onChange={event=>setDynamicCli(event.target.value?event.target.value as RuntimeCli:null)}><option value="" disabled>请选择</option>{cliChoices.available.map(cli=><option key={cli} value={cli}>{cliDisplayName(cli)}</option>)}</select></label><small>{cliChoices.available.length===0?"本机还没有已验证的 CLI：请先在设置页扫描并验证一个，确认按钮会保持禁用。":"循环/变量 id 的节点无法逐个列出，统一使用这个兜底选择；已逐个选择的字面量节点不受影响。"}</small></div>}
   {cliChoices&&cliChoices.dynamicCount===0&&cliChoices.nodes.length>0&&<small>{cliChoices.available.length===0?"本机还没有已验证的 CLI：请先在设置页扫描并验证一个，确认按钮会保持禁用。":"源码中未写死 CLI 的节点需要逐个选择，每个节点可以不同；写死 CLI 的节点不受影响。"}</small>}
   {workspaceSummary()}
   {error&&<p role="alert">{error}</p>}
   {checking&&<small role="status">正在检查执行配置，参数已保留…</small>}
   {planError&&<><p role="alert">{planError}</p>{editable&&<button type="button" className="button-secondary" disabled={checking||busy} onClick={()=>setCheckAttempt(attempt=>attempt+1)}>重新检查执行环境</button>}</>}
   {(editable||blockedConfirmReason)&&<div className="workflow-design-actions"><div className="workflow-design-actions-copy"><small>{editable?(missingCliNodes?"请先为每个未声明 CLI 的节点选好 CLI。":plan?.workspacePlan?"确认后开始执行；完成后改动保留在工作区，不会自动写入项目目录。":"确认后开始执行。"):blockedConfirmReason}</small>{saveAsLocalError&&<p role="alert">{saveAsLocalError}</p>}</div><div className="actions-group">{onAdjustViaChat&&<button type="button" className="button-secondary" onClick={onAdjustViaChat}>通过对话调整</button>}{onSaveAsLocal&&<button type="button" className="button-secondary" disabled={busy||checking||savingAsLocal} title="保存后当前 Task 将改用该文件；文件与手写 Workflow 同等受信任。之后编辑文件需重新预检，主控不能再替换源码。" onClick={()=>void onSaveAsLocal()}>{savingAsLocal?"正在保存…":"保存为本地"}</button>}<button type="button" className="button-primary" disabled={!editable||busy||checking||savingAsLocal||!!planError||!plan||missingCliNodes||!local&&!script&&!plan.harnessRuntime} onClick={()=>void run()}>{busy?"正在启动…":"确认并运行"}</button></div></div>}
 </section>;
}
