import type { HarnessSnapshot } from "./types";
import { composeConversationTurns } from "./conversation/harness-event-merge";

/** 同档案耐久序号较旧时拒绝覆盖；身份不同不合并。 */
export function newerTaskSnapshot(current:HarnessSnapshot,next:HarnessSnapshot):HarnessSnapshot {
  if(current.harnessRunId!==next.harnessRunId)return current;
  return (current.snapshotSequence??0)>(next.snapshotSequence??0)?current:next;
}

/** 详情导航组合身份校验；旧版本/执行/attempt不匹配时不展示其他记录。 */
export function routeMatchesTask(task:HarnessSnapshot,route:import("./workbench-navigation").WorkbenchRoute):boolean {
  if(route.kind!=="workflow")return true;
  if(route.taskId!==task.harnessRunId)return false;
  const revision=task.workflowRevisions.find(item=>item.revision===route.revision);
  if(!revision||(revision.cardId??`legacy:${revision.revision}`)!==route.cardId)return false;
  if(route.executionId&&!task.executions.some(item=>item.executionId===route.executionId&&item.revision===route.revision))return false;
  return route.attempt===undefined||Number.isInteger(route.attempt)&&route.attempt>0&&!!route.executionId;
}

/** 会话内 LRU，最大条目数默认 64；只保留视图状态，不落盘敏感输入。 */
export class ViewCache<T> {
  private values = new Map<string,T>();
  constructor(private readonly limit = 64) {if(!Number.isInteger(limit)||limit<1)throw new Error("视图缓存容量必须为正整数。");}
  get(key:string):T|undefined { const value=this.values.get(key);if(value!==undefined){this.values.delete(key);this.values.set(key,value);}return value; }
  set(key:string,value:T):void { this.values.delete(key);this.values.set(key,value);while(this.values.size>this.limit)this.values.delete(this.values.keys().next().value!); }
}
/** 按资源与 generation 防止旧响应覆盖；失效不取消后台业务操作。 */
export class RequestFence {
  private generation=0;
  private serial=0;
  private latest=new Map<string,number>();
  advance():void { this.generation++;this.latest.clear(); }
  begin(key:string):()=>boolean { const generation=this.generation,serial=++this.serial;this.latest.delete(key);this.latest.set(key,serial);if(this.latest.size>256)this.latest.delete(this.latest.keys().next().value!);return ()=>generation===this.generation&&this.latest.get(key)===serial; }
}

/** 对象级动作租约；旧动作 finally 不能清除同对象后来动作的加载状态。 */
export class OperationTracker {
  private serial=0;
  private active=new Map<string,{token:number;action:string}>();
  begin(owner:string,action:string):()=>boolean {const token=++this.serial;this.active.set(owner,{token,action});return()=>{if(this.active.get(owner)?.token!==token)return false;this.active.delete(owner);return true;};}
  action(owner:string):string|null {return this.active.get(owner)?.action??null;}
}
/** 未读只取完整耐久正文/原消息/版本身份，不把 delta 当作消息。 */
export function unreadIdentities(task:HarnessSnapshot):string[] {
  return [...composeConversationTurns(task).flatMap(turn=>{
    const bodies=turn.entries.filter(entry=>entry.kind==="body"&&entry.completed);
    return bodies.length ? bodies.map(entry=>`body:${entry.entryId}`) : turn.assistant ? [`message:${turn.assistant.id}`] : [];
  }),...task.workflowRevisions.map(revision=>`revision:${revision.revision}`),...(task.executionHistory??[]).map(event=>event.key)];
}
/** 阅读标记只保存稳定身份；首次载入历史记录设基线，不把全部历史当未读。 */
export class UnreadTracker {
  private seen=new ViewCache<Set<string>>();
  count(task:HarnessSnapshot,reading:boolean):number {
    const ids=unreadIdentities(task),prior=this.seen.get(task.harnessRunId);
    if(!prior||reading){this.seen.set(task.harnessRunId,new Set(ids));return 0;}
    return ids.filter(id=>!prior.has(id)).length;
  }
  /** 仅标记当前视口已展示的稳定身份；不会把离屏新消息全量标已读。 */
  mark(taskId:string,ids:readonly string[]):void { const seen=this.seen.get(taskId)??new Set<string>();for(const id of ids)seen.add(id);this.seen.set(taskId,seen); }
}
