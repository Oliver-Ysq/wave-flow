import {useEffect,useState} from "react";
import {api} from "./api";
import type {ExecutionPlanResponse,ExecutionResponse,WorkflowRevision,WorkflowExecution} from "./types";
import {ViewCache} from "./workbench-state";
import {DesignConfirmationCache} from "./workflow-design-config";
import {groupWorkersByPhase} from "./conversation/plan-groups";
const cliDrafts=new ViewCache<Record<string,string>>(64);
const plans=new ViewCache<ExecutionPlanResponse>(64);
const confirmations=new DesignConfirmationCache();
const localConfirmations=new ViewCache<string>(64);

/** Workflow设计与CLI内联选择；只有确认按钮发起执行，读取计划不调度Worker。 */
export function WorkflowDesign({taskId,revision,editable,onCreated,input,execution,validateBeforeRun}:{
 /** 确认前由参数区校验并定位错误；false不发请求、不批准。 */ validateBeforeRun?:()=>boolean;
 /** 此版本的原执行，历史CLI以冻结配置为准，不拿源码字面量冒充生效值。 */ execution?:WorkflowExecution;
 /** 参数区当前完整草稿；确认时校验并耐久，不要求先单独保存。 */ input?:Record<string,unknown>;
 /** 原Task UUID，响应不能控制其他任务。 */ taskId:string;
 /** 展示与批准绑定的不可变版本。 */ revision:WorkflowRevision;
 /** 当前候选资格，后台忙碌时保留列表但禁运行。 */ editable:boolean;
 /** 原Execution创建结果，父层按身份处理。 */ onCreated:(result:ExecutionResponse)=>void;
}){
 const identity=`${taskId}:${revision.cardId??"legacy"}:${revision.revision}`;
 const [plan,setPlan]=useState<ExecutionPlanResponse|null>(plans.get(identity)??null),[error,setError]=useState<string|null>(null);
 const [choices,setChoices]=useState<Record<string,string>>(cliDrafts.get(identity)??{}),[busy,setBusy]=useState(false);
 const [checking,setChecking]=useState(false),[checkAttempt,setCheckAttempt]=useState(0);
 const [planError,setPlanError]=useState<string|null>(null);
 const local=!!revision.localOrigin;
 useEffect(()=>{let live=true;if(editable){setChecking(true);void api.planExecution(taskId,revision.revision).then(result=>{if(live){plans.set(identity,result);setPlan(result);setPlanError(local||result.harnessRuntime?null:"尚未设置已验证主控 CLI，请在执行底座设置中验证并选择。");}}).catch(error=>{if(live&&!String(error).includes("主控必须空闲"))setPlanError(error instanceof Error?error.message:String(error));}).finally(()=>{if(live)setChecking(false);});}else setChecking(false);return()=>{live=false;};},[taskId,revision.revision,editable,identity,checkAttempt]);
 function cliSelect(id:string,label:string){
   if(revision.localOrigin){const cli=(plan?.previewAgents??revision.preview?.previewAgents??[]).find(worker=>worker.nodeId===id)?.cli;return <span>{cli ? (cli==="codex"?"Codex":"Kimi") : "运行时由作者声明决定"} · 作者声明</span>;}
   if(execution){const assignment=execution.config?.assignments.find(item=>item.agentId===id)??execution.config?.defaultAssignment;return <span>{assignment?(assignment.cli==="codex"?"Codex":"Kimi"):"历史CLI配置未知"}</span>;}
   if(!plan)return <span>跟随主控 CLI</span>;
   const fallback=plan.harnessRuntime;
   if(plan.pool.length===1)return <span>{plan.pool[0]!.cli=== "codex"?"Codex":"Kimi"}</span>;
   return <select aria-label={`${label} CLI`} disabled={!editable||busy} value={choices[id]??fallback?.runtimeId??""} onChange={event=>setChoices(current=>{const next={...current,[id]:event.target.value};cliDrafts.set(identity,next);return next;})}>{plan.pool.map(runtime=><option key={runtime.runtimeId} value={runtime.runtimeId}>{runtime.cli==="codex"?"Codex":"Kimi"} · {runtime.version}</option>)}</select>;
 }
 async function run(){
   if(!editable||busy||checking||planError||!plan||!revision.localOrigin&&!plan.harnessRuntime)return;
   if(validateBeforeRun&&!validateBeforeRun())return;
   setBusy(true);try{
     let result:ExecutionResponse;
     if(revision.localOrigin){let requestId=localConfirmations.get(identity);if(!requestId){requestId=crypto.randomUUID();localConfirmations.set(identity,requestId);}result=await api.confirmWorkflow(taskId,revision.revision,undefined,requestId);}
     else {const confirmation=confirmations.get(identity,input,choices,plan);result=revision.templateOrigin?await api.confirmTemplate(taskId,revision.revision,confirmation.config,confirmation.id,input):await api.confirmWorkflow(taskId,revision.revision,confirmation.config,confirmation.id);}
     onCreated(result);
   }catch(error){setError(error instanceof Error?error.message:String(error));}finally{setBusy(false);}
 }
 const titles=revision.preview?.phaseTitles??[];
 return <section className="workflow-design"><h3>Workflow 设计</h3>{groupWorkersByPhase(titles,plan?.previewAgents??revision.preview?.previewAgents??[]).map(group=><section key={group.key}><h4>{group.title}</h4>{group.workers.map(worker=><div className="workflow-design-row" key={worker.key}><strong>{worker.name}{worker.loop&&<small>循环/批量调用，数量由实际路径决定</small>}</strong>{cliSelect(worker.nodeId??"*",worker.name)}</div>)}</section>)}
   {!!plan?.dynamicCount&&!revision.localOrigin&&<div className="workflow-design-row"><span>其余动态 Worker 默认使用</span>{cliSelect("*","动态Worker")}</div>}
   <small>设计来自源码声明；实际执行路径以运行记录为准。CLI 使用自身默认模型。</small>
   {error&&<p role="alert">{error}</p>}
   {checking&&<small role="status">正在检查执行配置，参数和 CLI 选择已保留…</small>}
   {planError&&<><p role="alert">执行配置检查未完成：{planError}。参数与选择已保留，请重新检查后运行。</p>{editable&&<button type="button" className="button-secondary" disabled={checking||busy} onClick={()=>setCheckAttempt(attempt=>attempt+1)}>重新检查执行配置</button>}</>}
   {editable&&<button disabled={busy||checking||!!planError||!plan||!revision.localOrigin&&!plan.harnessRuntime} onClick={()=>void run()}>{busy?"正在启动…":"确认并运行"}</button>}
 </section>;
}
