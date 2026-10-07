import type { CurrentAttemptResponse, ExecutionAttemptsResponse, PhaseVisitPageResponse, PhaseVisitResponse, RunListItem, RunResponse, TerminalOpenResponse } from "./types";

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
  listRuns: () => json<RunListItem[]>("/api/runs"),
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
  terminal: (runId: string, nodeId: string) => json<TerminalOpenResponse>(`/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/terminal`),
};
