import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { currentExecutionSummaries, hasActiveExecutionQuestions, interruptedSummaryObligations, proposalLabel, summaryWorkLabel, TaskActivity } from "../../src-tauri/web/src/conversation/task-activity";
import type { HarnessSnapshot, WorkflowRevision, WorkflowExecution } from "../../src-tauri/web/src/types";
import {unusedWorkflows} from "../../src-tauri/web/src/conversation/history-sidebar";

const revision = (id:number):WorkflowRevision => ({revision:id,cardId:"same",parentRevision:id-1||null,source:"",sourceHash:"hash",createdAt:"2026-10-18T01:00:00Z",acceptedAt:null,goal:`方案${id}`,abandonedAt:null});
const execution = {executionId:"A",revision:2,status:"completed",createdAt:"2026-10-18T02:00:00Z",finishedAt:"2026-10-18T03:00:00Z"} as WorkflowExecution;
const task = {harnessRunId:"task",status:"idle",workflowRevisions:[revision(1),revision(2),{...revision(3),abandonedAt:"saved"},revision(4)],executions:[execution],impactSummaries:[],executionAttention:{}} as unknown as HarnessSnapshot;

test("历史使用右侧索引，窄窗覆盖且正文不挤压，返回恢复原分类位置",async()=>{
 const css=await Bun.file('src-tauri/web/src/workbench.css').text();
 const sidebar=await Bun.file('src-tauri/web/src/conversation/history-sidebar.tsx').text();
 expect(css).toContain('.history-sidebar { pointer-events:auto; position:absolute; inset:0 0 0 auto;');
 expect(css).toContain('grid-template-rows:auto minmax(0,1fr)');
 expect(sidebar).not.toContain('role="tablist"');expect(sidebar).not.toContain('方案记录');
 expect(sidebar).toContain('reading.set(task.harnessRunId');
 expect(sidebar).toContain('查看结果');expect(sidebar).toContain('查看进度');
 expect(sidebar).toContain('open(`work-${item.executionId}`');
 expect(sidebar).toContain('saved.current.focus=focus');
 expect(sidebar).toContain('cancelAnimationFrame(focusFrame)');
 expect(sidebar).toContain('ended?onResults(item.executionId):onExecution(item.executionId)');
 expect(sidebar).not.toContain('history-record-actions');
});

test("未运行折叠区不重复已执行，不包含当前待确认，保留原放弃与替换",()=>{
 const mixed={...task,executions:[execution,{...execution,executionId:'B',revision:4}]} as HarnessSnapshot;
 expect(unusedWorkflows(mixed).map(item=>item.revision)).toEqual([]);
 expect(unusedWorkflows(task).map(item=>item.revision)).toEqual([]);
 const latestAbandoned={...task,workflowRevisions:task.workflowRevisions.map(item=>item.revision===4?{...item,abandonedAt:'now'}:item)};
 expect(unusedWorkflows(latestAbandoned).map(item=>item.revision)).toEqual([]);
});

test('未运行多版本只展示一个入口，计数按card且不按同名合并',()=>{
 const revisions=[revision(1),revision(2),revision(3)];
 const pending={...task,executions:[],workflowRevisions:revisions};
 expect(unusedWorkflows(pending).map(item=>item.revision)).toEqual([2]);
 const abandoned={...pending,workflowRevisions:revisions.map(item=>({...item,abandonedAt:'now'}))};
 expect(unusedWorkflows(abandoned).map(item=>item.revision)).toEqual([3]);
 const distinct={...pending,workflowRevisions:revisions.map(item=>({...item,cardId:`card-${item.revision}`,goal:'同名'}))};
 expect(unusedWorkflows(distinct).map(item=>item.revision)).toEqual([2,1]);
 const legacy={...pending,workflowRevisions:revisions.map(item=>({...item,cardId:undefined}))};
 expect(unusedWorkflows(legacy).map(item=>item.revision)).toEqual([2,1]);
 expect(revisions.map(item=>item.revision)).toEqual([1,2,3]);
});

test("对话宽度自动适配，不保留拖拽手柄或旧偏好读取，任务栏拖动不变",async()=>{
 const view=await Bun.file('src-tauri/web/src/conversation/conversation-view.tsx').text();
 const css=await Bun.file('src-tauri/web/src/workbench.css').text();
 expect(view).not.toContain('chat-width');expect(view).not.toContain('startWidthDrag');
 expect(css).not.toContain('chat-width-handle');
 expect(css).toContain('width:min(860px, 100%)');
 expect(css).toContain('rail-width-handle');
});

