import {Fragment,useState,type ReactNode} from 'react';
import type {WorkflowRevision} from '../types';

/** 使用保存入口的事实，不从源码差异或自然语言猜更新原因。 */
export function planUpdateLabel(revision:WorkflowRevision):string{
 const labels={'save-template':'保存预置方案','save-local':'保存本地方案','generate-plan':'生成方案','modify-plan':'修改方案','modify-parameters':'修改执行参数','modify-configuration':'调整执行配置'};
 return revision.updateReason?labels[revision.updateReason]:'更新方案';
}
/** 会话时间线的展示条目，不构成新的业务记录。 */
export type TimelineItem={
 /** 原耐久身份，分组不得改变子条目身份。 */key:string;
 /** 原发生时间，用于排序。 */at:string;
 /** 原记录内容与导航入口。 */content:ReactNode;
 /** 仅方案更新可以连续折叠；缺省为其他记录。 */planUpdate?:string;
 /** 结果在对应总结正文前展示。 */beforeTurnId?:string;
 /** 对话正文/工具保持原容器，不套记录布局。 */conversationContent?:boolean;
};
/** 仅相邻方案更新合组，执行记录会打断；调用者按对话回合分段。 */
export function groupPlanUpdates(items:TimelineItem[],messageTimes:string[]=[]):TimelineItem[][]{
 const groups:TimelineItem[][]=[];
 for(const item of items){const last=groups.at(-1),previous=last?.at(-1);const interrupted=previous&&messageTimes.some(at=>at>=previous.at&&at<=item.at);if(item.planUpdate&&last?.[0]?.planUpdate&&!interrupted)last.push(item);else groups.push([item]);}
 return groups;
}
function UpdateGroup({items}:{items:TimelineItem[]}){
 const [open,setOpen]=useState(false);
 // 收起时子条目不可见；身份挂在容器上，看到组标题即视为已读。
 return <details className="plan-update-group" data-read-identity={items.map(item=>item.key).join(" ")} open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>方案更新 · {items.length} 条 <span>· 最近：{items.at(-1)!.planUpdate}</span></summary><div>{items.map(item=><div className="workflow-timeline-item" data-read-identity={item.key} key={item.key}>{item.content}</div>)}</div></details>;
}
/** 默认收起连续两条以上更新；稳定首条key保证追加时不重置手动展开。 */
export function TimelineRecords({items,messageTimes=[]}:{items:TimelineItem[];/** 可见消息发生时间；存在于两次更新之间时禁止合组。 */messageTimes?:string[]}){
 return <>{groupPlanUpdates(items,messageTimes).map(group=>group.length>1?<UpdateGroup key={group[0]!.key} items={group}/>:group[0]!.conversationContent?<Fragment key={group[0]!.key}>{group[0]!.content}</Fragment>:<div className="workflow-timeline-item" data-read-identity={group[0]!.key} key={group[0]!.key}>{group[0]!.content}</div>)}</>;
}
