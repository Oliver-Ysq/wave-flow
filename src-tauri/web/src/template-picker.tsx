import {useEffect,useRef,useState} from "react";
import {api} from "./api";
import {CompactParameterForm as ParameterForm} from "./forms/compact-parameter-form";
import {ViewCache} from "./workbench-state";
import type {WorkflowTemplate} from "../../../src/harness/workflow-templates";
import type {TemplateSelection} from "../../../src/harness/task-contract";
import {suggestedParameters} from "./forms/parameter-defaults";
import {WorkflowSourceDialog} from "./workflow-source-dialog";
import {userFacingText} from "./user-facing-text";
const drafts=new ViewCache<Record<string,unknown>>(64);

/** 目录选择和参数准备；选择不保存，明确保存才调用父级事务。 */
export function TemplatePicker({identity,blockedReason,onSave,onClose}:{
 /** 原项目/任务稳定身份，防止草稿串页。 */ identity:string;
 /** 主控或执行忙碌理由，保留面板但禁提交。 */ blockedReason?:string;
 /** 用户明确保存请求，调用方区分新Task/同Task候选；description 是所选预置的已验证说明。 */ onSave:(selection:TemplateSelection,requestId:string,description:string)=>Promise<void>;
 /** 明确返回原页面，不删除耐久候选。 */ onClose:()=>void;
}){
 const [templates,setTemplates]=useState<WorkflowTemplate[]>([]),[selected,setSelected]=useState<string>("");
 const [failure,setFailure]=useState<string|null>(null),[busy,setBusy]=useState(false);
 const request=useRef<{payload:string;id:string}|null>(null);
 const guidanceRequest=useRef<{payload:string;id:string}|null>(null);
 const pending=useRef(false);
 useEffect(()=>{let live=true;void api.templates().then(result=>{if(live){setTemplates(result.templates);setSelected(result.templates[0]?.id??"");}}).catch(error=>{if(live)setFailure(String(error));});return()=>{live=false;};},[]);
 const template=templates.find(item=>item.id===selected);
 const key=template?`${identity}:${template.id}:${template.version}:${template.sourceHash}`:identity;
 const templateTitles:Record<string,string>={"code-review":"代码审查","deep-research":"深度调研","deep-cr":"深度代码审查"};
 const titleOf=(item:WorkflowTemplate)=>templateTitles[item.id]??item.meta.name;
 return <WorkflowSourceDialog title="预置工作流" onClose={onClose}>
   {!template&&!failure&&<p role="status">正在读取预置工作流…</p>}
   {templates.length>1&&<label>工作流<select value={selected} onChange={event=>setSelected(event.target.value)}>{templates.map(item=><option key={item.id} value={item.id}>{titleOf(item)}</option>)}</select></label>}
   {template&&<><div className="source-workflow-intro"><h3>{titleOf(template)}</h3><p>{template.explanation}</p></div>
     <ParameterForm identity={key} key={key} schema={template.inputSchema} initialValue={suggestedParameters(template.inputSchema,drafts.get(key)??{})} busy={busy} blockedReason={blockedReason} onDraft={input=>drafts.set(key,input)} onSubmit={async input=>{
       if(busy)return;
       const selection={id:template.id,version:template.version,sourceHash:template.sourceHash,input} as TemplateSelection;
       const payload=JSON.stringify(selection);
       if(request.current?.payload!==payload)request.current={payload,id:crypto.randomUUID()};
       setBusy(true);try{await onSave(selection,request.current.id,template.meta.description);}finally{setBusy(false);}
     }}/>
     <button className="source-guidance" type="button" disabled={busy||!!blockedReason} onClick={async()=>{
       if(pending.current)return;pending.current=true;
       const selection={id:template.id,version:template.version,sourceHash:template.sourceHash,input:suggestedParameters(template.inputSchema,drafts.get(key)??{}),needsGuidance:true} as TemplateSelection;
       const payload=JSON.stringify(selection);if(guidanceRequest.current?.payload!==payload)guidanceRequest.current={payload,id:crypto.randomUUID()};
       setBusy(true);try{await onSave(selection,guidanceRequest.current.id,template.meta.description);}catch(error){setFailure(String(error));}finally{pending.current=false;setBusy(false);}
     }}>Wave Flow 帮我填</button>
   </>}
   <p className="source-safety-note">保存后可检查方案与 CLI，再确认运行。现在不会执行。</p>
   {failure&&<p role="alert">{userFacingText(failure)}</p>}
 </WorkflowSourceDialog>;
}
