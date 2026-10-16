import {useEffect,useRef,useState} from "react";
import {api} from "./api";
import {CompactParameterForm as ParameterForm} from "./forms/compact-parameter-form";
import {ViewCache} from "./workbench-state";
import type {WorkflowTemplate} from "../../../src/harness/workflow-templates";
import type {TemplateSelection} from "../../../src/harness/task-contract";
import {suggestedParameters} from "./forms/parameter-defaults";
const drafts=new ViewCache<Record<string,unknown>>(64);

/** 目录选择和参数准备；选择不保存，明确保存才调用父级事务。 */
export function TemplatePicker({identity,blockedReason,onSave,onClose}:{
 /** 原项目/任务稳定身份，防止草稿串页。 */ identity:string;
 /** 主控或执行忙碌理由，保留面板但禁提交。 */ blockedReason?:string;
 /** 用户明确保存请求，调用方区分新Task/同Task候选。 */ onSave:(selection:TemplateSelection,requestId:string)=>Promise<void>;
 /** 明确返回原页面，不删除耐久候选。 */ onClose:()=>void;
}){
 const [templates,setTemplates]=useState<WorkflowTemplate[]>([]),[selected,setSelected]=useState<string>("");
 const [failure,setFailure]=useState<string|null>(null),[busy,setBusy]=useState(false);
 const request=useRef<{payload:string;id:string}|null>(null);
 const guidanceRequest=useRef<{payload:string;id:string}|null>(null);
 const pending=useRef(false);
 const panel=useRef<HTMLElement>(null);
 const closeRef=useRef(onClose);closeRef.current=onClose;
 useEffect(()=>{
   const prior=document.activeElement as HTMLElement|null;
   const obscured=[...document.querySelectorAll<HTMLElement>("main>section,main>aside")].filter(item=>!item.contains(panel.current));
   const previousInert=obscured.map(item=>item.inert);
   obscured.forEach(item=>{item.inert=true;});
   panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
   const keydown=(event:KeyboardEvent)=>{
     if(event.isComposing)return;
     if(event.key==="Escape"){event.preventDefault();closeRef.current();}
     if(event.key==="Tab"){
       const controls=[...panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')??[]].filter(item=>item.getClientRects().length>0);
       const first=controls[0],last=controls.at(-1);
       if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
       else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
     }
   };
   document.addEventListener("keydown",keydown);
   return()=>{document.removeEventListener("keydown",keydown);obscured.forEach((item,index)=>{item.inert=previousInert[index]!;});if(prior?.isConnected)prior.focus();};
 },[]);
 useEffect(()=>{let live=true;void api.templates().then(result=>{if(live){setTemplates(result.templates);setSelected(result.templates[0]?.id??"");}}).catch(error=>{if(live)setFailure(String(error));});return()=>{live=false;};},[]);
 const template=templates.find(item=>item.id===selected);
 const key=template?`${identity}:${template.id}:${template.version}:${template.sourceHash}`:identity;
 return <section ref={panel} role="dialog" aria-modal="true" className="connection-panel template-picker" aria-label="选择工作流">
   <header><h2>选择工作流</h2><button type="button" onClick={onClose}>返回</button></header>
   <div className="task-source-options"><button aria-pressed="true">预置工作流</button><button disabled>本地工作流 · 尚未开放</button></div>
   <label>预置模板<select value={selected} onChange={event=>setSelected(event.target.value)}>{templates.map(item=><option key={item.id} value={item.id}>{item.meta.name} · v{item.version}</option>)}</select></label>
   {template&&<><h3>{template.meta.description}</h3><p>{template.explanation}</p><p>选择和填写不会执行。准备后在 Workflow 设计中确认参数与 CLI，再运行。</p>
     <button type="button" disabled={busy||!!blockedReason} onClick={async()=>{
       if(pending.current)return;pending.current=true;
       const selection={id:template.id,version:template.version,sourceHash:template.sourceHash,input:suggestedParameters(template.inputSchema,drafts.get(key)??{}),needsGuidance:true} as TemplateSelection;
       const payload=JSON.stringify(selection);if(guidanceRequest.current?.payload!==payload)guidanceRequest.current={payload,id:crypto.randomUUID()};
       setBusy(true);try{await onSave(selection,guidanceRequest.current.id);}catch(error){setFailure(String(error));}finally{pending.current=false;setBusy(false);}
     }}>让主控帮我准备参数</button>
     <ParameterForm identity={key} key={key} schema={template.inputSchema} initialValue={suggestedParameters(template.inputSchema,drafts.get(key)??{})} busy={busy} blockedReason={blockedReason} onDraft={input=>drafts.set(key,input)} onSubmit={async input=>{
       if(busy)return;
       const selection={id:template.id,version:template.version,sourceHash:template.sourceHash,input} as TemplateSelection;
       const payload=JSON.stringify(selection);
       if(request.current?.payload!==payload)request.current={payload,id:crypto.randomUUID()};
       setBusy(true);try{await onSave(selection,request.current.id);}finally{setBusy(false);}
     }}/>
   </>}
   {failure&&<p role="alert">{failure}</p>}
 </section>;
}
