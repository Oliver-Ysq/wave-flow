import { expect, test } from "bun:test";
import { workflowCells, editableRevision } from "../../src-tauri/web/src/workbench-navigation";
import type { HarnessSnapshot, WorkflowRevision } from "../../src-tauri/web/src/types";
const revision = (n:number, cardId?:string):WorkflowRevision=>({revision:n,cardId,source:"",sourceHash:"x",createdAt:"",acceptedAt:null});
test("每卡一个子项，历史无卡独立投影；旧版本与已运行方案不可编辑",()=>{
  const first=revision(1,"card"), second=revision(2,"card"), legacy=revision(3);
  const task={task:{title:"固定"},status:"idle",workflowRevisions:[first,second,legacy],executions:[]} as unknown as HarnessSnapshot;
  expect(workflowCells(task).map(item=>item.revision)).toEqual([2,3]);
  expect(editableRevision(task,first)).toBe(false);
  expect(editableRevision(task,second)).toBe(true);
  expect(editableRevision({...task,executions:[{revision:2}] as never},second)).toBe(false);
});
test("历史无 cardId 不与同名新卡合并，也永远不可编辑",()=>{
 const legacyA={...revision(1),goal:"同名"},legacyB={...revision(2),goal:"同名"},modern={...revision(3,"card"),goal:"同名"};
 const task={task:{title:"固定"},status:"idle",workflowRevisions:[legacyA,legacyB,modern],executions:[]} as unknown as HarnessSnapshot;
 expect(workflowCells(task).map(item=>item.revision)).toEqual([1,2,3]);
 expect(editableRevision(task,legacyA)).toBe(false);expect(editableRevision(task,legacyB)).toBe(false);
});
test("单链执行后新修订可编辑，旧多卡规则不迁移；活跃或已执行新版仍禁止",()=>{
 const first=revision(1,"card"),second=revision(2,"card"),executions=[{revision:1,finishedAt:"finished"}];
 const task={task:{title:"目标",workflowContract:"single-workflow-v1"},status:"idle",workflowRevisions:[first,second],executions} as unknown as HarnessSnapshot;
 expect(editableRevision(task,second)).toBe(true);expect(editableRevision(task,first)).toBe(false);
 expect(editableRevision({...task,task:{...task.task!,workflowContract:undefined}},second)).toBe(false);
 expect(editableRevision({...task,executions:[{revision:1,finishedAt:null}] as never},second)).toBe(false);
 expect(editableRevision({...task,executions:[...executions,{revision:2,finishedAt:"finished"}] as never},second)).toBe(false);
});
