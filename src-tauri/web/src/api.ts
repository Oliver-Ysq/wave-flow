import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  CliRuntime,
  CliRuntimeListResponse,
  DesktopStatusResponse,
  DiscoveredCliCandidate,
  EngineEventEnvelope,
  ExecutionConfigSnapshot,
  ExecutionListResponse,
  ExecutionPhaseVisitPageResponse,
  ExecutionPlanResponse,
  ExecutionResponse,
  LeadProjectListResponse,
  LeadProjectResponse,
  LeadRunListResponse,
  LeadRunResponse,
  PhaseVisitPageResponse,
  RuntimeCli,
  ScanCliRuntimesResponse,
} from "./types";
import { createEngineClient, type EngineLine } from "./engine-client";

/** Tauri 只原样转发响应行；配对、超时与 generation 过滤在 engine-client。 */
type EngineLineEnvelope = {
  readonly generation: number;
  readonly line: EngineLine;
};
type EngineExitEnvelope = { readonly generation: number };

const engineClient = createEngineClient({
  write: (line) => invoke<number>("engine_write", { line }),
  subscribeLine: (handler) =>
    listen<EngineLineEnvelope>("engine-line", (event) => {
      if (typeof event.payload?.line === "string") handler(event.payload.line);
    }),
  subscribeExit: (handler) =>
    listen<EngineExitEnvelope>("engine-exited", (event) => {
      handler(Number(event.payload?.generation ?? 0));
    }),
});

/** WebView 只能调用当前 Tauri 持有的 Engine；没有浏览器 HTTP fallback。 */
async function action<T>(
  name: string,
  args: Record<string, unknown> = {},
  timeoutSecs?: number,
): Promise<T> {
  if (!("__TAURI_INTERNALS__" in window))
    throw new Error("Wave Flow 工作台只能在 Desktop 应用中运行。 ");
  return engineClient.action<T>(name, args, timeoutSecs);
}

