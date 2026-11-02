import { expect, test } from "bun:test";

test("执行结束后只保留受管 worktree，不提供变更面板、自动应用或清理入口", async () => {
  const app = await Bun.file("src-tauri/web/src/App.tsx").text();
  const api = await Bun.file("src-tauri/web/src/api.ts").text();
  const design = await Bun.file("src-tauri/web/src/workflow-design.tsx").text();
  expect(app).not.toContain("ChangesPanel");
  expect(app).not.toContain("changes-panel");
  expect(api).not.toContain("executions.review");
  expect(api).not.toContain("executions.fileDiff");
  expect(app).not.toContain("applyRetryResult");
  expect(app).not.toContain("setApplyRetryResult");
  expect(app).not.toContain("重新整理改动");
  expect(app).not.toContain("WorkspaceCleanupConfirmation");
  expect(app).not.toContain("api.cleanupWorkspaces");
  expect(api).not.toContain("executions.cleanupWorkspaces");
  expect(design).toContain("完成后改动保留在工作区，不会自动写入项目目录");
  expect(design).not.toContain("本次执行共用一个工作区");
  expect(design).not.toContain("自动应用到主工作区");
});

test("停滞提示是可选快照字段，只作低对比提示不改变状态", async () => {
  const types = await Bun.file("src-tauri/web/src/types.ts").text();
  const panel = await Bun.file("src-tauri/web/src/execution/team-panel.tsx").text();
  expect(types).toContain("hint?: string | null");
  expect(panel).toContain("{agent.hint && (");
  expect(panel).toContain('className="wf-agent-hint" role="status"');
  // 提示不参与状态推导。
  expect(panel).not.toContain("agent.hint && agent.status");
});

test("方案页用工作区说明改动保留范围", async () => {
  const design = await Bun.file("src-tauri/web/src/workflow-design.tsx").text();
  expect(design).toContain("完成后改动保留在工作区，不会自动写入项目目录");
  expect(design).not.toContain("自动应用");
  expect(design).not.toContain("重新整理改动");
});

test("工作区现场只展示路径、HEAD 与清理状态，不暴露写者计数", async () => {
  const app = await Bun.file("src-tauri/web/src/App.tsx").text();
  const types = await Bun.file("src-tauri/web/src/types.ts").text();
  expect(app).toContain("所有写节点共享同一 worktree");
  expect(app).toContain("受管 worktree 已清理");
  // 只有最近一次交接该 worktree 的 Execution 才能看到清理入口。
  expect(app).toContain("detail.workspaceEvidence.latestExecutionId ===");
  expect(types).toContain("latestExecutionId");
  expect(app).not.toContain("closedWriters");
  expect(app).not.toContain(".leases");
  expect(types).not.toContain("closedWriters");
  expect(types).not.toContain("leases");
});
