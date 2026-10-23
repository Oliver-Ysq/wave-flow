import { expect, test } from "bun:test";
import type { JournalEvent, RunManifest } from "../../src/journal/types";
import { RUNTIME_VERSION } from "../../src/journal/types";
import { RunStateMachine } from "../../src/runtime/run-state-machine";
import type { NormalizedAgentRequest } from "../../src/shared/workflow-types";

const REQUEST: NormalizedAgentRequest = { id: "node", cli: "codex", sandbox: "workspace-write", cwd: "/tmp/wave-flow-hint", prompt: "做事", phase: "run" };
const SESSION_ID = "session-1";

function fixture(): {
  readonly manifest: RunManifest;
  readonly events: readonly JournalEvent[];
  readonly state: RunStateMachine;
  readonly runId: string;
  readonly at: (offset: number) => string;
} {
  const manifest: RunManifest = {
    runId: crypto.randomUUID(), clientRequestId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION,
    workflow: { name: "hint", description: "提示测试。", phases: [{ title: "run" }] },
    workflowHash: "a".repeat(64), workflowPath: "/tmp/wave-flow-hint/workflow.ts", workflowProjectCwd: "/tmp/wave-flow-hint",
    input: {}, createdAt: new Date().toISOString(),
  };
  const at = (offset: number): string => new Date(Date.parse(manifest.createdAt) + offset).toISOString();
  const events: JournalEvent[] = [
    { type: "run.created", at: at(0), runId: manifest.runId, nodeId: null, agentSessionId: null, diagnostic: null, runStatus: "running" },
    { type: "agent.created", at: at(1), runId: manifest.runId, nodeId: "node", agentSessionId: null, diagnostic: null, sequence: 1, phase: "run", request: REQUEST },
    { type: "agent.status", at: at(2), runId: manifest.runId, nodeId: "node", agentSessionId: SESSION_ID, diagnostic: null, status: "running" },
  ];
  const state = new RunStateMachine(manifest);
  for (const event of events) state.apply(event);
  return { manifest, events, state, runId: manifest.runId, at };
}

function nodeLog(runId: string, at: string, message: string): JournalEvent {
  return { type: "log.written", at, runId, nodeId: "node", agentSessionId: SESSION_ID, diagnostic: message, message };
}

test("节点绑定 log.written 只更新 hint，不改变状态与诊断；后续 agent.status 清空 hint", () => {
  const { manifest, events, state, runId, at } = fixture();
  const hint = "执行器约 90 秒无有效进展；仅作提示，不中断也不改变业务状态。";
  const log = nodeLog(runId, at(3), hint);
  state.apply(log);
  expect(state.agent("node")).toMatchObject({ status: "running", diagnostic: null, hint });

  // Run 级日志没有节点绑定，不得写入任何节点提示。
  state.apply({ type: "log.written", at: at(4), runId, nodeId: null, agentSessionId: null, diagnostic: null, message: "Run 级日志" });
  expect(state.agent("node").hint).toBe(hint);

  // Journal 重放必须得到同一投影：提示是可重建事实，不是内存副作用。
  const replayed = new RunStateMachine(manifest);
  for (const event of [...events, log]) replayed.apply(event);
  expect(replayed.agent("node")).toMatchObject({ status: "running", diagnostic: null, hint });

  // 任何状态事实都会让旧提示过期：这里以 agent.status 进入 blocked 为例。
  const blocked: JournalEvent = { type: "agent.status", at: at(5), runId, nodeId: "node", agentSessionId: SESSION_ID, diagnostic: "等待人工确认", status: "blocked" };
  state.apply(blocked);
  expect(state.agent("node")).toMatchObject({ status: "blocked", diagnostic: "等待人工确认", hint: null });

  // 旧档案中可能残留指向未知节点的日志；它必须被忽略而不是让整份档案无法重放。
  const ghost: JournalEvent = { type: "log.written", at: at(6), runId, nodeId: "ghost", agentSessionId: "ghost-session", diagnostic: "未知节点提示", message: "未知节点提示" };
  expect(() => state.apply(ghost)).not.toThrow();
  expect(state.agent("node").hint).toBeNull();
});

test("旧版 agent.hint 仍可回放为节点提示", () => {
  const { state, runId, at } = fixture();
  state.apply({ type: "agent.hint", at: at(3), runId, nodeId: "node", agentSessionId: SESSION_ID, diagnostic: null, message: "旧版启动提示" });
  expect(state.agent("node")).toMatchObject({ status: "running", hint: "旧版启动提示" });
});

test("agent.completed 清空 hint，但保留结果与完成诊断", () => {
  const { state, runId, at } = fixture();
  state.apply(nodeLog(runId, at(3), "执行器提示"));
  expect(state.agent("node").hint).toBe("执行器提示");
  const completed: JournalEvent = { type: "agent.completed", at: at(4), runId, nodeId: "node", agentSessionId: SESSION_ID, diagnostic: "完成摘要", resultPath: "results/node.json", result: { ok: true } };
  state.apply(completed);
  expect(state.agent("node")).toMatchObject({ status: "completed", diagnostic: "完成摘要", result: { ok: true }, hint: null });
});

test("agent.restarted 清空旧提示，新 attempt 不继承停滞 hint", () => {
  const { state, runId, at } = fixture();
  state.apply(nodeLog(runId, at(3), "旧 attempt 的停滞提示"));
  expect(state.agent("node").hint).toBe("旧 attempt 的停滞提示");
  const restarted: JournalEvent = {
    type: "agent.restarted", at: at(4), runId, nodeId: "node", agentSessionId: null, diagnostic: null,
    sequence: 1, newAgentSessionId: "session-2", invalidatedByPriorRestart: false,
    executionAttemptId: 1, phaseVisitId: 1, request: REQUEST,
  };
  state.apply(restarted);
  expect(state.agent("node")).toMatchObject({ status: "queued", diagnostic: "用户显式 resume 创建新 attempt。", agentSessionId: "session-2", hint: null });
});
