import type { CliRuntime, CliRuntimeListResponse, CreateRunRequest, CurrentAttemptResponse, DaemonStatusResponse, DiscoveredCliCandidate, ExecutionAttemptsResponse, ExecutionListResponse, ExecutionResponse, HarnessProjectListResponse, HarnessProjectResponse, HarnessRunListResponse, HarnessRunResponse, PhaseVisitPageResponse, PhaseVisitResponse, RunListItem, RunResponse, ScanCliRuntimesResponse } from "./types";

async function json<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json() as T | { error?: string };
  if (!response.ok) {
    const message = typeof value === "object" && value !== null && "error" in value ? value.error : undefined;
    throw new Error(typeof message === "string" ? message : "请求失败");
  }
  return value as T;
}

export const api = {
  daemonStatus: () => json<DaemonStatusResponse>("/daemon/status"),
  closeDaemon: () => json<{ closing: true }>("/daemon/close", {}),
  createRun: (request: CreateRunRequest) => json<RunResponse>("/runs", request),
  listRuns: () => json<RunListItem[]>("/api/runs"),
  listHarnesses: () => json<HarnessRunListResponse>("/api/harness-runs"),
  cliRuntimes: () => json<CliRuntimeListResponse>("/cli-runtimes"),
  discoverCliRuntimes: () => json<{ candidates: DiscoveredCliCandidate[] }>("/cli-runtimes/discover", {}),
  scanCliRuntimes: () => json<ScanCliRuntimesResponse>("/cli-runtimes/scan", {}),
  validateCliRuntime: (executablePath: string, discoveredFrom: "shell-path" | "gui-path" | "manual" = "manual", discoveredShell: string | null = null) => json<{ runtime: CliRuntime }>("/cli-runtimes/validate", { executablePath, discoveredFrom, discoveredShell }),
  selectCliRuntime: (runtimeId: string) => json<{ runtime: CliRuntime }>(`/cli-runtimes/${encodeURIComponent(runtimeId)}/select`, {}),
  deleteCliRuntime: async (runtimeId: string) => { const response = await fetch(`/cli-runtimes/${encodeURIComponent(runtimeId)}`, { method: "DELETE" }); if (!response.ok) { const value = await response.json() as { error?: string }; throw new Error(value.error ?? "删除 Runtime 失败"); } },
  currentAttempt: (runId: string) => json<CurrentAttemptResponse>(`/runs/${encodeURIComponent(runId)}/attempts/current`),
  executionAttempts: (runId: string) => json<ExecutionAttemptsResponse>(`/runs/${encodeURIComponent(runId)}/attempts`),
  phaseVisit: (runId: string, phaseVisitId: number) => json<PhaseVisitResponse>(`/runs/${encodeURIComponent(runId)}/phase-visits/${phaseVisitId}`),
  phaseVisits: (runId: string, options: { cursor?: number; includeEmpty?: boolean; attempt?: number } = {}) => {
    const query = new URLSearchParams();
    if (options.cursor !== undefined) query.set("cursor", String(options.cursor));
    if (options.includeEmpty) query.set("includeEmpty", "true");
    if (options.attempt !== undefined) query.set("attempt", String(options.attempt));
    return json<PhaseVisitPageResponse>(`/runs/${encodeURIComponent(runId)}/phase-visits${query.size ? `?${query}` : ""}`);
  },
  pause: (runId: string) => json<RunResponse>(`/runs/${encodeURIComponent(runId)}/pause`, {}),
  recover: (runId: string) => json<RunResponse>(`/runs/${encodeURIComponent(runId)}/recover`, {}),
  stop: (runId: string) => json<RunResponse>(`/runs/${encodeURIComponent(runId)}/stop`, {}),
  resume: (runId: string) => json<RunResponse>(`/runs/${encodeURIComponent(runId)}/resume`, { authorized: true }),
  answer: (blockId: string, answer: Record<string, unknown>) => json(`/blocks/${encodeURIComponent(blockId)}/answer`, { answer }),
  projects: () => json<HarnessProjectListResponse>("/projects"),
  createProject: (cwd: string, title?: string) => json<HarnessProjectResponse>("/projects", { cwd, ...(title?.trim() ? { title } : {}) }),
  startHarnessConversation: (projectId: string, text: string) => json<HarnessRunResponse>(`/projects/${encodeURIComponent(projectId)}/harness-messages`, { projectId, text }),
  createHarness: (projectId: string) => json<HarnessRunResponse>("/harness-runs", { projectId }),
  harness: (harnessRunId: string) => json<HarnessRunResponse>(`/harness-runs/${encodeURIComponent(harnessRunId)}`),
  sendHarnessMessage: (harnessRunId: string, text: string) => json<HarnessRunResponse>(`/harness-runs/${encodeURIComponent(harnessRunId)}/messages`, { text }),
  abortHarness: (harnessRunId: string) => json<HarnessRunResponse>(`/harness-runs/${encodeURIComponent(harnessRunId)}/abort`, {}),
  proposeWorkflowRevision: (harnessRunId: string, source: string) => json<HarnessRunResponse>(`/harness-runs/${encodeURIComponent(harnessRunId)}/workflow-revisions`, { source }),
  acceptWorkflowRevision: (harnessRunId: string, revision: number) => json<HarnessRunResponse>(`/harness-runs/${encodeURIComponent(harnessRunId)}/workflow-revisions/${revision}/accept`, {}),
  createExecution: (harnessRunId: string, revision: number, input: Record<string, unknown> = {}) => json<ExecutionResponse>(`/harness-runs/${encodeURIComponent(harnessRunId)}/executions`, { revision, input }),
  executions: (harnessRunId: string) => json<ExecutionListResponse>(`/harness-runs/${encodeURIComponent(harnessRunId)}/executions`),
  execution: (harnessRunId: string, executionId: string) => json<ExecutionResponse>(`/harness-runs/${encodeURIComponent(harnessRunId)}/executions/${encodeURIComponent(executionId)}`),
  executionControl: (harnessRunId: string, executionId: string, action: "pause" | "recover" | "stop") => json<ExecutionResponse>(`/harness-runs/${encodeURIComponent(harnessRunId)}/executions/${encodeURIComponent(executionId)}/${action}`, {}),
  resumeExecution: (harnessRunId: string, executionId: string) => json<ExecutionResponse>(`/harness-runs/${encodeURIComponent(harnessRunId)}/executions/${encodeURIComponent(executionId)}/resume`, { authorized: true }),
  answerExecutionGate: (harnessRunId: string, executionId: string, gateId: string, answer: Record<string, unknown>) => json<ExecutionResponse>(`/harness-runs/${encodeURIComponent(harnessRunId)}/executions/${encodeURIComponent(executionId)}/gates/${encodeURIComponent(gateId)}/answer`, { answer }),
  answerHarnessDecision: (harnessRunId: string, decisionId: string, answer: Record<string, unknown>) => json<HarnessRunResponse>(`/harness-runs/${encodeURIComponent(harnessRunId)}/decisions/${encodeURIComponent(decisionId)}/answer`, { answer }),
};
