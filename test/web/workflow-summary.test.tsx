import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { executionResultExcerpt, latestExecutionEntries, proposalTitle, revisionSummaryState, WorkflowProposalSummary, WorkflowExecutionSummary } from "../../src-tauri/web/src/conversation/workflow-summary";
import type { LeadSnapshot, WorkflowRevision, WorkflowExecution } from "../../src-tauri/web/src/types";
import { WorkflowRevisionCard } from "../../src-tauri/web/src/conversation/revision-card";

const revision = (n:number):WorkflowRevision => ({ cardId:"card", parentRevision:n === 1 ? null : 1, revision:n,goal:"验证工作台",scope:"只读核验算术结果",source:"",sourceHash:"hash",acceptedAt:null,createdAt:"2026-10-15",preview:{previewVersion:1,sourceHash:"hash",phaseTitles:["准备","确认"],previewAgents:[]} });
const task = { workflowRevisions:[revision(1),revision(2)],executions:[],messages:[],conversationEntries:[] } as unknown as LeadSnapshot;

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
  const ready={...task,status:"idle"} as LeadSnapshot;
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
 const ready={...task,status:"idle",workflowRevisions:[revision(1),current]} as LeadSnapshot;
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
  expect(result).toContain("执行结束"); expect(result).toContain("历史记录："); expect(result).toContain('class="task-event"'); expect(result).not.toContain('wf-chat-summary');
  const stopped=renderToStaticMarkup(<WorkflowExecutionSummary execution={{...execution,status:"cancelled"}} revision={revision(2)} attempt={2} onOpen={()=>{}}/>);
  expect(stopped).toContain("历史记录：已停止");
  expect(stopped).not.toContain("第 2 次");
});

test("中央旧版显示取代而不是冻结，禁止审批与启动且保留声明阶段",()=>{
  const html=renderToStaticMarkup(<WorkflowRevisionCard revision={{...revision(1),acceptedAt:"2026-10-15T08:00:00Z"}} lead={task} onAssignmentCreated={()=>{}} />);
  expect(html).toContain("历史版本 · 第 1 版"); expect(html).toContain("已被第 2 版替代");
  expect(html).not.toContain("已冻结"); expect(html).not.toContain("配置并运行");
  expect(html).toContain("执行步骤"); expect(html).toContain("只读核验算术结果");
  expect(html).not.toContain("确认并运行");
});

test("运行中的执行显示为带呼吸态的可进入进度卡片",async()=>{
 const css=await Bun.file("src-tauri/web/src/workbench.css").text();
 const running={revision:2,status:"running",finishedAt:null,summary:null} as WorkflowExecution;
 const html=renderToStaticMarkup(<WorkflowExecutionSummary execution={running} revision={revision(2)} version={2} onOpen={()=>{}} />);
 expect(html).toContain("execution-live-card");
 expect(html).toContain("is-live");
 expect(html).toContain("已启动");
 expect(html).toContain("第 2 版方案");
 expect(html).toContain("查看进度");
 expect(html).not.toContain("历史记录：");
 expect(css).toContain("@keyframes wf-live-breathe");
 expect(css).toContain(".agent-workbench .execution-live-card.is-live::after");
 expect(css).toContain("@media (prefers-reduced-motion: reduce) { .agent-workbench .execution-live-card.is-live::after");
});

test("执行结束后卡片原位变为查看结果，且同一执行不重复出现历史行",()=>{
 const done={revision:2,status:"completed",finishedAt:"2026-10-18T03:00:00Z",summary:{ok:true}} as WorkflowExecution;
 const card=renderToStaticMarkup(<WorkflowExecutionSummary execution={done} revision={revision(2)} version={2} featured onOpen={()=>{}} onOpenResults={()=>{}} />);
 expect(card).toContain("is-finished");
 expect(card).not.toContain("is-live");
 expect(card).toContain("执行结束");
 expect(card).toContain("查看结果");
 expect(card).not.toContain("查看进度");
 expect(card).not.toContain("历史记录：");
 const older=renderToStaticMarkup(<WorkflowExecutionSummary execution={{...done,revision:1}} revision={revision(1)} onOpen={()=>{}} />);
 expect(older).toContain("历史记录：执行结束");
 expect(older).not.toContain("execution-live-card");
 const taskWithHistory={leadRunId:"t",executionHistory:[
  {key:"execution-created:e1",at:"2026-10-18T01:00:00Z",executionId:"e1",revision:2,attempt:1,kind:"created",status:"running",diagnostic:null,summary:null},
  {key:"execution-finished:e1",at:"2026-10-18T02:00:00Z",executionId:"e1",revision:2,attempt:1,kind:"finished",status:"completed",diagnostic:null,summary:{ok:true}},
  {key:"execution-created:e2",at:"2026-10-19T01:00:00Z",executionId:"e2",revision:1,attempt:1,kind:"created",status:"running",diagnostic:null,summary:null},
 ]} as unknown as import("../../src-tauri/web/src/types").LeadSnapshot;
 const latest=latestExecutionEntries(taskWithHistory);
 expect(latest.map(item=>[item.executionId,item.status])).toEqual([["e1","completed"],["e2","running"]]);
});
