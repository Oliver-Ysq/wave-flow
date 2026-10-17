import { expect, test } from "bun:test";
import { assertWorkspaceWriteIntent } from "../../src/workspace/write-intent";
import type { ExecutionWorkspaceConfig } from "../../src/workspace/execution-workspaces";
const config: ExecutionWorkspaceConfig = { version: 2, authorization: { authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), repository: "/repo", baseCommit: "a".repeat(40), excludeExistingDirty: false, nodes: [{ nodeId: "write" }] }, bindings: [{ nodeId: "write", workspaceId: crypto.randomUUID() }] };
test("写意图只核对固定节点，不从phase/label/prompt猜来源", () => {
  expect(() => assertWorkspaceWriteIntent('async function run() { await agent("merge everything", { id: "read", cli: "codex" }); await agent("work", { id: "write", cli: "codex", sandbox: "workspace-write" }); }', config)).not.toThrow();
  expect(() => assertWorkspaceWriteIntent('async function run() { await agent("write", { id: "write", cli: "codex" }); }', config)).toThrow("不一致");
});
test("动态写id/sandbox与展开选项不能获得受管Git授权", () => {
  for (const source of ['agent("work", { id: args.id, sandbox: "workspace-write" })', 'agent("work", { id: "write", sandbox: args.sandbox })', 'agent("work", { ...args, id: "write", sandbox: "workspace-write" })']) expect(() => assertWorkspaceWriteIntent(source, config)).toThrow("字面量");
});
