import {useEffect,useRef} from 'react';
import type {HarnessSnapshot,WorkflowRevision} from '../types';

/** 同一工作流的展示版本；缺cardId的旧记录独立处理，不按名称合并。 */
export function workflowVersions(task:HarnessSnapshot,revision:WorkflowRevision):WorkflowRevision[]{
 return task.workflowRevisions.filter(item=>revision.cardId?item.cardId===revision.cardId:item.revision===revision.revision).sort((a,b)=>a.revision-b.revision);
}
/** 用户可见序号，仅多版本显示；内部revision与批准身份保持不变。 */
export function visibleVersion(task:HarnessSnapshot,revision:WorkflowRevision):number|null{
 const versions=workflowVersions(task,revision);
 const index=versions.findIndex(item=>item.revision===revision.revision);
 return versions.length>1&&index>=0?index+1:null;
}
/** 当前同工作流最新版与旧版的标签；单版本或不属于快照时不显示。 */
export function versionLabel(task:HarnessSnapshot,revision:WorkflowRevision):string|null{
 const number=visibleVersion(task,revision);
 if(number===null)return null;
 const current=workflowVersions(task,revision).at(-1)?.revision===revision.revision;
 return `${current?'当前版本':'历史版本'} · 第 ${number} 版`;
}
/** 右上浮动历史版本列表；只导航原版本，不执行或批准。 */
export function WorkflowVersions({versions,selected,onSelect}:{
 /** 同工作流按内部序号排序的原记录。 */versions:WorkflowRevision[];
 /** 当前读取的内部revision。 */selected:number;
 /** 明确切换原方案，仅修改阅读路由。 */onSelect:(revision:number)=>void;
}){
 const menu=useRef<HTMLDetailsElement>(null);
 useEffect(()=>{const close=(event:PointerEvent)=>{if(!menu.current?.contains(event.target as Node))menu.current?.removeAttribute('open');};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[]);
 if(versions.length<2)return null;
 return <details ref={menu} className="workflow-version-menu" onKeyDown={event=>{
   if(event.nativeEvent.isComposing)return;
   const summary=menu.current?.querySelector<HTMLElement>('summary');
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();menu.current!.open=false;summary?.focus();}
   if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
     event.preventDefault();menu.current!.open=true;
     const items=[...menu.current!.querySelectorAll<HTMLButtonElement>('button')],index=items.indexOf(document.activeElement as HTMLButtonElement);
     const next=event.key==='Home'?0:event.key==='End'?items.length-1:event.key==='ArrowDown'?(index+1)%items.length:(index<0?items.length-1:(index-1+items.length)%items.length);
     items[next]?.focus();
   }
 }}><summary>历史版本</summary><div className="workflow-version-options" aria-label="工作流历史版本">{[...versions].reverse().map(item=>{const number=versions.findIndex(version=>version.revision===item.revision)+1;return <button type="button" key={item.revision} aria-current={selected===item.revision?'true':undefined} onClick={()=>{menu.current!.open=false;onSelect(item.revision);requestAnimationFrame(()=>menu.current?.querySelector<HTMLElement>('summary')?.focus());}}>第 {number} 版{item.revision===versions.at(-1)?.revision?' · 最新':''}{selected===item.revision?' · 正在查看':''}</button>;})}</div></details>;
}
