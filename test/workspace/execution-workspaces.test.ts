import { expect, test } from "bun:test";
import { validateExecutionWorkspaces, type ExecutionWorkspaceConfig } from "../../src/workspace/execution-workspaces";

function config(): ExecutionWorkspaceConfig {
  return { version: 1, authorization: { authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), repository: "/repo", baseCommit: "a".repeat(40), excludeExistingDirty: false, nodes: [{ nodeId: "a", paths: ["a.ts"] }, { nodeId: "integrate", paths: ["a.ts"] }] }, bindings: [{ nodeId: "a", workspaceId: crypto.randomUUID() }, { nodeId: "integrate", workspaceId: crypto.randomUUID(), integrationSources: { nodeIds: ["a"] } }] };
}
test("Git授权深复制冻结，CLI配置不授予新workspace或来源权限", () => {
  const input = config(), accepted = validateExecutionWorkspaces(input); expect(accepted).toEqual(input); expect(accepted).not.toBe(input);
  (input.authorization.nodes as { nodeId: string; paths: string[] }[])[0].paths.push("secret"); expect(accepted.authorization.nodes[0].paths).toEqual(["a.ts"]);
});
test("自动squash授权缺省不启用，显式布尔值冻结，非法值拒绝", () => {
 const input = config();
 expect(validateExecutionWorkspaces(input).authorization.autoSquashDelivery).toBeUndefined();
 expect(validateExecutionWorkspaces({ ...input, authorization: { ...input.authorization, autoSquashDelivery: true } }).authorization.autoSquashDelivery).toBe(true);
 expect(() => validateExecutionWorkspaces({ ...input, authorization: { ...input.authorization, autoSquashDelivery: "true" } })).toThrow("boolean");
});
test("未授权节点、越界路径、重复绑定和缺失来源拒绝", () => {
  const input = config();
  expect(() => validateExecutionWorkspaces({ ...input, bindings: [...input.bindings, { nodeId: "x", workspaceId: crypto.randomUUID() }] })).toThrow("未授权");
  expect(() => validateExecutionWorkspaces({ ...input, authorization: { ...input.authorization, nodes: [{ nodeId: "a", paths: ["../secret"] }] } })).toThrow("路径");
  expect(() => validateExecutionWorkspaces({ ...input, bindings: [input.bindings[0], input.bindings[0]] })).toThrow("绑定");
  expect(() => validateExecutionWorkspaces({ ...input, bindings: [input.bindings[0]] })).toThrow("缺少workspace");
  expect(() => validateExecutionWorkspaces({ ...input, bindings: [input.bindings[0], { ...input.bindings[1], integrationSources: { nodeIds: ["future"] } }] })).toThrow("缺失或成环");
});
test("集成固定来源循环静态拒绝；动态批次只验证形状不假装证明Runtime依赖", () => {
  const input = config();
  expect(() => validateExecutionWorkspaces({ ...input, bindings: [{ ...input.bindings[0], integrationSources: { nodeIds: ["integrate"] } }, input.bindings[1]] })).toThrow("成环");
  expect(validateExecutionWorkspaces({ ...input, bindings: [input.bindings[0], { ...input.bindings[1], integrationSources: { batchSequence: 3 } }] }).bindings[1].integrationSources).toEqual({ batchSequence: 3 });
  expect(() => validateExecutionWorkspaces({ ...input, bindings: [input.bindings[0], { ...input.bindings[1], integrationSources: { batchSequence: 0 } }] })).toThrow("批次");
});
