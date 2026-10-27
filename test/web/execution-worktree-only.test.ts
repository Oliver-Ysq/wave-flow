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

test("closedWriters 文案标明 worktree 累计与核验语义，避免误读为本次 Execution 独占", async () => {
  const app = await Bun.file("src-tauri/web/src/App.tsx").text();
  expect(app).toContain("该受管 worktree 累计，含其他接续 Execution");
  expect(app).toContain("已在恢复前完成核验（终止 / 已退出 / 从未启动）");
  expect(app).not.toContain("个重启前租约已在显式恢复时释放");
  expect(app).not.toContain("staleLeases");
});
