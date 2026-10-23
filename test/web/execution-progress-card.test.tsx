import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutionProgressCard } from "../../src-tauri/web/src/execution/progress-card";
import type { AgentSnapshot, RunSnapshot } from "../../src-tauri/web/src/types";

function agent(id: string, status: AgentSnapshot["status"]): AgentSnapshot {
  return { id, label: `节点 ${id}`, cli: "codex", status, cwd: "/tmp", result: null, diagnostic: null, block: null };
}

function snapshot(status: RunSnapshot["status"], nodeStatus: AgentSnapshot["status"]): RunSnapshot {
  const node = agent("node-1", nodeStatus);
  return {
    id: crypto.randomUUID(),
    status,
    workflow: { name: "wf", description: "测试" },
    cwd: "/tmp",
    createdAt: new Date().toISOString(),
    endedAt: null,
    diagnostic: null,
    phases: [{ title: "阶段", agents: [node], batches: [{ sequence: 1, mode: "serial", agents: [node] }] }],
    currentExecutionAttemptId: 1,
    phaseVisits: [],
    gates: [],
  };
}

test("进度卡只在运行中显示 queued 的“准备启动”", () => {
  expect(renderToStaticMarkup(<ExecutionProgressCard snapshot={snapshot("running", "queued")} />)).toContain("准备启动");
});

test("暂停显示“已暂停”，终态不再显示启动提示", () => {
  const paused = renderToStaticMarkup(<ExecutionProgressCard snapshot={snapshot("paused", "paused")} />);
  expect(paused).toContain("已暂停");
  expect(paused).not.toContain("准备启动");
  for (const status of ["cancelled", "interrupted", "completed"] as const) {
    const html = renderToStaticMarkup(<ExecutionProgressCard snapshot={snapshot(status, status === "completed" ? "completed" : "queued")} />);
    expect(html).not.toContain("准备启动");
    expect(html).not.toContain("正在执行");
  }
});

test("blocked 节点显示等待回答", () => {
  expect(renderToStaticMarkup(<ExecutionProgressCard snapshot={snapshot("running", "blocked")} />)).toContain("等待你的回答");
});
