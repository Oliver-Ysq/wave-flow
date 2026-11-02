import { expect, test } from "bun:test";
import type { JournalEvent, RunManifest } from "../../src/journal/types";
import { RUNTIME_VERSION } from "../../src/journal/types";
import { RunStateMachine } from "../../src/runtime/run-state-machine";
import type { NormalizedAgentRequest } from "../../src/shared/workflow-types";

const REQUEST: NormalizedAgentRequest = { id: "node", cli: "codex", sandbox: "read-only", cwd: "/tmp/wave-flow-continuation", prompt: "做事", phase: "run" };

function manifest(): RunManifest {
  return {
    runId: crypto.randomUUID(), clientRequestId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION,
    workflow: { name: "continuation", description: "续用状态测试。", phases: [{ title: "run" }] },
    workflowHash: "a".repeat(64), workflowPath: "/tmp/wave-flow-continuation/workflow.ts", workflowProjectCwd: "/tmp/wave-flow-continuation",
    input: {}, createdAt: new Date().toISOString(),
  };
}

function applyAll(state: RunStateMachine, events: readonly JournalEvent[]): void {
  for (const event of events) state.apply(event);
}

test("agent.restarted 只在携带 continuedFrom 时写入续用坐标，并清空旧 writer", () => {
  const run = manifest();
  const at = (offset: number): string => new Date(Date.parse(run.createdAt) + offset).toISOString();
  const base = { at: at(0), runId: run.runId, nodeId: null, agentSessionId: null, diagnostic: null };
  const state = new RunStateMachine(run);
  applyAll(state, [
    { ...base, type: "run.created", runStatus: "running" },
    { ...base, type: "execution-attempt.started", executionAttemptId: 1 },
    { ...base, type: "phase.entered", executionAttemptId: 1, phaseVisitId: 1, title: "run", occurrence: 1 },
    { ...base, at: at(1), nodeId: "node", type: "agent.created", sequence: 1, phase: "run", executionAttemptId: 1, phaseVisitId: 1, request: REQUEST },
    { ...base, at: at(2), nodeId: "node", agentSessionId: "wf-1", type: "agent.status", status: "running" },
    {
      ...base, at: at(3), nodeId: "node", agentSessionId: "wf-1", type: "agent.session", delivery: "acp",
      acp: { launcherId: "codex-acp", sessionId: "acp-1", capabilities: {}, writer: { pgid: 4242, startedAt: "fp-1" } },
    },
    { ...base, at: at(4), nodeId: "node", agentSessionId: "wf-1", type: "agent.status", status: "interrupted" },
    { ...base, at: at(5), type: "execution-attempt.started", executionAttemptId: 2 },
    { ...base, at: at(6), type: "phase.entered", executionAttemptId: 2, phaseVisitId: 1, title: "run", occurrence: 1 },
    {
      ...base, at: at(7), nodeId: "node", agentSessionId: "wf-2", type: "agent.restarted", sequence: 1,
      newAgentSessionId: "wf-2", invalidatedByPriorRestart: false, executionAttemptId: 2, phaseVisitId: 1,
      request: REQUEST, continuedFrom: { launcherId: "codex-acp", sessionId: "acp-1" },
    },
  ]);
  const node = state.snapshot().phases.flatMap((phase) => phase.agents).find((agent) => agent.id === "node")!;
  expect(node.continuation).toEqual({ launcherId: "codex-acp", sessionId: "acp-1" });
  expect(node.writer).toBeNull();
  expect(node.agentSessionId).toBe("wf-2");
});

test("agent.session 缺少 writer 证据时保留启动意图，供围栏 fail closed", () => {
  const run = manifest();
  const at = (offset: number): string => new Date(Date.parse(run.createdAt) + offset).toISOString();
  const base = { at: at(0), runId: run.runId, nodeId: null, agentSessionId: null, diagnostic: null };
  const state = new RunStateMachine(run);
  applyAll(state, [
    { ...base, type: "run.created", runStatus: "running" },
    { ...base, type: "execution-attempt.started", executionAttemptId: 1 },
    { ...base, type: "phase.entered", executionAttemptId: 1, phaseVisitId: 1, title: "run", occurrence: 1 },
    { ...base, at: at(1), nodeId: "node", type: "agent.created", sequence: 1, phase: "run", executionAttemptId: 1, phaseVisitId: 1, request: REQUEST },
    { ...base, at: at(2), nodeId: "node", agentSessionId: "wf-1", type: "agent.status", status: "running" },
    { ...base, at: at(3), nodeId: "node", agentSessionId: "wf-1", type: "agent.writerIntent", status: "started" },
    { ...base, at: at(4), nodeId: "node", agentSessionId: "wf-1", type: "agent.session", delivery: "acp", acp: { launcherId: "codex-acp", sessionId: "acp-1", capabilities: {} } },
  ]);
  const node = state.snapshot().phases.flatMap((phase) => phase.agents).find((agent) => agent.id === "node")!;
  expect(node.writer).toBeNull();
  expect(node.writerIntentAt).toBe(at(3));
});

