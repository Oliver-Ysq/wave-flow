import { useRef, useState } from "react";
import { api } from "./api";
import type { LocalWorkflowPreflight } from "../../../src/workflow/preflight-local";
import {CompactParameterForm} from "./forms/compact-parameter-form";
import type {HarnessRunResponse} from "./types";
import {open} from "@tauri-apps/plugin-dialog";
import {WorkflowSourceDialog} from "./workflow-source-dialog";
import {userFacingText} from "./user-facing-text";

/** 本地来源预检与参数保存；候选永不自动执行。 */
export function LocalWorkflowPreview({projectId,onClose,onPrepared,replacement,revision}:{
 /** 原路径修订；只重新预检该文件，参数使用旧冻结输入初填，不允许换文件。 */revision?:{harnessRunId:string;baseRevision:number;path:string;input:Record<string,unknown>};
 /** 已显式放弃且未执行的目标态Task；有值时同链换来源，不创建第二个Task。 */replacement?:{harnessRunId:string;baseRevision:number};
 /** Project Store稳定身份，不能从用户路径推断项目。 */projectId:string;
 /** 返回原草稿，预检不产生可删除运行档案。 */onClose:()=>void;
 /** 明确保存后的Task，父页面只导航到原版本，不自动运行。 */onPrepared:(result:HarnessRunResponse)=>void;
}){
 const [path,setPath]=useState(revision?.path??""),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 const [result,setResult]=useState<Omit<LocalWorkflowPreflight,"source">|null>(null);
 const serial=useRef(0);
 const saveRequest=useRef<{payload:string;id:string}|null>(null);
 return <WorkflowSourceDialog title="本地工作流" onClose={()=>{serial.current++;onClose();}}>
   <p>从当前项目选择 TypeScript 工作流，先检查，再准备运行。</p>
   <label>工作流文件<input value={path} disabled={busy||!!revision} onChange={event=>{setPath(event.target.value);setResult(null);setError(null);}} placeholder="选择文件，或输入项目内 .ts 文件路径" /></label>
   {!revision&&<button type="button" disabled={busy} onClick={async()=>{try{const selected=await open({multiple:false,directory:false,filters:[{name:"TypeScript Workflow",extensions:["ts"]}]});if(typeof selected==="string"){setPath(selected);setResult(null);setError(null);}}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}}}>选择工作流文件</button>}
   <button className={path.trim()?"button-primary":""} type="button" disabled={busy||!path.trim()} onClick={async()=>{
     const token=++serial.current;setBusy(true);setError(null);setResult(null);
     try{const value=await api.preflightLocal(projectId,path.trim());if(serial.current===token)setResult(value);}
     catch(cause){if(serial.current===token)setError(cause instanceof Error?cause.message:String(cause));}
     finally{if(serial.current===token)setBusy(false);}
   }}>{busy?"正在静态检查…":"检查文件"}</button>
   <p className="source-safety-note">检查不会运行脚本，也不会创建任务。</p>
   {error&&<p role="alert">{error.startsWith("ENOENT:")?"找不到工作流文件，请检查路径，或重新选择文件。":userFacingText(error)}</p>}
   {result&&<><div role="status"><h3>静态预检通过：{result.meta.description}</h3><p>{result.meta.phases.map(phase=>phase.title).join(" / ")}</p><p>填写参数保存候选，不会自动运行。确认执行时会复核冻结版本和当前现场。</p></div><CompactParameterForm identity={`${projectId}:${result.sourceHash}`} schema={result.inputSchema} initialValue={revision?.input??result.meta.exampleArgs??{}} busy={busy} onSubmit={async input=>{const payload=JSON.stringify({projectId,path:result.path,hash:result.sourceHash,input,replacement,revision});if(saveRequest.current?.payload!==payload)saveRequest.current={payload,id:crypto.randomUUID()};setBusy(true);try{onPrepared(revision?await api.reviseLocalTask(revision.harnessRunId,revision.baseRevision,result.sourceHash,input,saveRequest.current.id):replacement?await api.reviseLocalTask(replacement.harnessRunId,replacement.baseRevision,result.sourceHash,input,saveRequest.current.id,result.path):await api.createLocalTask(projectId,result.path,result.sourceHash,input,saveRequest.current.id));}finally{setBusy(false);}}}/></>}
 </WorkflowSourceDialog>;
}
