import { expect, test } from "bun:test";
import { assertCurrentWorkspaceRecord, isWorkspaceWriterAuthorized, validateExecutionWorkspaces, type ExecutionWorkspaceConfig } from "../../src/workspace/execution-workspaces";

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

test("循环写节点以字面量前缀授权：可只含动态前缀，前缀唯一且受字符集约束", () => {
  const input = config();
  const dynamic = { ...input, authorization: { ...input.authorization, dynamicNodes: [{ nodeIdPrefix: "repair-" }, { nodeIdPrefix: "retry-" }] } };
  expect(validateExecutionWorkspaces(dynamic).authorization.dynamicNodes).toEqual([{ nodeIdPrefix: "repair-" }, { nodeIdPrefix: "retry-" }]);
  // 只有循环写节点的脚本允许 nodes 为空，但不能两者都空。
  const onlyDynamic = { ...input, authorization: { ...input.authorization, nodes: [], dynamicNodes: [{ nodeIdPrefix: "repair-" }] } };
  expect(validateExecutionWorkspaces(onlyDynamic).authorization.nodes).toEqual([]);
  for (const bad of [[{ nodeIdPrefix: "" }], [{ nodeIdPrefix: "bad prefix" }], [{ nodeIdPrefix: "repair-" }, { nodeIdPrefix: "repair-" }], "repair-"])
    expect(() => validateExecutionWorkspaces({ ...input, authorization: { ...input.authorization, dynamicNodes: bad } })).toThrow("动态写节点");
});
test("封存写者核验：固定节点精确匹配，循环节点按已披露前缀匹配", () => {
  const authorization = { ...config().authorization, dynamicNodes: [{ nodeIdPrefix: "repair-" }] };
  expect(isWorkspaceWriterAuthorized(authorization, "a")).toBe(true);
  expect(isWorkspaceWriterAuthorized(authorization, "repair-1")).toBe(true);
  expect(isWorkspaceWriterAuthorized(authorization, "repair-")).toBe(true);
  expect(isWorkspaceWriterAuthorized(authorization, "repair-other")).toBe(true);
  expect(isWorkspaceWriterAuthorized(authorization, "hidden-1")).toBe(false);
  // 旧配置没有 dynamicNodes 时语义不变：动态 id 仍不被授权。
  expect(isWorkspaceWriterAuthorized(config().authorization, "repair-1")).toBe(false);
});