test("带 writer 证据的 agent.session 会清空启动意图", () => {
  const run = manifest();
  const at = (offset: number): string => new Date(Date.parse(run.createdAt) + offset).toISOString();
  const base = { at: at(0), runId: run.runId, nodeId: null, agentSessionId: null, diagnostic: null };
  const state = new RunStateMachine(run);
  applyAll(state, [
    { ...base, type: "run.created", runStatus: "running" },
    { ...base, type: "execution-attempt.started", executionAttemptId: 1 },
    { ...base, type: "phase.entered", executionAttemptId: 1, phaseVisitId: 1, title: "run", occurrence: 1 },
    { ...base, at: at(1), nodeId: "node", type: "agent.created", sequence: 1, phase: "run", executionAttemptId: 1, phaseVisitId: 1, request: REQUEST },
    { ...base, at: at(2), nodeId: "node", agentSessionId: "wf-1", type: "agent.status", status: "running" },
    { ...base, at: at(3), nodeId: "node", agentSessionId: "wf-1", type: "agent.writerIntent", status: "started" },
    { ...base, at: at(4), nodeId: "node", agentSessionId: "wf-1", type: "agent.session", delivery: "acp", acp: { launcherId: "codex-acp", sessionId: "acp-1", capabilities: {}, writer: { pgid: 4242, startedAt: "fp" } } },
  ]);
  const node = state.snapshot().phases.flatMap((phase) => phase.agents).find((agent) => agent.id === "node")!;
  expect(node.writer).toEqual({ pgid: 4242, startedAt: "fp" });
  expect(node.writerIntentAt).toBeNull();
});

test("不带 continuedFrom 的 restart 不续用任何旧会话", () => {
  const run = manifest();
  const at = (offset: number): string => new Date(Date.parse(run.createdAt) + offset).toISOString();
  const base = { at: at(0), runId: run.runId, nodeId: null, agentSessionId: null, diagnostic: null };
  const state = new RunStateMachine(run);
  applyAll(state, [
    { ...base, type: "run.created", runStatus: "running" },
    { ...base, type: "execution-attempt.started", executionAttemptId: 1 },
    { ...base, type: "phase.entered", executionAttemptId: 1, phaseVisitId: 1, title: "run", occurrence: 1 },
    { ...base, at: at(1), nodeId: "node", type: "agent.created", sequence: 1, phase: "run", executionAttemptId: 1, phaseVisitId: 1, request: REQUEST },
    { ...base, at: at(2), nodeId: "node", agentSessionId: "wf-1", type: "agent.status", status: "running" },
    { ...base, at: at(3), nodeId: "node", agentSessionId: "wf-1", type: "agent.session", delivery: "acp", acp: { launcherId: "codex-acp", sessionId: "acp-1", capabilities: {} } },
    { ...base, at: at(4), nodeId: "node", agentSessionId: "wf-1", type: "agent.status", status: "interrupted" },
    { ...base, at: at(5), type: "execution-attempt.started", executionAttemptId: 2 },
    { ...base, at: at(6), type: "phase.entered", executionAttemptId: 2, phaseVisitId: 1, title: "run", occurrence: 1 },
    {
      ...base, at: at(7), nodeId: "node", agentSessionId: "wf-2", type: "agent.restarted", sequence: 1,
      newAgentSessionId: "wf-2", invalidatedByPriorRestart: false, executionAttemptId: 2, phaseVisitId: 1, request: REQUEST,
    },
  ]);
  const node = state.snapshot().phases.flatMap((phase) => phase.agents).find((agent) => agent.id === "node")!;
  expect(node.continuation).toBeNull();
});
