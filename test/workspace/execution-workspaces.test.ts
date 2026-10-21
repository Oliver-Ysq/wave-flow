import { expect, test } from "bun:test";
import { assertCurrentWorkspaceRecord, validateExecutionWorkspaces, type ExecutionWorkspaceConfig } from "../../src/workspace/execution-workspaces";

function config(): ExecutionWorkspaceConfig {
  return { version: 3, authorization: { authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), repository: "/repo", baseCommit: "a".repeat(40), excludeExistingDirty: false, nodes: [{ nodeId: "a" }, { nodeId: "b" }] }, workspaceId: crypto.randomUUID() };
}
test("Git授权深复制冻结，CLI配置不授予新workspace或节点权限", () => {
  const input = config(), accepted = validateExecutionWorkspaces(input); expect(accepted).toEqual(input); expect(accepted).not.toBe(input);
  (input.authorization.nodes as { nodeId: string }[])[0].nodeId = "changed"; expect(accepted.authorization.nodes[0].nodeId).toBe("a");
});
test("旧v2每节点绑定与自动交付授权不能静默升级为共享worktree", () => {
  const input = config();
  expect(() => validateExecutionWorkspaces({ ...input, version: 2 })).toThrow("v3");
  expect(() => validateExecutionWorkspaces({ ...input, authorization: { ...input.authorization, autoSquashDelivery: true } })).toThrow("旧自动");
  const { workspaceId: _workspaceId, ...withoutWorkspace } = input;
  expect(() => validateExecutionWorkspaces(withoutWorkspace)).toThrow();
});
test("写节点授权校验拒绝越界路径、重复节点与外部分组字段", () => {
  const input = config();
  expect(() => validateExecutionWorkspaces({ ...input, authorization: { ...input.authorization, nodes: [{ nodeId: "a", paths: ["../secret"] }] } })).toThrow("节点授权");
  expect(() => validateExecutionWorkspaces({ ...input, authorization: { ...input.authorization, nodes: [{ nodeId: "a", externalResources: ["db"] }] } })).toThrow("节点授权");
  expect(() => validateExecutionWorkspaces({ ...input, authorization: { ...input.authorization, nodes: [{ nodeId: "a" }, { nodeId: "a" }] } })).toThrow("节点授权");
  expect(() => validateExecutionWorkspaces({ ...input, authorization: { ...input.authorization, nodes: [] } })).toThrow("授权字段");
});
test("旧版记录在入口显式拒绝，不泄漏UUID断言", () => {
  expect(() => assertCurrentWorkspaceRecord({ version: 2, bindings: {} })).toThrow("不自动升级");
  expect(() => assertCurrentWorkspaceRecord(undefined)).toThrow("不自动升级");
  expect(() => assertCurrentWorkspaceRecord(config())).not.toThrow();
});
test("续作UUID、共享worktree身份与冻结HEAD严格核验", () => {
  const input = config();
  const continuation = { executionId: crypto.randomUUID(), workspaceId: input.workspaceId, head: "b".repeat(40) };
  expect(validateExecutionWorkspaces({ ...input, continuation }).continuation).toEqual(continuation);
  for (const prior of [
    { ...continuation, executionId: "bad" },
    { ...continuation, workspaceId: crypto.randomUUID() },
    { ...continuation, head: "bad" },
    { ...continuation, heads: [] },
  ]) expect(() => validateExecutionWorkspaces({ ...input, continuation: prior })).toThrow();
});
