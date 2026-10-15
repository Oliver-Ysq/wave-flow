import { expect, test } from "bun:test";
import { computeExecutionProgress } from "../../src-tauri/web/src/execution/execution-progress";
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
