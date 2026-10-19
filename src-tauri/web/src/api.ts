import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CliRuntime, CliRuntimeListResponse, DesktopStatusResponse, DiscoveredCliCandidate, EngineEventEnvelope, ExecutionConfigSnapshot, ExecutionListResponse, ExecutionPhaseVisitPageResponse, ExecutionPlanResponse, ExecutionResponse, HarnessProjectListResponse, HarnessProjectResponse, HarnessRunListResponse, HarnessRunResponse, PhaseVisitPageResponse, ScanCliRuntimesResponse } from "./types";

/** WebView 只能调用当前 Tauri 持有的 Engine；没有浏览器 HTTP fallback。 */
async function action<T>(name: string, args: Record<string, unknown> = {}, timeoutSecs?: number): Promise<T> {
  if (!("__TAURI_INTERNALS__" in window)) throw new Error("Wave Flow 工作台只能在 Desktop 应用中运行。 ");
  return invoke<T>("engine_request", { action: name, args, timeoutSecs });
}

export const api = {
  /** 拖入/选目录后只读验证现有绝对文件夹，返回canonical cwd；不登记或启动任务。 */
  validateProjectPath: (cwd: string) => action<{ /** 已核验的真实目录绝对路径。 */ cwd: string }>("projects.validatePath", { cwd }),
  /** 首次发送携带已暂存图片；请求身份与附件列表一起绑定，仍不启动Worker。 */
  startConversationWithAttachments: (projectId:string,text:string,clientRequestId:string,title:string|undefined,stagedAttachmentIds:string[]) => action<HarnessRunResponse>("harnesses.startConversation",{projectId,text,clientRequestId,...(title?{title}:{}),...(stagedAttachmentIds.length?{stagedAttachmentIds}:{})}),
  /** 读取已登记项目当前分支，仅用于展示，不批准或启动执行。 */
  projectContext: (projectId: string) => action<import("../../../src/desktop/project-context").ProjectContext>("projects.context", { projectId }),
  /** 读取冻结成果diff与本机分支，不产生Git写入。 */
  reviewGit:(harnessRunId:string,executionId:string)=>action<import("../../../src/workspace/git-repository").GitReview>("executions.review",{harnessRunId,executionId}),
  /** 仅读取已属于该成果diff的指定文件patch。 */
  fileDiff:(harnessRunId:string,executionId:string,path:string)=>action<import("../../../src/workspace/git-repository").GitFileDiff>("executions.fileDiff",{harnessRunId,executionId,path}),
  /** 用户明确确认后squash合入本机分支；原请求重试不新增commit。 */
  mergeGit:(harnessRunId:string,executionId:string,request:{requestId:string;sourceCommit:string;targetBranch:string;targetHead:string})=>action<import("../../../src/workspace/git-repository").GitMergeResult>("executions.merge",{harnessRunId,executionId,...request,authorized:true}),
  /** 用户明确请求停止现场Git收尾，不恢复Worker、不把partial变成业务complete。 */
  savePartial: (harnessRunId:string,executionId:string)=>action<ExecutionResponse>("executions.savePartial",{harnessRunId,executionId,authorized:true}),
  /** 用户确认后只清理已保存/无writer的checkout，分支与commit保留。 */
  cleanupWorkspaces:(harnessRunId:string,executionId:string)=>action<ExecutionResponse>("executions.cleanupWorkspaces",{harnessRunId,executionId,authorized:true}),
  /** 只重试原义务的主控总结，不能派发或恢复Worker。 */
  retryImpactSummary:(harnessRunId:string,key:string)=>action<HarnessRunResponse>("harnesses.retryImpactSummary",{harnessRunId,key}),
  /** 仅停止指定总结的本次回合；key与turnId均必填，过期或缺失身份不能停止重试/其他回合。 */
  stopImpactSummary:(harnessRunId:string,key:string,turnId:string)=>action<HarnessRunResponse>("harnesses.stopImpactSummary",{harnessRunId,key,turnId}),
  /** 明确放弃总结且同时封存；归档后不能执行或恢复。 */
  archiveAbandoningSummaries:(harnessRunId:string)=>action<HarnessRunResponse>("harnesses.complete",{harnessRunId,abandonImpactSummaries:true}),
  /** 主控只回idle，不重发prompt、不解除总结门禁。 */
  recoverController:(harnessRunId:string)=>action<HarnessRunResponse>("harnesses.recoverController",{harnessRunId}),
  /** 本地来源静态预检；只在专用验收页面调用，不创建Task或执行源码。 */
  preflightLocal:(projectId:string,path:string)=>action<Omit<import("../../../src/workflow/preflight-local").LocalWorkflowPreflight,"source">>("workflows.preflightLocal",{projectId,path}),
  /** 保存已预检本地来源与参数为未批准Task，不运行模块。 */
  createLocalTask:(projectId:string,path:string,sourceHash:string,input:Record<string,unknown>,clientRequestId:string)=>action<HarnessRunResponse>("workflows.createLocalTask",{projectId,path,sourceHash,input,clientRequestId}),
  /** 编辑本地文件/参数后追加未批准版本，不能启动修订执行。 */
  reviseLocalTask:(harnessRunId:string,baseRevision:number,sourceHash:string,input:Record<string,unknown>,clientRequestId:string,path?:string)=>action<HarnessRunResponse>("workflows.reviseLocalTask",{harnessRunId,baseRevision,sourceHash,input,clientRequestId,...(path?{path}:{})}),
  /** 当前设计一次确认，不再要求单独接受/分配卡；批准与派发由Engine仲裁。 */
  prepareConfigurationRevision:(harnessRunId:string,baseRevision:number,clientRequestId:string)=>action<HarnessRunResponse>("workflows.prepareConfigurationRevision",{harnessRunId,baseRevision,clientRequestId}),
  /** 确认冻结源码/输入/CLI及现场版本，重复UUID只返回原执行。 */
  confirmWorkflow:(harnessRunId:string,revision:number,config:ExecutionConfigSnapshot|undefined,clientRequestId:string,sceneEvidenceHash?:string|null)=>action<ExecutionResponse>("executions.confirm",{harnessRunId,revision,...(config?{config}:{}),clientRequestId,...(sceneEvidenceHash?{sceneEvidenceHash}:{})}),
  /** 获取内置版本化目录，不创建任何运行对象。 */
  templates:()=>action<{templates:import("../../../src/harness/workflow-templates").WorkflowTemplate[]}>("templates.list"),
  /** 保存未批准候选；needsGuidance 才安排主控。编辑必须携带 cardId 和正整数 baseRevision；同请求重试不新增版本或引导回合。 */
  saveTemplate:(harnessRunId:string,clientRequestId:string,template:import("../../../src/harness/task-contract").TemplateSelection,cardId?:string,baseRevision?:number)=>action<HarnessRunResponse>("templates.save",{harnessRunId,clientRequestId,template,...(cardId?{cardId,baseRevision}:{})}),
  /** 创建预置Task与未批准候选；needsGuidance才安排主控，不启动Worker。 */
  createTemplateTask:(projectId:string,text:string,clientRequestId:string,template:import("../../../src/harness/task-contract").TemplateSelection,title?:string)=>action<HarnessRunResponse>("harnesses.startConversation",{projectId,text,clientRequestId,template,...(title?{title}:{})}),
  /** 最终确认才耐久批准并派发执行。 */
  confirmTemplate:(harnessRunId:string,revision:number,config:ExecutionConfigSnapshot,clientRequestId:string,input?:Record<string,unknown>,sceneEvidenceHash?:string|null)=>action<ExecutionResponse>("templates.confirm",{harnessRunId,revision,config,clientRequestId,...(input?{input}:{}),...(sceneEvidenceHash?{sceneEvidenceHash}:{})}),
  /** 特定 attempt 的只读证据；不存在时拒绝，不启动执行。 */
  attemptResults:(harnessRunId:string,executionId:string,attempt:number)=>action<{executionId:string;attempt:number;status:string|null;summary:Record<string,unknown>|null;nodes:Array<{id:string;label:string;result:Record<string,unknown>|null}>}>("executions.attemptResults",{harnessRunId,executionId,attempt}),
  /** 显式重新核验现场；变化只追加补充义务，既不恢复也不启动Execution。 */
  checkExecutionScene:(harnessRunId:string,executionId:string)=>action<{harness:import("./types").HarnessSnapshot}>("executions.checkScene",{harnessRunId,executionId}),
  desktopStatus: () => action<DesktopStatusResponse>("status"),
  listHarnesses: () => action<HarnessRunListResponse>("harnesses.list"),
  cliRuntimes: () => action<CliRuntimeListResponse>("runtimes.list"),
  discoverCliRuntimes: () => action<{ candidates: DiscoveredCliCandidate[] }>("runtimes.discover"),
  scanCliRuntimes: () => action<ScanCliRuntimesResponse>("runtimes.scan"),
  validateCliRuntime: (executablePath: string, cli: "codex" | "kimi", discoveredFrom: "shell-path" | "gui-path" | "manual" = "manual", discoveredShell: string | null = null) => action<{ runtime: CliRuntime }>("runtimes.validate", { executablePath, cli, discoveredFrom, discoveredShell }),
  selectCliRuntime: (runtimeId: string) => action<{ runtime: CliRuntime }>("runtimes.select", { runtimeId }),
  deleteCliRuntime: (runtimeId: string) => action<{ deleted: true }>("runtimes.delete", { runtimeId }),
  phaseVisits: (runId: string, options: { cursor?: number; includeEmpty?: boolean; attempt?: number } = {}) => {
    return action<PhaseVisitPageResponse>("runs.phaseVisits", { runId, ...options });
  },
  /** Execution 的 Phase 访问分页；attempt 缺省时跨全部 attempt 聚合，用于补齐 replay 复用的 Phase → Agent 关系。 */
  executionPhaseVisits: (harnessRunId: string, executionId: string, options: { cursor?: number; includeEmpty?: boolean; attempt?: number } = {}) => {
    return action<ExecutionPhaseVisitPageResponse>("executions.phaseVisits", { harnessRunId, executionId, ...options });
  },
  answer: (blockRequestId: string, answer: Record<string, unknown>) => action("blocks.answer", { blockRequestId, answer }),
  projects: () => action<HarnessProjectListResponse>("projects.list"), createProject: (cwd: string, title?: string) => action<HarnessProjectResponse>("projects.create", { cwd, ...(title?.trim() ? { title } : {}) }), startHarnessConversation: (projectId: string, text: string, clientRequestId: string = crypto.randomUUID(), title?: string) => action<HarnessRunResponse>("harnesses.startConversation", { projectId, text, clientRequestId, ...(title ? { title } : {}) }), createHarness: (projectId: string) => action<HarnessRunResponse>("harnesses.create", { projectId }), harness: (harnessRunId: string) => action<HarnessRunResponse>("harnesses.get", { harnessRunId }), sendHarnessMessage: (harnessRunId: string, text: string, options: { clientMessageId?: string; immediate?: boolean; stagedAttachmentIds?: string[] } = {}) => action<HarnessRunResponse>("harnesses.send", { harnessRunId, text, ...options }), cancelQueuedMessage: (harnessRunId: string, messageId: string) => action<HarnessRunResponse>("harnesses.cancelQueued", { harnessRunId, messageId }), stageAttachment: (path: string) => action<import("./types").StagedAttachment>("harnesses.stageAttachment", { path }), attachmentData: (harnessRunId: string, messageId: string, attachmentId: string) => action<{ dataUrl: string }>("harnesses.attachmentData", { harnessRunId, messageId, attachmentId }), abortHarness: (harnessRunId: string) => action<HarnessRunResponse>("harnesses.abort", { harnessRunId }), completeHarness: (harnessRunId: string) => action<HarnessRunResponse>("harnesses.complete", { harnessRunId }), retryInitialization: (harnessRunId: string) => action<HarnessRunResponse>("harnesses.retryInitialization", { harnessRunId }), abandonCard: (harnessRunId: string, cardId: string) => action<HarnessRunResponse>("harnesses.abandonCard", { harnessRunId, cardId }), acceptWorkflowRevision: (harnessRunId: string, revision: number) => action<HarnessRunResponse>("harnesses.acceptRevision", { harnessRunId, revision }), rejectWorkflowRevision: (harnessRunId: string, revision: number) => action<HarnessRunResponse>("harnesses.rejectRevision", { harnessRunId, revision }), createExecution: (harnessRunId: string, revision: number, config: ExecutionConfigSnapshot, input: Record<string, unknown> = {}) => action<ExecutionResponse>("executions.create", { harnessRunId, revision, input, config }), planExecution: (harnessRunId: string, revision: number) => action<ExecutionPlanResponse>("executions.plan", { harnessRunId, revision }), executions: (harnessRunId: string) => action<ExecutionListResponse>("executions.list", { harnessRunId }), execution: (harnessRunId: string, executionId: string) => action<ExecutionResponse>("executions.get", { harnessRunId, executionId }), executionControl: (harnessRunId: string, executionId: string, actionName: "pause" | "recover" | "stop") => action<ExecutionResponse>("executions.control", { harnessRunId, executionId, action: actionName }), resumeExecution: (harnessRunId: string, executionId: string) => action<ExecutionResponse>("executions.resume", { harnessRunId, executionId }), answerExecutionGate: (harnessRunId: string, executionId: string, gateId: string, answer: Record<string, unknown>) => action<ExecutionResponse>("executions.answerGate", { harnessRunId, executionId, gateId, answer }), answerHarnessDecision: (harnessRunId: string, decisionId: string, answer: Record<string, unknown>) => action<HarnessRunResponse>("harnesses.answerDecision", { harnessRunId, decisionId, answer }),
  /** 订阅 Engine 事件帧；generation 变化表示 Engine 重启，调用方必须重读快照对齐序号。 */
  listenEngineEvents: (handler: (envelope: EngineEventEnvelope) => void) => listen<EngineEventEnvelope>("engine-event", (event) => handler(event.payload)),
};
