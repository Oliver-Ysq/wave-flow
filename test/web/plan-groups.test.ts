import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { groupWorkersByPhase } from "../../src-tauri/web/src/conversation/plan-groups";

test("计划按声明阶段分组，Agent 保持源码顺序，未知归属不丢弃", () => {
  const worker = (name: string, phaseTitle: string | null) => ({ key: name, name, phaseTitle, cli: "kimi" as const, loop: false });
  const groups = groupWorkersByPhase(["分析", "验证", "空阶段", "__unphased__"], [
    worker("v1", "验证"), worker("a1", "分析"), worker("v2", "验证"),
    worker("unknown", null), worker("literal", "__unphased__"),
  ]);
  expect(groups.map((group) => [group.title, group.workers.map((item) => item.name)])).toEqual([
    ["分析", ["a1"]], ["验证", ["v1", "v2"]], ["__unphased__", ["literal"]], ["归属待运行时确定", ["unknown"]],
  ]);
  expect(new Set(groups.map((group) => group.key)).size).toBe(groups.length);
  expect(groupWorkersByPhase([], [])).toEqual([]);
});

test("同名 Agent 保留为独立调用示意，不按名称去重", () => {
  const groups = groupWorkersByPhase(['检查'], [
    { key: 'call:1', name: 'Agent', phaseTitle: '检查', cli: null, loop: true },
    { key: 'call:2', name: 'Agent', phaseTitle: '检查', cli: null, loop: false },
  ]);
  expect(groups[0]?.workers.map((item) => item.key)).toEqual(['call:1', 'call:2']);
  expect(groups[0]?.workers.map((item) => item.loop)).toEqual([true, false]);
});

test("Workflow设计始终使用调用示意，动态默认CLI明确且不恢复分配卡", () => {
  const source = readFileSync(new URL('../../src-tauri/web/src/workflow-design.tsx', import.meta.url), 'utf8');
  expect(source).toContain('plan?.previewAgents??revision.preview?.previewAgents');
  expect(source).toContain('worker.nodeId??"*"');
  expect(source).toContain('循环/批量调用');
  expect(source).toContain('其余动态 Worker 默认使用');
  expect(source).not.toContain('ExecutionAssignmentFlow');
  expect(source).not.toContain('parseExecutionRule');
});
