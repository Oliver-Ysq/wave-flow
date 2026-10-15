import { expect, test } from "bun:test";
import { computeReusedAgents } from "../../src-tauri/web/src/execution/reused-agents";
import type { AgentSnapshot, PhaseVisit } from "../../src-tauri/web/src/types";

/** 构造最小 Agent 节点。 */
function agent(id: string, status: AgentSnapshot["status"]): AgentSnapshot {
  return { id, label: id, cli: "kimi", status, cwd: "/tmp" } as AgentSnapshot;
}

/** 构造一次 Phase 访问。 */
function visit(attempt: number, visitId: number, title: string, occurrence: number, agents: AgentSnapshot[]): PhaseVisit {
  return {
    executionAttemptId: attempt,
    phaseVisitId: visitId,
    title,
    occurrence,
    createdAt: "2026-10-15T00:00:00Z",
    batches: [{ sequence: 1, mode: "parallel", agents }],
  };
}

test("历史访问已交付且当前 attempt 未重跑的节点进入复用组", () => {
  const groups = computeReusedAgents(
    [
      visit(1, 1, "验证", 1, [agent("verify-name", "completed")]),
      visit(1, 2, "分析", 1, [agent("check-git", "completed"), agent("check-readme", "completed")]),
      visit(2, 3, "验证", 2, [agent("verify-name-recheck", "completed")]),
      visit(2, 4, "汇总", 1, [agent("synthesize", "completed")]),
    ],
    2,
  );
  expect(groups.get("验证")).toMatchObject({ sourceAttemptId: 1, sourceOccurrence: 1 });
  expect(groups.get("验证")?.agents.map((item) => item.id)).toEqual(["verify-name"]);
  expect(groups.get("分析")?.agents.map((item) => item.id)).toEqual(["check-git", "check-readme"]);
  expect(groups.has("汇总")).toBe(false);
});

test("当前 attempt 已重跑的同名节点不重复进入复用组", () => {
  const groups = computeReusedAgents(
    [
      visit(1, 1, "验证", 1, [agent("w1", "completed"), agent("w2", "completed")]),
      visit(2, 2, "验证", 2, [agent("w1", "running")]),
    ],
    2,
  );
  expect(groups.get("验证")?.agents.map((item) => item.id)).toEqual(["w2"]);
});

test("非 completed 的历史节点不是可复用结果；同标题取最近一次历史访问", () => {
  const groups = computeReusedAgents(
    [
      visit(1, 1, "验证", 1, [agent("old", "completed")]),
      visit(1, 2, "验证", 2, [agent("dead", "interrupted")]),
      visit(2, 3, "汇总", 1, [agent("now", "running")]),
    ],
    2,
  );
  expect(groups.has("验证")).toBe(false);
  expect(groups.has("汇总")).toBe(false);
});

test("第一个 attempt 没有任何历史访问，复用组为空", () => {
  const groups = computeReusedAgents([visit(1, 1, "验证", 1, [agent("w1", "running")])], 1);
  expect(groups.size).toBe(0);
});
