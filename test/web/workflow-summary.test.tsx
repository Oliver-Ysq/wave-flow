import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { executionResultExcerpt, revisionSummaryState, WorkflowProposalSummary, WorkflowExecutionSummary } from "../../src-tauri/web/src/conversation/workflow-summary";
import type { HarnessSnapshot, WorkflowRevision, WorkflowExecution } from "../../src-tauri/web/src/types";
import { WorkflowRevisionCard } from "../../src-tauri/web/src/conversation/revision-card";

const revision = (n:number):WorkflowRevision => ({ cardId:"card", parentRevision:n === 1 ? null : 1, revision:n,goal:"验证工作台",scope:"只读核验算术结果",source:"",sourceHash:"hash",acceptedAt:null,createdAt:"2026-10-15",preview:{previewVersion:1,sourceHash:"hash",phaseTitles:["准备","确认"],previewAgents:[]} });
const task = { workflowRevisions:[revision(1),revision(2)],executions:[] } as unknown as HarnessSnapshot;

test("旧版只按同卡标被替代，保留批准证据，历史缺卡不猜版本关系",()=>{
  const first = {...revision(1),acceptedAt:"saved"};
  expect(revisionSummaryState(task,first)).toEqual({status:"已被第 2 版替代",supersededBy:2});
  expect(first.acceptedAt).toBe("saved");
  expect(revisionSummaryState(task,{...first,cardId:undefined}).status).toBe("已接受，尚未运行");
  expect(revisionSummaryState(task,{...first,abandonedAt:"saved"}).status).toBe("已放弃");
});
test("方案摘要含范围与声明阶段，只提供原版本导航；旧版摘要默认收起",()=>{
  const latest = renderToStaticMarkup(<WorkflowProposalSummary task={task} revision={revision(2)} onOpen={()=>{}} />);
  expect(latest).toContain("方案已更新"); expect(latest).toContain("只读核验算术结果"); expect(latest).toContain("声明阶段"); expect(latest).toContain("源码示意");
  expect(latest).not.toContain("接受方案"); expect(latest).not.toContain("配置并运行");
  const old = renderToStaticMarkup(<WorkflowProposalSummary task={task} revision={revision(1)} onOpen={()=>{}} />);
  expect(old).toContain("<details>"); expect(old).not.toContain("<details open"); expect(old).toContain("查看原方案");
});
test("缺失预览不伪造步骤，结果有界且完成不等于验收",()=>{
  const html=renderToStaticMarkup(<WorkflowProposalSummary task={task} revision={{...revision(2),preview:undefined,scope:undefined}} onOpen={()=>{}} />);
  expect(html).toContain("历史预览不可用"); expect(html).not.toContain("0 个声明阶段");
  expect(executionResultExcerpt({text:"x".repeat(1000)})!.length).toBeLessThan(280);
  const execution={revision:2,status:"completed",summary:{ok:true}} as WorkflowExecution;
  const result=renderToStaticMarkup(<WorkflowExecutionSummary execution={execution} revision={revision(2)} onOpen={()=>{}} />);
  expect(result).toContain("执行已完成"); expect(result).toContain("不代表任务目标已验收");
});

test("中央旧版显示取代而不是冻结，禁止审批与启动且保留声明阶段",()=>{
  const html=renderToStaticMarkup(<WorkflowRevisionCard revision={{...revision(1),acceptedAt:"2026-10-15T08:00:00Z"}} harness={task} onAccept={()=>{}} onReject={async()=>{}} onCreateExecution={()=>{}} assignmentRevision={null} onAssignmentCancel={()=>{}} onAssignmentCreated={()=>{}} />);
  expect(html).toContain("历史方案"); expect(html).toContain("已被第 2 版替代");
  expect(html).not.toContain("已冻结"); expect(html).not.toContain("配置并运行");
  expect(html).toContain("声明阶段"); expect(html).toContain("只读核验算术结果");
});
