import { expect, test } from "bun:test";
import { assertWorkspaceWriteIntent, hasWorkspaceWriteIntent, readWorkspaceWriteIntent } from "../../src/workspace/write-intent";
import type { ExecutionWorkspaceConfig } from "../../src/workspace/execution-workspaces";
const config: ExecutionWorkspaceConfig = { version: 3, authorization: { authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), repository: "/repo", baseCommit: "a".repeat(40), excludeExistingDirty: false, nodes: [{ nodeId: "write" }] }, workspaceId: crypto.randomUUID() };
/** 固定写节点 + 一个循环写节点前缀；覆盖“同一段脚本里既枚举固定节点又按轮次生成写节点”的常见形态。 */
const loopConfig: ExecutionWorkspaceConfig = { version: 3, authorization: { authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), repository: "/repo", baseCommit: "a".repeat(40), excludeExistingDirty: false, nodes: [{ nodeId: "write" }], dynamicNodes: [{ nodeIdPrefix: "repair-" }] }, workspaceId: crypto.randomUUID() };
test("写意图只核对固定节点，不从phase/label/prompt猜来源", () => {
  expect(() => assertWorkspaceWriteIntent('async function run() { await agent("merge everything", { id: "read", cli: "codex" }); await agent("work", { id: "write", cli: "codex", sandbox: "workspace-write" }); }', config)).not.toThrow();
  expect(() => assertWorkspaceWriteIntent('async function run() { await agent("write", { id: "write", cli: "codex" }); }', config)).toThrow("不一致");
});
test("动态写id/sandbox与展开选项不能获得受管Git授权", () => {
  for (const source of ['agent("work", { id: args.id, sandbox: "workspace-write" })', 'agent("work", { id: "write", sandbox: args.sandbox })', 'agent("work", { ...args, id: "write", sandbox: "workspace-write" })']) expect(() => assertWorkspaceWriteIntent(source, config)).toThrow("字面量");
});
test("schema 等与写授权无关的简写不使意图不确定", () => {
  expect(() => assertWorkspaceWriteIntent('async function run(args){ await agent("work", { id: "write", cli: "codex", sandbox: "workspace-write", schema }); }', config)).not.toThrow();
  expect(() => assertWorkspaceWriteIntent('async function run(args){ await agent("work", { id, sandbox: "workspace-write" }); }', config)).toThrow("字面量");
});
test("循环写节点的字面量前缀可作为一次性披露授权，实际节点在封存时核验", () => {
  const source = 'async function run(args){ for (const round of [1,2]) await agent("fix", { id: "repair-" + round, cli: "codex", sandbox: "workspace-write" }); await agent("work", { id: "write", cli: "codex", sandbox: "workspace-write" }); }';
  expect(readWorkspaceWriteIntent(source)).toEqual({ nodeIds: ["write"], dynamicNodePrefixes: ["repair-"], uncertain: false });
  expect(() => assertWorkspaceWriteIntent(source, loopConfig)).not.toThrow();
  // 模板串同样只取字面量段作为前缀；多段字面量拼接取完整已知前缀。
  expect(readWorkspaceWriteIntent('agent("fix", { id: `repair-${round}`, sandbox: "workspace-write" })').dynamicNodePrefixes).toEqual(["repair-"]);
  expect(readWorkspaceWriteIntent('agent("fix", { id: "repair-" + "r" + round, sandbox: "workspace-write" })').dynamicNodePrefixes).toEqual(["repair-r"]);
});
test("动态写节点前缀必须与用户披露完全一致，且不能冒充未声明前缀", () => {
  const source = 'agent("fix", { id: "repair-" + round, sandbox: "workspace-write" })';
  const noPrefixes: ExecutionWorkspaceConfig = { ...config, authorization: { ...config.authorization, nodes: [], dynamicNodes: [] } };
  expect(() => assertWorkspaceWriteIntent(source, noPrefixes)).toThrow("动态写节点前缀不一致");
  expect(() => assertWorkspaceWriteIntent(source, { ...loopConfig, authorization: { ...loopConfig.authorization, nodes: [], dynamicNodes: [{ nodeIdPrefix: "repair-" }, { nodeIdPrefix: "hidden-" }] } })).toThrow("动态写节点前缀不一致");
  const prefixOnly: ExecutionWorkspaceConfig = { ...loopConfig, authorization: { ...loopConfig.authorization, nodes: [] } };
  expect(() => assertWorkspaceWriteIntent('agent("fix", { id: "hidden-" + round, sandbox: "workspace-write" })', prefixOnly)).toThrow("动态写节点前缀不一致");
});
test("只读动态 id 不进入写授权；无稳定前缀的写 id 仍拒绝", () => {
  expect(readWorkspaceWriteIntent('agent("look", { id: "check-" + round, sandbox: "read-only" })')).toEqual({ nodeIds: [], dynamicNodePrefixes: [], uncertain: false });
  const readOnly = readWorkspaceWriteIntent('agent("look", { id: args.id, sandbox: "read-only" })');
  expect(readOnly).toEqual({ nodeIds: [], dynamicNodePrefixes: [], uncertain: false });
  expect(hasWorkspaceWriteIntent(readOnly)).toBe(false);
  expect(() => assertWorkspaceWriteIntent('agent("fix", { id: args.id, sandbox: "workspace-write" })', loopConfig)).toThrow("字面量");
  expect(() => assertWorkspaceWriteIntent('agent("fix", { id: (args.prefix) + round, sandbox: "workspace-write" })', loopConfig)).toThrow("字面量");
});
