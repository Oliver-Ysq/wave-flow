import { expect, test } from "bun:test";
import { workflowCells, editableRevision, readingAttempt } from "../../src-tauri/web/src/workbench-navigation";
import type { LeadSnapshot, WorkflowRevision } from "../../src-tauri/web/src/types";
const revision = (n:number, cardId?:string):WorkflowRevision=>({revision:n,cardId,source:"",sourceHash:"x",createdAt:"",acceptedAt:null});

test("执行与结果共用所选尝试：历史保持，未指定随最新，非法值回退",()=>{
 expect(readingAttempt(1,3)).toBe(1);
 expect(readingAttempt(2,4)).toBe(2);
 expect(readingAttempt(undefined,4)).toBe(4);
 for(const invalid of [0,-1,5,1.5,NaN])expect(readingAttempt(invalid,4)).toBe(4);
});

test("结果选择更新路由，不读取另一份缓存；切回执行保留尝试",async()=>{
 const source=await Bun.file("src-tauri/web/src/App.tsx").text();
 expect(source).not.toContain("resultAttempts");
 expect(source).toContain("loaded?.identity === resultIdentity ? loaded.value : null");
 expect(source).toContain("const attempt = readingAttempt(selectedAttempt, currentAttempt)");
 expect(source).toContain("selectedAttempt={route.attempt}");
 expect(source).toContain("onSelectAttempt={(attempt) => setRoute({ ...route, attempt })}");
 expect(source).not.toContain('section:"execution",executionId:ex?.executionId,attempt:undefined');
 expect(source).toContain('Array.from(\n    { length: detail.snapshot.currentExecutionAttemptId },\n    (_, index) => index + 1,\n  )');
 expect(source).toContain('此尝试未保存阶段过程记录，不代表没有执行');
 expect(source).toContain('历史过程暂时无法读取');
 expect(source).toContain('正在读取历史过程…');
 expect(source).toContain('查看已保存的运行结果与交付，不会重新执行。执行结束不等于目标已验收。');
 expect(source).not.toContain('<summary>证据范围与限制</summary>');
 expect(source).not.toContain('原终态：');
});
test("每卡一个子项，历史无卡独立投影；旧版本与已运行方案不可编辑",()=>{
  const first=revision(1,"card"), second=revision(2,"card"), legacy=revision(3);
  const task={task:{title:"固定"},status:"idle",workflowRevisions:[first,second,legacy],executions:[]} as unknown as LeadSnapshot;
  expect(workflowCells(task).map(item=>item.revision)).toEqual([2,3]);
  expect(editableRevision(task,first)).toBe(false);
  expect(editableRevision(task,second)).toBe(true);
  expect(editableRevision({...task,executions:[{revision:2}] as never},second)).toBe(false);
});
test("历史无 cardId 不与同名新卡合并，也永远不可编辑",()=>{
 const legacyA={...revision(1),goal:"同名"},legacyB={...revision(2),goal:"同名"},modern={...revision(3,"card"),goal:"同名"};
 const task={task:{title:"固定"},status:"idle",workflowRevisions:[legacyA,legacyB,modern],executions:[]} as unknown as LeadSnapshot;
 expect(workflowCells(task).map(item=>item.revision)).toEqual([1,2,3]);
 expect(editableRevision(task,legacyA)).toBe(false);expect(editableRevision(task,legacyB)).toBe(false);
});
test("单链执行后新修订可编辑，旧多卡规则不迁移；活跃或已执行新版仍禁止",()=>{
 const first=revision(1,"card"),second=revision(2,"card"),executions=[{revision:1,finishedAt:"finished"}];
 const task={task:{title:"目标",workflowContract:"single-workflow-v1"},status:"idle",workflowRevisions:[first,second],executions} as unknown as LeadSnapshot;
 expect(editableRevision(task,second)).toBe(true);expect(editableRevision(task,first)).toBe(false);
 expect(editableRevision({...task,task:{...task.task!,workflowContract:undefined}},second)).toBe(false);
 expect(editableRevision({...task,executions:[{revision:1,finishedAt:null}] as never},second)).toBe(false);
 expect(editableRevision({...task,executions:[...executions,{revision:2,finishedAt:"finished"}] as never},second)).toBe(false);
});
