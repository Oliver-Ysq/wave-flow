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

  test("按耐久 executionBatch 投影串行与并行节点，旧事件保持单节点串行兼容", () => {
    const state = new RunStateMachine(manifest);
    const request = (id: string) => ({ id, cli: "codex" as const, sandbox: "read-only" as const, cwd: "/project", prompt: id, phase: "scan" });
    state.apply(event({ type: "run.created", runStatus: "running" }));
    state.apply(event({ type: "agent.created", nodeId: "serial-first", sequence: 1, phase: "scan", executionBatch: { sequence: 1, mode: "serial" }, request: request("serial-first") }));
    state.apply(event({ type: "agent.created", nodeId: "parallel-left", sequence: 2, phase: "scan", executionBatch: { sequence: 2, mode: "parallel" }, request: request("parallel-left") }));
    state.apply(event({ type: "agent.created", nodeId: "parallel-right", sequence: 3, phase: "scan", executionBatch: { sequence: 2, mode: "parallel" }, request: request("parallel-right") }));
    state.apply(event({ type: "agent.created", nodeId: "legacy", sequence: 4, phase: "scan", request: request("legacy") }));
    expect(state.snapshot().phases[0].batches).toEqual([
      { sequence: 1, mode: "serial", agents: [expect.objectContaining({ id: "serial-first" })] },
      { sequence: 2, mode: "parallel", agents: [expect.objectContaining({ id: "parallel-left" }), expect.objectContaining({ id: "parallel-right" })] },
      { sequence: 4, mode: "serial", agents: [expect.objectContaining({ id: "legacy" })] },
    ]);
  });

  test("只接受一次 run.created，且它必须是第一条事实", () => {
    const missingCreation = new RunStateMachine(manifest);
    expect(() => missingCreation.apply(event({ type: "run.status", status: "interrupted", diagnostic: "missing creation" }))).toThrow("第一条");

    const duplicateCreation = new RunStateMachine(manifest);
    duplicateCreation.apply(event({ type: "run.created", runStatus: "running" }));
    expect(() => duplicateCreation.apply(event({ type: "run.created", runStatus: "running" }))).toThrow("run.created 事件无效");
  });

  test("显式 resume 可为 interrupted 节点记录新 attempt，但不能覆盖 completed 结果", () => {
    const state = new RunStateMachine(manifest);
    const request = { id: "scan-auth", cli: "codex" as const, sandbox: "read-only" as const, cwd: "/project", prompt: "scan", phase: "scan" };
    state.apply(event({ type: "run.created", runStatus: "running" }));
    state.apply(event({ type: "agent.created", nodeId: "scan-auth", sequence: 1, phase: "scan", request }));
    state.apply(event({ type: "agent.status", nodeId: "scan-auth", agentSessionId: "old", status: "running" }));
    state.apply(event({ type: "agent.status", nodeId: "scan-auth", agentSessionId: "old", status: "interrupted" }));
    state.apply(event({ type: "agent.restarted", nodeId: "scan-auth", sequence: 1, newAgentSessionId: "new", invalidatedByPriorRestart: false, request }));
    expect(state.agent("scan-auth")).toMatchObject({ status: "queued", agentSessionId: "new" });
  });

  test("旧 completed 节点的 session 不能让 resume 把未投递的新 attempt 当作安全启动", () => {
    const state = new RunStateMachine(manifest);
    const request = { id: "scan-auth", cli: "codex" as const, sandbox: "read-only" as const, cwd: "/project", prompt: "scan", phase: "scan" };
    state.apply(event({ type: "run.created", runStatus: "running" }));
    state.apply(event({ type: "agent.created", nodeId: "scan-auth", sequence: 1, phase: "scan", request }));
    state.apply(event({ type: "agent.status", nodeId: "scan-auth", agentSessionId: "old", status: "running" }));
    state.apply(event({ type: "agent.session", nodeId: "scan-auth", agentSessionId: "old", delivery: "tmux", session: { backend: "tmux", sessionName: "wf", backendRef: "/tmp/wf.sock", runId: manifest.runId, nodeId: "scan-auth", agentSessionId: "old", cli: "codex", createdAt: new Date().toISOString() } }));
    state.apply(event({ type: "agent.completed", nodeId: "scan-auth", agentSessionId: "old", resultPath: "nodes/x/result.json", result: {} }));
    expect(state.hasRecordedSession()).toBe(false);
  });

  test("pause/recover 保留同一节点身份，并以 agent.recovered 更新最新 turn", () => {
    const state = new RunStateMachine(manifest);
    const request = { id: "scan-auth", cli: "codex" as const, sandbox: "read-only" as const, cwd: "/project", prompt: "scan", phase: "scan" };
    const session = { backend: "tmux" as const, sessionName: "wf-old", backendRef: "/tmp/wf.sock", runId: manifest.runId, nodeId: "scan-auth", agentSessionId: "same", cli: "codex" as const, createdAt: new Date().toISOString() };
    state.apply(event({ type: "run.created", runStatus: "running" }));
    state.apply(event({ type: "agent.created", nodeId: "scan-auth", sequence: 1, phase: "scan", request }));
    state.apply(event({ type: "agent.status", nodeId: "scan-auth", agentSessionId: "same", status: "running" }));
    state.apply(event({ type: "agent.session", nodeId: "scan-auth", agentSessionId: "same", delivery: "codex-rpc", session, appServer: { endpoint: "ws://127.0.0.1:4500", threadId: "thr-1", turnId: "turn-old", protocolVersion: 1 } }));
    state.apply(event({ type: "run.status", status: "pausing" }));
    state.apply(event({ type: "agent.status", nodeId: "scan-auth", agentSessionId: "same", status: "pausing" }));
    state.apply(event({ type: "agent.status", nodeId: "scan-auth", agentSessionId: "same", status: "paused" }));
    state.apply(event({ type: "run.status", status: "paused" }));
    state.apply(event({ type: "run.status", status: "recovering" }));
    state.apply(event({ type: "agent.status", nodeId: "scan-auth", agentSessionId: "same", status: "recovering" }));
    state.apply(event({ type: "agent.recovered", nodeId: "scan-auth", agentSessionId: "same", appServer: { endpoint: "ws://127.0.0.1:4500", threadId: "thr-1", turnId: "turn-new", protocolVersion: 1 } }));
    state.apply(event({ type: "agent.viewer", nodeId: "scan-auth", agentSessionId: "same", session: { ...session, sessionName: "wf-new" } }));
    state.apply(event({ type: "agent.status", nodeId: "scan-auth", agentSessionId: "same", status: "running" }));
    state.apply(event({ type: "run.status", status: "running" }));
    expect(state.agent("scan-auth")).toMatchObject({ status: "running", agentSessionId: "same" });
    expect(state.appServerBinding("scan-auth")?.turnId).toBe("turn-new");
    expect(state.viewerSession("scan-auth")?.sessionName).toBe("wf-new");
  });
});