test("执行过的方案不因后续版本而被标为废弃",()=>{
  expect(proposalLabel(task,task.workflowRevisions[0])).toBe("已被取代 · 未执行");
  expect(proposalLabel(task,task.workflowRevisions[1])).toBe("已用于执行");
  expect(proposalLabel(task,task.workflowRevisions[2])).toBe("已放弃 · 未执行");
  expect(proposalLabel(task,task.workflowRevisions[3])).toBe("待确认 · 未执行");
});

test("大量同名混合历史按原版本身份分类，已执行优先于放弃标记",()=>{
 const plans=Array.from({length:80},(_,index)=>({...revision(index+1),goal:'同名工作',abandonedAt:index%4===2?'2026-10-18T03:00:00Z':null}));
 const runs=plans.filter(item=>item.revision%4===2||item.revision%4===0).map(item=>({...execution,executionId:`execution-${item.revision}`,revision:item.revision}));
 const mixed={...task,workflowRevisions:plans,executions:runs} as HarnessSnapshot;
 const labels=plans.map(item=>proposalLabel(mixed,item));
 expect(labels.filter(item=>item==='已用于执行')).toHaveLength(40);
 expect(labels.filter(item=>item==='已放弃 · 未执行')).toHaveLength(20);
 expect(labels.filter(item=>item==='已被取代 · 未执行')).toHaveLength(20);
 expect(runs.map(item=>summaryWorkLabel(mixed,item.executionId))).toEqual(Array(40).fill('同名工作'));
 expect(new Set(runs.map(item=>item.executionId)).size).toBe(40);
 const used={...plans[1]!,abandonedAt:'later'};
 expect(proposalLabel(mixed,used)).toBe('已用于执行');
 // A1被替换、A2执行、B1放弃、B2执行，名称相同也不可合并为一个事件。
 expect(plans.slice(0,4).map(item=>proposalLabel(mixed,item))).toEqual(['已被取代 · 未执行','已用于执行','已放弃 · 未执行','已用于执行']);
});
test("默认只显示当前方案与历史入口，不铺出旧方案或工程标识",()=>{
  const html=renderToStaticMarkup(<TaskActivity task={task} onPlan={()=>{}} onExecution={()=>{}} onResults={()=>{}} onAdjust={()=>{}} onTemplate={()=>{}}/>);
  expect(html).toContain("方案4");
  expect(html).toContain("历史 · 1");
  expect(html).not.toContain("方案1");
  expect(html).not.toContain("sourceHash");
  expect(html).not.toContain("执行过的工作");
});

test("旧尝试中断总结不冒充最新已完成尝试的待办",()=>{
  const snapshot={...task,impactSummaries:[{executionId:"A",attempt:1,status:"interrupted",key:"old"},{executionId:"A",attempt:2,status:"completed",key:"new"}]} as HarnessSnapshot;
  expect(currentExecutionSummaries(snapshot,"A").map(item=>item.key)).toEqual(["new"]);
  const restarted={...snapshot,executionHistory:[{executionId:"A",attempt:3}]} as HarnessSnapshot;
  expect(currentExecutionSummaries(restarted,"A")).toEqual([]);
});

test("已结束执行的残留问题不提醒，活跃执行的问题仍提醒",()=>{
  const snapshot={...task,executionAttention:{A:{workerRequests:1,scriptGates:1}}} as HarnessSnapshot;
  expect(hasActiveExecutionQuestions(snapshot)).toBe(false);
  expect(hasActiveExecutionQuestions({...snapshot,executions:[{...execution,status:"running",finishedAt:null}]})).toBe(true);
  expect(hasActiveExecutionQuestions({...snapshot,executionAttention:{}})).toBe(false);
});

test("总结提醒尊重后台未完成门禁，不隐藏旧义务，但归档不再提示操作",()=>{
  const snapshot={...task,impactSummaries:[{key:"old",attempt:1,status:"interrupted",executionId:"A"},{key:"obsolete",status:"interrupted",supersededBy:"new"},{key:"new",status:"completed"}]} as HarnessSnapshot;
  expect(interruptedSummaryObligations(snapshot).map(item=>item.key)).toEqual(["old"]);
  expect(interruptedSummaryObligations({...snapshot,status:"completed"})).toEqual([]);
});

test("总结待办使用原工作名而非后续方案名",()=>{
  expect(summaryWorkLabel(task,"A")).toBe("方案2");
  expect(summaryWorkLabel(task,"unknown")).toBe("历史执行");
});
