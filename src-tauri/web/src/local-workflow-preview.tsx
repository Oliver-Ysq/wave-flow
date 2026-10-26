import { useRef, useState } from "react";
import { api } from "./api";
import type { LocalWorkflowPreflight } from "../../../src/workflow/preflight-local";
import {CompactParameterForm} from "./forms/compact-parameter-form";
import type {HarnessRunResponse} from "./types";
import {open} from "@tauri-apps/plugin-dialog";
import {WorkflowSourceDialog} from "./workflow-source-dialog";
import {userFacingText} from "./user-facing-text";

/**
 * 在途预检请求的最新令牌守卫。路径或文件选择变化时必须立即 invalidate，
 * 此后旧请求的响应、错误与 finally 一律失效，不能复活旧结果或污染新路径。
 */
export type LatestRequestGuard = {
  /** 使所有在途请求失效；返回的新令牌不属于任何旧请求。 */
  readonly invalidate: () => void;
  /** 发起一次新请求并返回其令牌。 */
  readonly begin: () => number;
  /** 令牌是否仍然有效。 */
  readonly active: (token: number) => boolean;
};

/** 创建令牌单调递增的守卫；begin 与 invalidate 都会使旧令牌失效。 */
export function createLatestRequestGuard(): LatestRequestGuard {
  let token = 0;
  return { invalidate: () => { token += 1; }, begin: () => ++token, active: (mine) => mine === token };
}

/**
 * 执行受守卫的异步请求；只有令牌仍有效时才交付结果、错误或完成回调，
 * 迟到的旧响应在任何分支都不会触碰新路径的状态。
 */
export async function runGuarded<T>(guard: LatestRequestGuard, token: number, task: () => Promise<T>, sinks: {
  /** 结果仍有效时交付。 */ readonly onResult: (value: T) => void;
  /** 错误仍有效时交付。 */ readonly onError: (cause: unknown) => void;
  /** 请求仍有效时的收尾（如解除忙碌）。 */ readonly onSettled: () => void;
}): Promise<void> {
  try { const value = await task(); if (guard.active(token)) sinks.onResult(value); }
  catch (cause) { if (guard.active(token)) sinks.onError(cause); }
  finally { if (guard.active(token)) sinks.onSettled(); }
}

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
 const guard=useRef(createLatestRequestGuard()).current;
 const saveRequest=useRef<{payload:string;id:string}|null>(null);
 /** 路径或文件选择变化：旧预检立即失效并解除忙碌，迟到响应不能复活旧结果。 */
 const changePath=(value:string)=>{guard.invalidate();setPath(value);setResult(null);setError(null);setBusy(false);};
 return <WorkflowSourceDialog title="本地工作流" onClose={()=>{guard.invalidate();onClose();}}>
   {!result&&<p className="local-workflow-intro">选择项目内的工作流文件。</p>}
   <label className="local-workflow-file-label" htmlFor="local-workflow-path">工作流文件</label>
   <div className="local-workflow-file-row">
   <input id="local-workflow-path" value={path} disabled={busy||!!revision} onChange={event=>changePath(event.target.value)} placeholder="选择文件，或输入项目内 .ts 文件路径" />
   <div className="local-workflow-file-actions">
   {!revision&&<button type="button" disabled={busy} onClick={async()=>{try{const selected=await open({multiple:false,directory:false,filters:[{name:"TypeScript Workflow",extensions:["ts"]}]});if(typeof selected==="string")changePath(selected);}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}}}>选择工作流文件</button>}
   <button className={path.trim()?"button-primary":""} type="button" disabled={busy||!path.trim()} onClick={()=>{
     const token=guard.begin();setBusy(true);setError(null);setResult(null);
     void runGuarded(guard,token,()=>api.preflightLocal(projectId,path.trim()),{
       onResult:value=>setResult(value),
       onError:cause=>setError(cause instanceof Error?cause.message:String(cause)),
       onSettled:()=>setBusy(false),
     });
   }}>{busy?"正在静态检查…":"检查文件"}</button>
   </div>
   </div>
   {!result&&<p className="source-safety-note local-workflow-safety-note">检查不会运行脚本。</p>}
   {error&&<p role="alert">{error.startsWith("ENOENT:")?"找不到工作流文件，请检查路径，或重新选择文件。":userFacingText(error)}</p>}
   {result&&<><div className="source-preflight-status" role="status"><strong>{result.meta.description}</strong><small>文件已检查</small></div><details className="source-check-details"><summary>检查详情</summary><p>{result.path}</p><p>阶段：{result.meta.phases.map(phase=>phase.title).join(" / ")}</p><p>仅做静态检查；执行前会再次核对文件和运行条件。</p></details><CompactParameterForm identity={`${projectId}:${result.sourceHash}`} schema={result.inputSchema} initialValue={revision?.input??result.meta.exampleArgs??{}} busy={busy} onSubmit={async input=>{const payload=JSON.stringify({projectId,path:result.path,hash:result.sourceHash,input,replacement,revision});if(saveRequest.current?.payload!==payload)saveRequest.current={payload,id:crypto.randomUUID()};setBusy(true);try{onPrepared(revision?await api.reviseLocalTask(revision.harnessRunId,revision.baseRevision,result.sourceHash,input,saveRequest.current.id):replacement?await api.reviseLocalTask(replacement.harnessRunId,replacement.baseRevision,result.sourceHash,input,saveRequest.current.id,result.path):await api.createLocalTask(projectId,result.path,result.sourceHash,input,saveRequest.current.id));}finally{setBusy(false);}}}/><p className="source-safety-note">保存后不会立即运行。</p></>}
 </WorkflowSourceDialog>;
}
