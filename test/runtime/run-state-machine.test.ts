import { describe, expect, test } from "bun:test";
import { RUNTIME_VERSION, type RunManifest } from "../../src/journal/types";
import { RunStateMachine } from "../../src/runtime/run-state-machine";

const manifest: RunManifest = {
  runId: "11111111-1111-4111-8111-111111111111", clientRequestId: "22222222-2222-4222-8222-222222222222", runtimeVersion: RUNTIME_VERSION,
  workflow: { name: "state-check", description: "Check state.", phases: [{ title: "scan" }] },
  workflowHash: "a".repeat(64), workflowPath: "/project/.wave-flow/workflows/check.ts", workflowProjectCwd: "/project", input: {}, createdAt: "2026-10-02T00:00:00.000Z",
};

function event(value: Record<string, unknown>) {
  return { at: "2026-10-02T00:00:01.000Z", runId: manifest.runId, nodeId: null, agentSessionId: null, diagnostic: null, ...value } as never;
}

describe("Run 状态机", () => {
  test("按 Phase 与调用顺序投影节点，且终态不可回退", () => {
    const state = new RunStateMachine(manifest);
    state.apply(event({ type: "run.created", runStatus: "running" }));
    state.apply(event({ type: "agent.created", nodeId: "scan-auth", sequence: 1, phase: "scan", request: { id: "scan-auth", cli: "codex", sandbox: "read-only", cwd: "/project", prompt: "scan", phase: "scan" } }));
    state.apply(event({ type: "agent.status", nodeId: "scan-auth", status: "running" }));
    state.apply(event({ type: "agent.completed", nodeId: "scan-auth", resultPath: "nodes/x/result.json", result: { ok: true } }));
    expect(state.snapshot().phases[0].agents[0]).toMatchObject({ id: "scan-auth", status: "completed", result: { ok: true } });
    expect(() => state.apply(event({ type: "agent.status", nodeId: "scan-auth", status: "running" }))).toThrow("非法 Agent 状态转移");
  });

  test("只接受一次 run.created，且它必须是第一条事实", () => {
    const missingCreation = new RunStateMachine(manifest);
    expect(() => missingCreation.apply(event({ type: "run.status", status: "interrupted", diagnostic: "missing creation" }))).toThrow("第一条");

    const duplicateCreation = new RunStateMachine(manifest);
    duplicateCreation.apply(event({ type: "run.created", runStatus: "running" }));
    expect(() => duplicateCreation.apply(event({ type: "run.created", runStatus: "running" }))).toThrow("run.created 事件无效");
  });
});
