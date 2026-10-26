import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { computeExecutionProgress } from "../../src-tauri/web/src/execution/execution-progress";
import { ExecutionProgressCard } from "../../src-tauri/web/src/execution/progress-card";
import type { AgentSnapshot, RunSnapshot } from "../../src-tauri/web/src/types";

/** 构造最小 Agent 节点。 */
function agent(id: string, status: AgentSnapshot["status"]): AgentSnapshot {
  return {
    id,
    label: `节点 ${id}`,
    cli: "codex",
    status,
    cwd: "/tmp",
    result: null,
    diagnostic: null,
    block: null,
  };
}

/** 构造只含指定批次结构的 Run 快照。 */
function snapshot(
  phases: RunSnapshot["phases"],
): RunSnapshot {
  return {
    id: "r1",
    status: "running",
    workflow: { name: "w", description: "" },
    cwd: "/tmp",
    createdAt: "2026-10-15T08:00:00Z",
    endedAt: null,
    diagnostic: null,
    phases,
    currentExecutionAttemptId: 1,
    phaseVisits: [],
    gates: [],
  };
}

/** 包装单批次的 Phase。 */
function phase(
  title: string,
  batches: Array<{ mode: "serial" | "parallel"; agents: AgentSnapshot[] }>,
): RunSnapshot["phases"][number] {
  return {
    title,
    agents: batches.flatMap((batch) => batch.agents),
    batches: batches.map((batch, index) => ({
      sequence: index + 1,
      mode: batch.mode,
      agents: batch.agents,
    })),
  };
}

test("静态分母：completed 计入完成数，blocked/running 不计", () => {
  const result = computeExecutionProgress(
    snapshot([
      phase("构建", [
        { mode: "parallel", agents: [agent("a", "completed"), agent("b", "running"), agent("c", "blocked")] },
        { mode: "serial", agents: [agent("d", "queued")] },
      ]),
      phase("验证", [{ mode: "serial", agents: [agent("e", "completed")] }]),
    ]),
  );
  expect(result.total).toBe(5);
  expect(result.completed).toBe(2);
  expect(result.items.map((item) => item.id)).toEqual(["a", "b", "c", "d", "e"]);
});

test("cancelled/interrupted 如实保留状态但不计完成", () => {
  const result = computeExecutionProgress(
    snapshot([
      phase("执行", [
        { mode: "serial", agents: [agent("a", "cancelled"), agent("b", "interrupted"), agent("c", "completed")] },
      ]),
    ]),
  );
  expect(result.completed).toBe(1);
  expect(result.total).toBe(3);
  expect(result.items[0].status).toBe("cancelled");
  expect(result.items[1].status).toBe("interrupted");
});

test("无节点快照返回 0/0；动态节点不在统计内（由调用方另行表达）", () => {
  const result = computeExecutionProgress(snapshot([]));
  expect(result.total).toBe(0);
  expect(result.completed).toBe(0);
  expect(result.items).toEqual([]);
});

test("恢复进度包含历史已交付节点，不重复计算新 attempt 同 id", () => {
  const current = snapshot([phase("收尾", [{ mode: "serial", agents: [agent("b", "completed")] }])]);
  current.currentExecutionAttemptId = 2;
  const visits = [{ executionAttemptId: 1, phaseVisitId: 1, title: "准备", occurrence: 1, createdAt: current.createdAt, batches: [{ sequence: 1, mode: "serial" as const, agents: [agent("a", "completed"), agent("b", "completed"), agent("c", "cancelled")] }] }];
  const result = computeExecutionProgress(current, 2, visits);
  expect(result.completed).toBe(2);
  expect(result.total).toBe(2);
  expect(result.items.map(item => item.id)).toEqual(["b", "a"]);
});

test("动态节点场景只展示完成数和必要方案信息，不暴露内部调度术语", () => {
  const current = snapshot([
    phase("执行", [{
      mode: "parallel",
      agents: Array.from({ length: 5 }, (_, index) => agent(String(index), "completed")),
    }]),
  ]);
  const html = renderToStaticMarkup(createElement(ExecutionProgressCard, {
    snapshot: current,
    dynamicCount: 2,
    plannedTotal: 5,
    meta: "方案 v1（已锁定） · 3 名执行者",
  }));
  expect(html).toContain("5 完成");
  expect(html).toContain("方案 v1（已锁定） · 3 名执行者");
  expect(html).not.toContain("动态节点");
  expect(html).not.toContain("静态节点");
  expect(html).not.toContain("数量待定");
  expect(html).not.toContain("分母");
});
