import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { executionResultExcerpt, proposalTitle, revisionSummaryState, WorkflowProposalSummary, WorkflowExecutionSummary } from "../../src-tauri/web/src/conversation/workflow-summary";
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
test("当前方案明确支持对话调整，旧版和本地来源不误导用户",()=>{
  const ready={...task,status:"idle"} as HarnessSnapshot;
  const html=renderToStaticMarkup(<WorkflowProposalSummary task={ready} revision={revision(2)} onOpen={()=>{}} onAdjust={()=>{}} />);
  expect(html).toContain("通过对话调整");expect(html).toContain("可直接对话调整方案");
  const old=renderToStaticMarkup(<WorkflowProposalSummary task={ready} revision={revision(1)} onOpen={()=>{}} onAdjust={()=>{}} />);
  expect(old).not.toContain("通过对话调整");
  const local=renderToStaticMarkup(<WorkflowProposalSummary task={ready} revision={{...revision(2),localOrigin:{} as never}} onOpen={()=>{}} onAdjust={()=>{}} />);
  expect(local).not.toContain("通过对话调整");
});
test("紧凑标题不使用长目标，正文两行且展开操作可达",()=>{
 const long={...revision(2),goal:"完整审查目标".repeat(30),scope:"完整范围说明".repeat(50),preview:{...revision(2).preview!,description:"全仓只读代码审查",workflowName:"repo-review"}};
 expect(proposalTitle(long)).toBe("全仓只读代码审查");
 expect(proposalTitle({...long,preview:{...long.preview,description:"长说明".repeat(40)}})).toBe("repo-review");
 const html=renderToStaticMarkup(<WorkflowProposalSummary task={task} revision={long} onOpen={()=>{}}/>);
 expect(html).toContain("<h3>全仓只读代码审查</h3>");expect(html).toContain('class="wf-summary-clamp"');
 expect(html).toContain('aria-expanded="false"');expect(html).toContain('aria-controls=');expect(html).toContain(">展开</button>");
 expect(html).toContain(long.scope);
});
test("放弃方案后折叠历史并提供重新设计，预置入口仅首次执行前显示",()=>{
 const current={...revision(2),abandonedAt:"saved"};
 const ready={...task,status:"idle",workflowRevisions:[revision(1),current]} as HarnessSnapshot;
 const html=renderToStaticMarkup(<WorkflowProposalSummary task={ready} revision={current} onOpen={()=>{}} onAdjust={()=>{}} onTemplate={()=>{}}/>);
 expect(html).toContain("展开已放弃方案摘要");expect(html).not.toContain("<details open");
 expect(html).toContain("此方案已放弃，任务和对话仍保留");expect(html).toContain("通过对话重新设计");expect(html).toContain("选择预置方案");expect(html).toContain("查看原方案");
 const executed=renderToStaticMarkup(<WorkflowProposalSummary task={{...ready,executions:[{finishedAt:"saved"} as WorkflowExecution]}} revision={current} onOpen={()=>{}} onAdjust={()=>{}} onTemplate={()=>{}}/>);
 expect(executed).not.toContain("选择预置方案");expect(executed).not.toContain("归档任务");
 const old=renderToStaticMarkup(<WorkflowProposalSummary task={{...ready,workflowRevisions:[current,revision(3)]}} revision={current} onOpen={()=>{}} onAdjust={()=>{}}/>);
 expect(old).not.toContain("通过对话重新设计");
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
  const html=renderToStaticMarkup(<WorkflowRevisionCard revision={{...revision(1),acceptedAt:"2026-10-15T08:00:00Z"}} harness={task} onAssignmentCreated={()=>{}} />);
  expect(html).toContain("历史方案"); expect(html).toContain("已被第 2 版替代");
  expect(html).not.toContain("已冻结"); expect(html).not.toContain("配置并运行");
  expect(html).toContain("Workflow 设计"); expect(html).toContain("只读核验算术结果");
  expect(html).not.toContain("确认并运行");
});
