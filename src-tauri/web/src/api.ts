import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CliRuntime, CliRuntimeListResponse, CreateRunRequest, CurrentAttemptResponse, DesktopStatusResponse, DiscoveredCliCandidate, EngineEventEnvelope, ExecutionAttemptsResponse, ExecutionConfigSnapshot, ExecutionListResponse, ExecutionParseRuleResponse, ExecutionPhaseVisitPageResponse, ExecutionPlanResponse, ExecutionRandomizeResponse, ExecutionResponse, HarnessProjectListResponse, HarnessProjectResponse, HarnessRunListResponse, HarnessRunResponse, PhaseVisitPageResponse, PhaseVisitResponse, RunListItem, RunResponse, ScanCliRuntimesResponse } from "./types";

/** WebView 只能调用当前 Tauri 持有的 Engine；没有浏览器 HTTP fallback。 */
async function action<T>(name: string, args: Record<string, unknown> = {}, timeoutSecs?: number): Promise<T> {
  if (!("__TAURI_INTERNALS__" in window)) throw new Error("Wave Flow 工作台只能在 Desktop 应用中运行。 ");
  return invoke<T>("engine_request", { action: name, args, timeoutSecs });
}

export const api = {
  /** 特定 attempt 的只读证据；不存在时拒绝，不启动执行。 */
  attemptResults:(harnessRunId:string,executionId:string,attempt:number)=>action<{executionId:string;attempt:number;status:string|null;summary:Record<string,unknown>|null;nodes:Array<{id:string;label:string;result:Record<string,unknown>|null}>}>("executions.attemptResults",{harnessRunId,executionId,attempt}),
  desktopStatus: () => action<DesktopStatusResponse>("status"),
  createRun: (request: CreateRunRequest) => action<RunResponse>("runs.create", request),
  listRuns: () => action<RunListItem[]>("runs.list"),
  listHarnesses: () => action<HarnessRunListResponse>("harnesses.list"),
  cliRuntimes: () => action<CliRuntimeListResponse>("runtimes.list"),
  discoverCliRuntimes: () => action<{ candidates: DiscoveredCliCandidate[] }>("runtimes.discover"),
  scanCliRuntimes: () => action<ScanCliRuntimesResponse>("runtimes.scan"),
  validateCliRuntime: (executablePath: string, cli: "codex" | "kimi", discoveredFrom: "shell-path" | "gui-path" | "manual" = "manual", discoveredShell: string | null = null) => action<{ runtime: CliRuntime }>("runtimes.validate", { executablePath, cli, discoveredFrom, discoveredShell }),
  selectCliRuntime: (runtimeId: string) => action<{ runtime: CliRuntime }>("runtimes.select", { runtimeId }),
  deleteCliRuntime: (runtimeId: string) => action<{ deleted: true }>("runtimes.delete", { runtimeId }),
  currentAttempt: (runId: string) => action<CurrentAttemptResponse>("runs.currentAttempt", { runId }),
  executionAttempts: (runId: string) => action<ExecutionAttemptsResponse>("runs.executionAttempts", { runId }),
  phaseVisit: (runId: string, phaseVisitId: number) => action<PhaseVisitResponse>("runs.phaseVisit", { runId, phaseVisitId }),
  phaseVisits: (runId: string, options: { cursor?: number; includeEmpty?: boolean; attempt?: number } = {}) => {
    return action<PhaseVisitPageResponse>("runs.phaseVisits", { runId, ...options });
  },
  /** Execution 的 Phase 访问分页；attempt 缺省时跨全部 attempt 聚合，用于补齐 replay 复用的 Phase → Agent 关系。 */
  executionPhaseVisits: (harnessRunId: string, executionId: string, options: { cursor?: number; includeEmpty?: boolean; attempt?: number } = {}) => {
    return action<ExecutionPhaseVisitPageResponse>("executions.phaseVisits", { harnessRunId, executionId, ...options });
  },
  pause: (runId: string) => action<RunResponse>("runs.pause", { runId }), recover: (runId: string) => action<RunResponse>("runs.recover", { runId }), stop: (runId: string) => action<RunResponse>("runs.stop", { runId }), resume: (runId: string) => action<RunResponse>("runs.resume", { runId }), answer: (blockRequestId: string, answer: Record<string, unknown>) => action("blocks.answer", { blockRequestId, answer }),
  projects: () => action<HarnessProjectListResponse>("projects.list"), createProject: (cwd: string, title?: string) => action<HarnessProjectResponse>("projects.create", { cwd, ...(title?.trim() ? { title } : {}) }), startHarnessConversation: (projectId: string, text: string, clientRequestId: string = crypto.randomUUID(), title?: string) => action<HarnessRunResponse>("harnesses.startConversation", { projectId, text, clientRequestId, ...(title ? { title } : {}) }), createHarness: (projectId: string) => action<HarnessRunResponse>("harnesses.create", { projectId }), harness: (harnessRunId: string) => action<HarnessRunResponse>("harnesses.get", { harnessRunId }), sendHarnessMessage: (harnessRunId: string, text: string) => action<HarnessRunResponse>("harnesses.send", { harnessRunId, text }), abortHarness: (harnessRunId: string) => action<HarnessRunResponse>("harnesses.abort", { harnessRunId }), completeHarness: (harnessRunId: string) => action<HarnessRunResponse>("harnesses.complete", { harnessRunId }), retryInitialization: (harnessRunId: string) => action<HarnessRunResponse>("harnesses.retryInitialization", { harnessRunId }), abandonCard: (harnessRunId: string, cardId: string) => action<HarnessRunResponse>("harnesses.abandonCard", { harnessRunId, cardId }), acceptWorkflowRevision: (harnessRunId: string, revision: number) => action<HarnessRunResponse>("harnesses.acceptRevision", { harnessRunId, revision }), rejectWorkflowRevision: (harnessRunId: string, revision: number) => action<HarnessRunResponse>("harnesses.rejectRevision", { harnessRunId, revision }), createExecution: (harnessRunId: string, revision: number, config: ExecutionConfigSnapshot, input: Record<string, unknown> = {}) => action<ExecutionResponse>("executions.create", { harnessRunId, revision, input, config }), planExecution: (harnessRunId: string, revision: number) => action<ExecutionPlanResponse>("executions.plan", { harnessRunId, revision }), randomizeExecutionAssignment: (harnessRunId: string, revision: number) => action<ExecutionRandomizeResponse>("executions.randomize", { harnessRunId, revision }), parseExecutionRule: (harnessRunId: string, revision: number, ruleText: string) => action<ExecutionParseRuleResponse>("executions.parseRule", { harnessRunId, revision, ruleText }, 130), executions: (harnessRunId: string) => action<ExecutionListResponse>("executions.list", { harnessRunId }), execution: (harnessRunId: string, executionId: string) => action<ExecutionResponse>("executions.get", { harnessRunId, executionId }), executionControl: (harnessRunId: string, executionId: string, actionName: "pause" | "recover" | "stop") => action<ExecutionResponse>("executions.control", { harnessRunId, executionId, action: actionName }), resumeExecution: (harnessRunId: string, executionId: string) => action<ExecutionResponse>("executions.resume", { harnessRunId, executionId }), answerExecutionGate: (harnessRunId: string, executionId: string, gateId: string, answer: Record<string, unknown>) => action<ExecutionResponse>("executions.answerGate", { harnessRunId, executionId, gateId, answer }), answerHarnessDecision: (harnessRunId: string, decisionId: string, answer: Record<string, unknown>) => action<HarnessRunResponse>("harnesses.answerDecision", { harnessRunId, decisionId, answer }),
  /** 订阅 Engine 事件帧；generation 变化表示 Engine 重启，调用方必须重读快照对齐序号。 */
  listenEngineEvents: (handler: (envelope: EngineEventEnvelope) => void) => listen<EngineEventEnvelope>("engine-event", (event) => handler(event.payload)),
};
