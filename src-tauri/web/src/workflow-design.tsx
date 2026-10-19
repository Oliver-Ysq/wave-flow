import {useEffect,useState} from "react";
import {api} from "./api";
import type {ExecutionPlanResponse,ExecutionResponse,ExecutionWorkspaceConfig,WorkflowRevision,WorkflowExecution} from "./types";
import {ViewCache} from "./workbench-state";
import {DesignConfirmationCache,WorkspaceConfirmationCache} from "./workflow-design-config";
import {groupWorkersByPhase} from "./conversation/plan-groups";
import {userFacingText} from "./user-facing-text";
const cliDrafts=new ViewCache<Record<string,string>>(64);
const plans=new ViewCache<ExecutionPlanResponse>(64);
const confirmations=new DesignConfirmationCache();
const localConfirmations=new ViewCache<string>(64);
const workspaceDrafts=new ViewCache<Record<string,{resources:string;workspaceId:string;sources?:string;workspaceGroup?:string}>>(64);
const workspaceConfirmations=new WorkspaceConfirmationCache();

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
 const [workspaceDraft,setWorkspaceDraft]=useState<Record<string,{resources:string;workspaceId:string;sources?:string;workspaceGroup?:string}>>(workspaceDrafts.get(identity)??{});
 const [excludeDirty,setExcludeDirty]=useState(false);
 const [checking,setChecking]=useState(false),[checkAttempt,setCheckAttempt]=useState(0);
 const [planError,setPlanError]=useState<string|null>(null);
 const local=!!revision.localOrigin;
 useEffect(()=>{let live=true;if(editable){setChecking(true);void api.planExecution(taskId,revision.revision).then(result=>{if(live){plans.set(identity,result);setPlan(result);setPlanError(local||result.harnessRuntime?null:"尚未设置已验证的 Wave Flow CLI，请在执行环境设置中选择。");}}).catch(error=>{if(live&&!String(error).includes("主控必须空闲"))setPlanError(userFacingText(error instanceof Error?error.message:String(error)));}).finally(()=>{if(live)setChecking(false);});}else setChecking(false);return()=>{live=false;};},[taskId,revision.revision,editable,identity,checkAttempt]);
 function cliSelect(id:string,label:string){
   if(revision.localOrigin){const cli=(plan?.previewAgents??revision.preview?.previewAgents??[]).find(worker=>worker.nodeId===id)?.cli;return <span>{cli ? (cli==="codex"?"Codex CLI":"Kimi CLI") : "运行时由作者声明决定"} · 作者声明</span>;}
   if(execution){const assignment=execution.config?.assignments.find(item=>item.agentId===id)??execution.config?.defaultAssignment;return <span>{assignment?(assignment.cli==="codex"?"Codex CLI":"Kimi CLI"):"历史CLI配置未知"}</span>;}
   if(!editable&&!blockedConfirmReason){
     const cli=revision.preview?.previewAgents.find(worker=>worker.nodeId===id)?.cli;
     return <span>{cli==='codex'?'Codex CLI':cli==='kimi'?'Kimi CLI':'运行时决定'} · 源码声明</span>;
   }
   if(!plan){
     if(checking)return <span className="cli-pending" role="status">正在检查可用 CLI…</span>;
     if(planError)return <span>检查未完成 · 见下方错误</span>;
     return <span className="cli-pending">Wave Flow 处理结束后显示可用 CLI</span>;
   }
   if(plan.pool.length===0)return <span>没有已验证的 CLI</span>;
   if(plan.pool.length===1){const only=plan.pool[0]!;return <span>{only.cli==="codex"?"Codex CLI":"Kimi CLI"} {only.version} · 本机唯一已验证</span>;}
   const fallback=plan.harnessRuntime;
   return <select aria-label={`${label} CLI`} disabled={!editable||busy} value={choices[id]??fallback?.runtimeId??""} onChange={event=>setChoices(current=>{const next={...current,[id]:event.target.value};cliDrafts.set(identity,next);return next;})}>{plan.pool.map(runtime=><option key={runtime.runtimeId} value={runtime.runtimeId}>{runtime.cli==="codex"?"Codex CLI":"Kimi CLI"} · {runtime.version}</option>)}</select>;
 }
 function continuationSelect(nodeId:string){
   if(!plan?.continuationPlan)return null;
   const draft=workspaceDraft[nodeId]??{resources:"",workspaceId:crypto.randomUUID(),sources:"",workspaceGroup:nodeId};
   const selected=plan.continuationPlan.workspaces.some(item=>item.workspaceId===draft.workspaceId)?draft.workspaceId:"";
   return <label>本轮接续现场<select aria-label={`${nodeId} 接续现场`} disabled={!editable||busy} value={selected} onChange={event=>setWorkspaceDraft(current=>{const next={...current,[nodeId]:{...draft,workspaceId:event.target.value||crypto.randomUUID(),workspaceGroup:nodeId}};workspaceDrafts.set(identity,next);return next;})}><option value="">独立新分支（仍须显式整合集成原成果）</option>{plan.continuationPlan.workspaces.map(item=><option key={item.workspaceId} value={item.workspaceId}>{item.nodeIds.join(" / ")} · {item.ready?"已保存成果":"partial 未完成现场"} · {item.commit.slice(0,12)}</option>)}</select></label>;
 }
 async function run(){
   if(!editable||busy||checking||planError||!plan||!revision.localOrigin&&!plan.harnessRuntime)return;
   if(validateBeforeRun&&!validateBeforeRun())return;
   setBusy(true);try{
     let result:ExecutionResponse;
     if(revision.localOrigin){
       if(plan.workspacePlan){
         const localChoices:Record<string,string>={};for(const worker of plan.workers){if(!worker.cli)throw new Error(`本地写节点 ${worker.id} 的CLI必须为固定字面量。`);const runtimeId=plan.selectedByCli[worker.cli]??plan.pool.find(item=>item.cli===worker.cli)?.runtimeId;if(!runtimeId)throw new Error(`没有已验证的 ${worker.cli} Runtime。`);localChoices[worker.id]=runtimeId;}
         const workspaces=workspaceConfirmations.get(identity,plan.workspacePlan,workspaceDraft,excludeDirty,plan.continuationPlan);const confirmation=confirmations.get(identity,input,localChoices,plan,workspaces);result=await api.confirmWorkflow(taskId,revision.revision,confirmation.config,confirmation.id,plan.sceneEvidenceHash);}
       else {const key=`${identity}:${plan.sceneEvidenceHash??"first"}`;let requestId=localConfirmations.get(key);if(!requestId){requestId=crypto.randomUUID();localConfirmations.set(key,requestId);}result=await api.confirmWorkflow(taskId,revision.revision,undefined,requestId,plan.sceneEvidenceHash);}
     }
     else {
       let workspaces:ExecutionWorkspaceConfig|undefined;
       if(plan.workspacePlan){
         workspaces=workspaceConfirmations.get(identity,plan.workspacePlan,workspaceDraft,excludeDirty,plan.continuationPlan);
       }
       const confirmation=confirmations.get(identity,input,choices,plan,workspaces);result=revision.templateOrigin?await api.confirmTemplate(taskId,revision.revision,confirmation.config,confirmation.id,input,plan.sceneEvidenceHash):await api.confirmWorkflow(taskId,revision.revision,confirmation.config,confirmation.id,plan.sceneEvidenceHash);
     }
     onCreated(result);
   }catch(error){setError(error instanceof Error?error.message:String(error));}finally{setBusy(false);}
 }
 const titles=revision.preview?.phaseTitles??[];
 return <section className="workflow-design"><h3>Workflow 设计</h3>{groupWorkersByPhase(titles,plan?.previewAgents??revision.preview?.previewAgents??[]).map(group=><section key={group.key}><h4>{group.title}</h4>{group.workers.map(worker=><div className="workflow-design-row" key={worker.key}><strong>{worker.name}{worker.loop&&<small>循环/批量调用，数量由实际路径决定</small>}</strong>{cliSelect(worker.nodeId??"*",worker.name)}</div>)}</section>)}
   {plan?.workspacePlan&&<section className="workflow-workspace-config"><h4>Git 成果保存</h4><small>基准 {plan.workspacePlan.baseCommit?.slice(0,12)??"不可用"} · {plan.workspacePlan.dirtyPaths.length?`已有 ${plan.workspacePlan.dirtyPaths.length} 项改动`:"工作区干净"}。只在受管分支提交，不提交主工作区、不 push。</small>{plan.workspacePlan.diagnostic&&<p role="alert">{plan.workspacePlan.diagnostic}</p>}{plan.workspacePlan.dirtyPaths.length>0&&<label className="workspace-confirm"><input type="checkbox" checked={excludeDirty} onChange={event=>setExcludeDirty(event.target.checked)}/>明确排除当前 dirty 内容，仅从上述已提交基准创建 worktree</label>}{plan.workspacePlan.nodeIds.map(nodeId=>{const draft=workspaceDraft[nodeId]??{resources:"",workspaceId:crypto.randomUUID(),sources:"",workspaceGroup:nodeId};return <fieldset key={nodeId}><legend>{nodeId}</legend>{continuationSelect(nodeId)}<label>工作区分组（相同名称表示顺序复用同一 worktree）<input disabled={!editable||busy} value={draft.workspaceGroup??nodeId} onChange={event=>setWorkspaceDraft(current=>{const next={...current,[nodeId]:{...draft,workspaceGroup:event.target.value}};workspaceDrafts.set(identity,next);return next;})}/></label><label>外部独占资源（可选，每行一个）<textarea disabled={!editable||busy} value={draft.resources} onChange={event=>setWorkspaceDraft(current=>{const next={...current,[nodeId]:{...draft,resources:event.target.value}};workspaceDrafts.set(identity,next);return next;})}/></label><label>集成来源节点（可选，每行一个）<textarea disabled={!editable||busy} value={draft.sources??""} onChange={event=>setWorkspaceDraft(current=>{const next={...current,[nodeId]:{...draft,sources:event.target.value}};workspaceDrafts.set(identity,next);return next;})}/></label></fieldset>;})}<small>Worker 使用原生权限，Engine 不保证它无法修改其他目录；合入目标分支须事后审阅，不自动 push。</small></section>}
   {!!plan?.dynamicCount&&!revision.localOrigin&&<div className="workflow-design-row"><span>其余动态 Worker 默认使用</span>{cliSelect("*","动态Worker")}</div>}
   <small>设计来自源码声明；实际执行路径以运行记录为准。Worker 使用所选 CLI 的默认模型。{plan&&plan.pool.length===1&&editable&&"需要更多选择时，先在执行底座设置中验证其他 CLI。"}</small>
   {error&&<p role="alert">{error}</p>}
   {checking&&<small role="status">正在检查执行配置，参数和 CLI 选择已保留…</small>}
   {planError&&<><p role="alert">执行配置检查未完成：{planError}。参数与选择已保留，请重新检查后运行。</p>{editable&&<button type="button" className="button-secondary" disabled={checking||busy} onClick={()=>setCheckAttempt(attempt=>attempt+1)}>重新检查执行配置</button>}</>}
   {(editable||blockedConfirmReason)&&<div className="workflow-design-actions"><small>{editable?(plan?.workspacePlan?"确认后冻结方案与 CLI 分配并启动 Worker，同时授权 Engine 在受管 worktree 保存实际 Git 改动（不提交主工作区、不 push）；运行中不能再调整。":"确认后冻结方案与 CLI 分配并启动 Worker；运行中不能再调整。"):blockedConfirmReason}</small><div className="actions-group">{onAdjustViaChat&&<button type="button" className="button-secondary" onClick={onAdjustViaChat}>通过对话调整</button>}{onAbandonCard&&<button type="button" className="button-secondary" onClick={()=>void onAbandonCard()}>放弃此方案</button>}<button type="button" className="button-primary" disabled={!editable||busy||checking||!!planError||!plan||!revision.localOrigin&&!plan.harnessRuntime} onClick={()=>void run()}>{busy?"正在启动…":"确认并运行"}</button></div></div>}
 </section>;
}
