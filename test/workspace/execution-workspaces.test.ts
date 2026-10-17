import { expect, test } from "bun:test";
import { validateExecutionWorkspaces, type ExecutionWorkspaceConfig } from "../../src/workspace/execution-workspaces";

function config(): ExecutionWorkspaceConfig {
  return { version: 2, authorization: { authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), repository: "/repo", baseCommit: "a".repeat(40), excludeExistingDirty: false, nodes: [{ nodeId: "a" }, { nodeId: "integrate" }] }, bindings: [{ nodeId: "a", workspaceId: crypto.randomUUID() }, { nodeId: "integrate", workspaceId: crypto.randomUUID(), integrationSources: { nodeIds: ["a"] } }] };
}
test("Git授权深复制冻结，CLI配置不授予新workspace或来源权限", () => {
  const input = config(), accepted = validateExecutionWorkspaces(input); expect(accepted).toEqual(input); expect(accepted).not.toBe(input);
  (input.authorization.nodes as { nodeId: string }[])[0].nodeId = "changed"; expect(accepted.authorization.nodes[0].nodeId).toBe("a");
});
test("旧v1与自动交付授权不能静默扩张为整工作区授权", () => {
 const input = config();
 expect(() => validateExecutionWorkspaces({...input, version:1})).toThrow("v2");
 expect(() => validateExecutionWorkspaces({...input, authorization:{...input.authorization, autoSquashDelivery:true}})).toThrow("旧自动");
});
test("未授权节点、越界路径、重复绑定和缺失来源拒绝", () => {
  const input = config();
  expect(() => validateExecutionWorkspaces({ ...input, bindings: [...input.bindings, { nodeId: "x", workspaceId: crypto.randomUUID() }] })).toThrow("未授权");
  expect(() => validateExecutionWorkspaces({ ...input, authorization: { ...input.authorization, nodes: [{ nodeId: "a", paths:["../secret"] }] } })).toThrow("节点授权");
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
test("续作来源UUID和冻结HEAD严格核验，仅允许本轮实际绑定工作区",()=>{
 const input=config(),head={workspaceId:input.bindings[0].workspaceId,commit:"b".repeat(40)},continuation={executionId:crypto.randomUUID(),heads:[head]};
 expect(validateExecutionWorkspaces({...input,continuation}).continuation).toEqual(continuation);
 for(const prior of [{...continuation,executionId:"bad"},{...continuation,heads:[]},{...continuation,heads:[head,head]},{...continuation,heads:[{...head,commit:"bad"}]}])expect(()=>validateExecutionWorkspaces({...input,continuation:prior})).toThrow();
});