export const api = {
  /** 手动保存1–120字单行标题；归档拒绝，不影响主控或执行。 */
  renameTitle: (leadRunId: string, title: string) =>
    action<LeadRunResponse>("leads.renameTitle", {
      leadRunId,
      title,
    }),
  /** 拖入/选目录后只读验证现有绝对文件夹，返回canonical cwd；不登记或启动任务。 */
  validateProjectPath: (cwd: string) =>
    action<{ /** 已核验的真实目录绝对路径。 */ cwd: string }>(
      "projects.validatePath",
      { cwd },
    ),
  /** 首次发送携带已暂存图片；请求身份与附件列表一起绑定，仍不启动Worker。 */
  startConversationWithAttachments: (
    projectId: string,
    text: string,
    clientRequestId: string,
    title: string | undefined,
    stagedAttachmentIds: string[],
  ) =>
    action<LeadRunResponse>("leads.startConversation", {
      projectId,
      text,
      clientRequestId,
      ...(title ? { title } : {}),
      ...(stagedAttachmentIds.length ? { stagedAttachmentIds } : {}),
    }),
  /** 读取已登记项目当前分支，仅用于展示，不批准或启动执行。 */
  projectContext: (projectId: string) =>
    action<import("../../../src/desktop/project-context").ProjectContext>(
      "projects.context",
      { projectId },
    ),
  /** 用户明确请求停止现场Git收尾，不恢复Worker、不把partial变成业务complete。 */
  savePartial: (leadRunId: string, executionId: string) =>
    action<ExecutionResponse>("executions.savePartial", {
      leadRunId,
      executionId,
      authorized: true,
    }),
  /** 只重试原义务的主控总结，不能派发或恢复Worker。 */
  retryImpactSummary: (leadRunId: string, key: string) =>
    action<LeadRunResponse>("leads.retryImpactSummary", {
      leadRunId,
      key,
    }),
  /** 仅停止指定总结的本次回合；key与turnId均必填，过期或缺失身份不能停止重试/其他回合。 */
  stopImpactSummary: (leadRunId: string, key: string, turnId: string) =>
    action<LeadRunResponse>("leads.stopImpactSummary", {
      leadRunId,
      key,
      turnId,
    }),
  /** 明确放弃总结且同时封存；归档后不能执行或恢复。 */
  archiveAbandoningSummaries: (leadRunId: string) =>
    action<LeadRunResponse>("leads.complete", {
      leadRunId,
      abandonImpactSummaries: true,
    }),
  /** 主控只回idle，不重发prompt、不解除总结门禁。 */
  recoverController: (leadRunId: string) =>
    action<LeadRunResponse>("leads.recoverController", { leadRunId }),
  /** 本地来源静态预检；只在专用验收页面调用，不创建Task或执行源码。 */
  preflightLocal: (projectId: string, path: string) =>
    action<
      Omit<
        import("../../../src/workflow/preflight-local").LocalWorkflowPreflight,
        "source"
      >
    >("workflows.preflightLocal", { projectId, path }),
  /** 保存已预检本地来源与参数为未批准Task，不运行模块。 */
  createLocalTask: (
    projectId: string,
    path: string,
    sourceHash: string,
    input: Record<string, unknown>,
    clientRequestId: string,
  ) =>
    action<LeadRunResponse>("workflows.createLocalTask", {
      projectId,
      path,
      sourceHash,
      input,
      clientRequestId,
    }),
  /** 编辑本地文件/参数后追加未批准版本，不能启动修订执行。 */
  reviseLocalTask: (
    leadRunId: string,
    baseRevision: number,
    sourceHash: string,
    input: Record<string, unknown>,
    clientRequestId: string,
    path?: string,
    updateReason?: "save-local" | "modify-plan" | "modify-parameters",
  ) =>
    action<LeadRunResponse>("workflows.reviseLocalTask", {
      leadRunId,
      baseRevision,
      sourceHash,
      input,
      clientRequestId,
      ...(path ? { path } : {}),
      ...(updateReason ? { updateReason } : {}),
    }),
  /** 用户把当前生成模块保存到项目并接管为本地来源；不创建执行、不派发 Worker。 */
  saveAndAdoptRevision: (
    leadRunId: string,
    revision: number,
    path: string,
    clientRequestId: string,
    input?: Record<string, unknown>,
    replace?: boolean,
  ) =>
    action<LeadRunResponse>("workflows.saveAndAdoptRevision", {
      leadRunId,
      revision,
      path,
      clientRequestId,
      ...(input ? { input } : {}),
      ...(replace ? { replace } : {}),
    }),
  /** 确认冻结源码/输入/CLI及现场版本，重复UUID只返回原执行。 */
  confirmWorkflow: (
    leadRunId: string,
    revision: number,
    config: ExecutionConfigSnapshot | undefined,
    clientRequestId: string,
    sceneEvidenceHash?: string | null,
    input?: Record<string, unknown>,
  ) =>
    action<ExecutionResponse>("executions.confirm", {
      leadRunId,
      revision,
      ...(config ? { config } : {}),
      clientRequestId,
      ...(input ? { input } : {}),
      ...(sceneEvidenceHash ? { sceneEvidenceHash } : {}),
    }),
  /** 获取内置版本化目录，不创建任何运行对象。 */
  templates: () =>
    action<{
      templates: import("../../../src/lead/workflow-templates").WorkflowTemplate[];
    }>("templates.list"),
  /** 保存未批准候选；needsGuidance 才安排主控。编辑必须携带 cardId 和正整数 baseRevision；同请求重试不新增版本或引导回合。 */
  saveTemplate: (
    leadRunId: string,
    clientRequestId: string,
    template: import("../../../src/lead/task-contract").TemplateSelection,
    cardId?: string,
    baseRevision?: number,
  ) =>
    action<LeadRunResponse>("templates.save", {
      leadRunId,
      clientRequestId,
      template,
      ...(cardId ? { cardId, baseRevision } : {}),
    }),
  /** 创建预置Task与未批准候选；needsGuidance才安排主控，不启动Worker。 */
  createTemplateTask: (
    projectId: string,
    text: string,
    clientRequestId: string,
    template: import("../../../src/lead/task-contract").TemplateSelection,
    title?: string,
  ) =>
    action<LeadRunResponse>("leads.startConversation", {
      projectId,
      text,
      clientRequestId,
      template,
      ...(title ? { title } : {}),
    }),
  /** 最终确认才耐久批准并派发执行。 */
  confirmTemplate: (
    leadRunId: string,
    revision: number,
    config: ExecutionConfigSnapshot | undefined,
    clientRequestId: string,
    input?: Record<string, unknown>,
    sceneEvidenceHash?: string | null,
  ) =>
    action<ExecutionResponse>("templates.confirm", {
      leadRunId,
      revision,
      ...(config ? { config } : {}),
      clientRequestId,
      ...(input ? { input } : {}),
      ...(sceneEvidenceHash ? { sceneEvidenceHash } : {}),
    }),
  /** 特定 attempt 的只读证据；不存在时拒绝，不启动执行。 */
  attemptResults: (
    leadRunId: string,
    executionId: string,
    attempt: number,
  ) =>
    action<{
      executionId: string;
      attempt: number;
      status: string | null;
      summary: Record<string, unknown> | null;
      nodes: Array<{
        id: string;
        label: string;
        result: Record<string, unknown> | null;
      }>;
    }>("executions.attemptResults", { leadRunId, executionId, attempt }),
  /** 显式重新核验现场；变化只追加补充义务，既不恢复也不启动Execution。 */
  checkExecutionScene: (leadRunId: string, executionId: string) =>
    action<{ lead: import("./types").LeadSnapshot }>(
      "executions.checkScene",
      { leadRunId, executionId },
    ),
  desktopStatus: () => action<DesktopStatusResponse>("status"),
  listLeads: () => action<LeadRunListResponse>("leads.list"),
  cliRuntimes: () => action<CliRuntimeListResponse>("runtimes.list"),
  /** 技能库只读状态；缺失目录视为空库，非法 skill 返回可操作错误。 */
  skillsStatus: () => action<import("./types").SkillLibraryStatus>("skills.status"),
  /** 用户显式打开技能库目录；缺失时 Engine 创建空目录。 */
  skillsOpen: () => action<{ opened: true }>("skills.open"),
  /** 扫描本机 CLI 技能目录，返回可导入候选；只读。 */
  skillsDiscover: () => action<import("./types").SkillDiscoverResult>("skills.discover"),
  /** 从已识别的 CLI 技能目录导入一个 skill；同名目标拒绝。 */
  skillsImport: (path: string) => action<{ name: string }>("skills.import", { path }),
  /** 从用户选择的 skill.zip 导入一个 skill；Engine 负责路径/大小/内容校验。 */
  skillsImportZip: (path: string) => action<{ name: string }>("skills.importZip", { path }),
  discoverCliRuntimes: () =>
    action<{ candidates: DiscoveredCliCandidate[] }>("runtimes.discover"),
  scanCliRuntimes: () => action<ScanCliRuntimesResponse>("runtimes.scan"),
  validateCliRuntime: (
    executablePath: string,
    cli: RuntimeCli,
    discoveredFrom:
      | "shell-path"
      | "gui-path"
      | "install-dir"
      | "manual" = "manual",
    discoveredShell: string | null = null,
  ) =>
    action<{ runtime: CliRuntime }>("runtimes.validate", {
      executablePath,
      cli,
      discoveredFrom,
      discoveredShell,
    }),
  selectCliRuntime: (runtimeId: string) =>
    action<{ runtime: CliRuntime }>("runtimes.select", { runtimeId }),
  deleteCliRuntime: (runtimeId: string) =>
    action<{ deleted: true }>("runtimes.delete", { runtimeId }),
  phaseVisits: (
    runId: string,
    options: { cursor?: number; includeEmpty?: boolean; attempt?: number } = {},
  ) => {
    return action<PhaseVisitPageResponse>("runs.phaseVisits", {
      runId,
      ...options,
    });
  },
  /** Execution 的 Phase 访问分页；attempt 缺省时跨全部 attempt 聚合，用于补齐 replay 复用的 Phase → Agent 关系。 */
  executionPhaseVisits: (
    leadRunId: string,
    executionId: string,
    options: { cursor?: number; includeEmpty?: boolean; attempt?: number } = {},
  ) => {
    return action<ExecutionPhaseVisitPageResponse>("executions.phaseVisits", {
      leadRunId,
      executionId,
      ...options,
    });
  },
  answer: (blockRequestId: string, answer: Record<string, unknown>) =>
    action("blocks.answer", { blockRequestId, answer }),
  projects: () => action<LeadProjectListResponse>("projects.list"),
  createProject: (cwd: string, title?: string) =>
    action<LeadProjectResponse>("projects.create", {
      cwd,
      ...(title?.trim() ? { title } : {}),
    }),
  startLeadConversation: (
    projectId: string,
    text: string,
    clientRequestId: string = crypto.randomUUID(),
    title?: string,
  ) =>
    action<LeadRunResponse>("leads.startConversation", {
      projectId,
      text,
      clientRequestId,
      ...(title ? { title } : {}),
    }),
  createLead: (projectId: string) =>
    action<LeadRunResponse>("leads.create", { projectId }),
  lead: (leadRunId: string) =>
    action<LeadRunResponse>("leads.get", { leadRunId }),
  leadCommandCatalog: (projectId: string) =>
    action<import("./types").LeadCommandCatalogResponse>(
      "leads.commandCatalog",
      { projectId },
    ),
  sendLeadMessage: (
    leadRunId: string,
    text: string,
    options: {
      clientMessageId?: string;
      immediate?: boolean;
      stagedAttachmentIds?: string[];
    } = {},
  ) =>
    action<LeadRunResponse>("leads.send", {
      leadRunId,
      text,
      ...options,
    }),
  cancelQueuedMessage: (leadRunId: string, messageId: string) =>
    action<LeadRunResponse>("leads.cancelQueued", {
      leadRunId,
      messageId,
    }),
  stageAttachment: (path: string) =>
    action<import("./types").StagedAttachment>("leads.stageAttachment", {
      path,
    }),
  attachmentData: (
    leadRunId: string,
    messageId: string,
    attachmentId: string,
  ) =>
    action<{ dataUrl: string }>("leads.attachmentData", {
      leadRunId,
      messageId,
      attachmentId,
    }),
  abortLead: (leadRunId: string) =>
    action<LeadRunResponse>("leads.abort", { leadRunId }),
  completeLead: (leadRunId: string) =>
    action<LeadRunResponse>("leads.complete", { leadRunId }),
  retryInitialization: (leadRunId: string) =>
    action<LeadRunResponse>("leads.retryInitialization", {
      leadRunId,
    }),
  acceptWorkflowRevision: (leadRunId: string, revision: number) =>
    action<LeadRunResponse>("leads.acceptRevision", {
      leadRunId,
      revision,
    }),
  rejectWorkflowRevision: (leadRunId: string, revision: number) =>
    action<LeadRunResponse>("leads.rejectRevision", {
      leadRunId,
      revision,
    }),
  createExecution: (
    leadRunId: string,
    revision: number,
    config: ExecutionConfigSnapshot,
    input: Record<string, unknown> = {},
  ) =>
    action<ExecutionResponse>("executions.create", {
      leadRunId,
      revision,
      input,
      config,
    }),
  planExecution: (leadRunId: string, revision: number) =>
    action<ExecutionPlanResponse>("executions.plan", {
      leadRunId,
      revision,
    }),
  executions: (leadRunId: string) =>
    action<ExecutionListResponse>("executions.list", { leadRunId }),
  execution: (leadRunId: string, executionId: string) =>
    action<ExecutionResponse>("executions.get", { leadRunId, executionId }),
  executionControl: (
    leadRunId: string,
    executionId: string,
    actionName: "pause" | "recover" | "stop",
  ) =>
    action<ExecutionResponse>("executions.control", {
      leadRunId,
      executionId,
      action: actionName,
    }),
  resumeExecution: (leadRunId: string, executionId: string) =>
    action<ExecutionResponse>("executions.resume", {
      leadRunId,
      executionId,
    }),
  answerExecutionGate: (
    leadRunId: string,
    executionId: string,
    gateId: string,
    answer: Record<string, unknown>,
  ) =>
    action<ExecutionResponse>("executions.answerGate", {
      leadRunId,
      executionId,
      gateId,
      answer,
    }),
  answerLeadDecision: (
    leadRunId: string,
    decisionId: string,
    answer: Record<string, unknown>,
  ) =>
    action<LeadRunResponse>("leads.answerDecision", {
      leadRunId,
      decisionId,
      answer,
    }),
  /** 订阅 Engine 事件帧；generation 变化表示 Engine 重启，调用方必须重读快照对齐序号。 */
  listenEngineEvents: (handler: (envelope: EngineEventEnvelope) => void) =>
    listen<EngineEventEnvelope>("engine-event", (event) =>
      handler(event.payload),
    ),
};
