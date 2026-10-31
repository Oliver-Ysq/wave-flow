import {useEffect,useRef} from "react";
import {createPortal} from "react-dom";
import {ViewCache} from "../workbench-state";
import type {LeadSnapshot,WorkflowRevision} from "../types";
import {executionLabel} from "./task-activity";
import {proposalTitle} from "./workflow-summary";

const reading=new ViewCache<{top:number;unrunOpen:boolean;focus?:string}>(64);
/** 只收纳已被替换或明确放弃且从未执行的旧工作流；当前待确认在头部处理。 */
export function unusedWorkflows(task:LeadSnapshot):WorkflowRevision[]{
 const latest=task.workflowRevisions.at(-1)?.revision;
 const key=(item:WorkflowRevision)=>item.cardId??`revision:${item.revision}`;
 const executed=new Set(task.executions.map(run=>task.workflowRevisions.find(item=>item.revision===run.revision)).filter((item):item is WorkflowRevision=>!!item).map(key));
 const seen=new Set<string>();
 return [...task.workflowRevisions].sort((a,b)=>b.revision-a.revision).filter(item=>{
   const identity=key(item);
   if(executed.has(identity)||seen.has(identity)||(!item.abandonedAt&&item.revision===latest))return false;
   seen.add(identity);return true;
 });
}
const date=(value:string)=>new Date(value).toLocaleString("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});

/** 当前任务的只读历史索引；打开记录只导航，不批准或执行。 */
export function HistorySidebar({task,onClose,onPlan,onExecution,onResults}:{
 /** 原任务快照，记录身份不得按名称推断。 */task:LeadSnapshot;
 /** 收起侧栏并恢复历史入口焦点。 */onClose:()=>void;
 /** 查看原冻结方案。 */onPlan:(revision:WorkflowRevision)=>void;
 /** 查看原执行过程。 */onExecution:(id:string)=>void;
 /** 查看原执行结果。 */onResults:(id:string)=>void;
}){
 const saved=useRef(reading.get(task.leadRunId)??{top:0,unrunOpen:false});
 const panel=useRef<HTMLElement>(null),list=useRef<HTMLDivElement>(null),close=useRef<HTMLButtonElement>(null),unused=useRef<HTMLDetailsElement>(null);
 const unrun=unusedWorkflows(task);
 const closeRef=useRef(onClose);closeRef.current=onClose;
 useEffect(()=>{
   const element=panel.current;if(!element)return;
   const narrow=window.matchMedia('(max-width:1100px)');
   const backgrounds:Array<{element:HTMLElement;inert:boolean}>=[];
   const isolate=()=>{
     backgrounds.splice(0).forEach(item=>item.element.inert=item.inert);
     if(narrow.matches)for(const child of document.body.children){if(child!==element.parentElement&&child instanceof HTMLElement){backgrounds.push({element:child,inert:child.inert});child.inert=true;}}
   };
   isolate();narrow.addEventListener('change',isolate);
   const focusFrame=requestAnimationFrame(()=>{
     const restore=[...element.querySelectorAll<HTMLElement>('[data-history-focus]')].find(item=>item.dataset.historyFocus===saved.current.focus);
     const details=restore?.closest('details');if(details)details.open=true;
     (restore??close.current)?.focus({preventScroll:true});
   });
   const key=(event:KeyboardEvent)=>{
     if(event.isComposing)return;
     if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeRef.current();}
     if(event.key==='Tab'&&narrow.matches){
       const items=[...element.querySelectorAll<HTMLElement>('button:not(:disabled),summary,[tabindex="0"]')].filter(item=>item.getClientRects().length>0&&item.tabIndex>=0&&(!item.closest('details:not([open])')||item.tagName==='SUMMARY')),first=items[0],last=items.at(-1);
       if(!element.contains(document.activeElement)){event.preventDefault();first?.focus();}
       else if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
       else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
     }
   };
   document.addEventListener('keydown',key,true);
   return()=>{cancelAnimationFrame(focusFrame);document.removeEventListener('keydown',key,true);narrow.removeEventListener('change',isolate);backgrounds.forEach(item=>item.element.inert=item.inert);};
 },[]);
 useEffect(()=>{if(list.current)list.current.scrollTop=saved.current.top;},[]);
 const remember=()=>{saved.current={...saved.current,top:list.current?.scrollTop??0,unrunOpen:unused.current?.open??false};reading.set(task.leadRunId,saved.current);};
 const open=(focus:string,action:()=>void)=>{remember();saved.current.focus=focus;reading.set(task.leadRunId,saved.current);action();};
 return createPortal(<div className="history-sidebar-layer" onClickCapture={event=>{const button=(event.target as HTMLElement).closest<HTMLElement>('[data-history-focus]');if(button){saved.current.focus=button.dataset.historyFocus;reading.set(task.leadRunId,saved.current);}}}><div className="history-sidebar-scrim" onClick={onClose}/><aside ref={panel} className="history-sidebar" aria-label="历史">
   <header><h2>历史</h2><button ref={close} onClick={onClose} aria-label="关闭历史">×</button></header>
   <div ref={list} className="history-record-list" aria-label="运行过的工作" onScroll={remember}>
     {!task.executions.length&&<p className="history-empty">还没有运行过的工作。</p>}{[...task.executions].reverse().map(item=>{
       const plan=task.workflowRevisions.find(value=>value.revision===item.revision);
       const ended=item.finishedAt!==null;
       return <button type="button" className="history-work-row" key={item.executionId} data-history-focus={`work-${item.executionId}`} aria-label={`${plan?proposalTitle(plan):'历史工作'}，${executionLabel(item)}，${ended?'查看结果':'查看进度'}`} onClick={()=>open(`work-${item.executionId}`,()=>ended?onResults(item.executionId):onExecution(item.executionId))}><strong>{plan?proposalTitle(plan):'历史工作'}</strong><span className="history-work-meta"><span>{executionLabel(item)}</span><time dateTime={item.createdAt}>{date(item.createdAt)}</time></span></button>;
     })}
     {unrun.length>0&&<details ref={unused} className="history-unused" open={saved.current.unrunOpen} onToggle={remember}><summary>查看未运行的工作流 <span>{unrun.length}</span></summary>{unrun.map(item=>{const identity=`plan-${item.cardId??item.revision}`;return <button type="button" className="history-work-row" key={identity} data-history-focus={identity} onClick={()=>open(identity,()=>onPlan(item))}><strong>{proposalTitle(item)}</strong><span className="history-work-meta"><span>{item.abandonedAt?'已放弃 · 未运行':'未运行'}</span><time dateTime={item.createdAt}>{date(item.createdAt)}</time></span></button>;})}</details>}
   </div>
 </aside></div>,document.body);
}
