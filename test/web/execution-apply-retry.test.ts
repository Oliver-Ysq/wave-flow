import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ChangesFooter,
  diffStyleForWidth,
} from "../../src-tauri/web/src/changes-panel";

test("diff 分栏阈值落在面板可达宽度内：宽 diff 列并排、窄列单列", () => {
  expect(diffStyleForWidth(300)).toBe("unified");
  expect(diffStyleForWidth(539)).toBe("unified");
  expect(diffStyleForWidth(540)).toBe("split");
  // 变更面板最大 820px，扣除 220px 文件列与 40px 内边距后仍应达到并排阈值。
  expect(diffStyleForWidth(820 - 220 - 40)).toBe("split");
});

test("变更面板在 review 渲染后测量 diff 宽度，并把 Tab 焦点留在面板内", async () => {
  const panel = await Bun.file("src-tauri/web/src/changes-panel.tsx").text();
  expect(panel).toContain("const [diffHost, setDiffHost] = useState<HTMLDivElement | null>(null)");
  expect(panel).toContain("ref={setDiffHost}");
  expect(panel).toContain("new ResizeObserver(update)");
  expect(panel).toContain("diffStyleForWidth(diffHost.clientWidth)");
  expect(panel).toContain('event.key !== "Tab"');
  expect(panel).toContain("document.addEventListener(\"keydown\", keydown, true)");
});

test("自动应用结果页脚：已应用/仍跳过/证据未到分别给出诚实文案", () => {
  const applied = renderToStaticMarkup(
    createElement(ChangesFooter, {
      applied: { at: "2026-10-21T00:00:00Z", paths: ["a.ts"] },
      hasPaths: true,
    }),
  );
  expect(applied).toContain("已自动应用到主工作区（未提交、未推送）");
  expect(applied).not.toContain("未自动应用");

  const skipped = renderToStaticMarkup(
    createElement(ChangesFooter, {
      applied: { skippedAt: "2026-10-21T00:00:00Z", reason: "主工作区有未提交改动" },
      hasPaths: true,
    }),
  );
  expect(skipped).toContain("未自动应用：主工作区有未提交改动");
  expect(skipped).toContain("可在执行页重新整理改动；不会重新执行 Workflow");

  const pending = renderToStaticMarkup(
    createElement(ChangesFooter, { hasPaths: true }),
  );
  // 面板只在 sourceEvidence 就绪后打开，不再承诺“执行完成后会自动应用”。
  expect(pending).not.toContain("执行完成后会自动应用");

  expect(
    renderToStaticMarkup(createElement(ChangesFooter, { hasPaths: false })),
  ).toBe("");
});

test("重新整理改动回读完整证据并内联反馈已应用/仍跳过", async () => {
  const app = await Bun.file("src-tauri/web/src/App.tsx").text();
  expect(app).toContain("await api.execution(owner, executionId).catch(() => ({");
  expect(app).toContain("...executionDetail,");
  expect(app).toContain("setApplyRetryResult");
  expect(app).toContain("已重新应用到主工作区（未提交、未推送）");
  expect(app).toContain("仍未应用：");
  expect(app).toContain("detail.sourceDiagnostic ??");
  expect(app).toContain("execution-apply-retry");
});

test("恢复受管 worktree 清理入口：确认弹窗后调用 Engine 并回读详情", async () => {
  const app = await Bun.file("src-tauri/web/src/App.tsx").text();
  const api = await Bun.file("src-tauri/web/src/api.ts").text();
  expect(api).toContain("executions.cleanupWorkspaces");
  expect(api).toContain("authorized:true");
  expect(app).toContain("function WorkspaceCleanupConfirmation");
  expect(app).toContain("<WorkspaceCleanupConfirmation");
  expect(app).toContain("api.cleanupWorkspaces(");
  expect(app).toContain("清理临时工作区");
  expect(app).toContain("!detail.workspaceEvidence.cleaned");
  // 只对最新终态且已有封存成果的 Execution 显示入口。
  expect(app).toContain("item.finishedAt !== null && item.config?.workspaces");
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

test("方案页说明主工作区脏时自动应用会被确定性跳过，并指向执行页重试", async () => {
  const design = await Bun.file("src-tauri/web/src/workflow-design.tsx").text();
  expect(design).toContain("首次自动应用会被确定性跳过");
  expect(design).toContain("请先提交或暂存这些改动");
  expect(design).toContain("重新整理改动");
  // 干净路径仍保留原来的自动应用承诺。
  expect(design).toContain("完成后自动应用到主工作区");
});

test("staleLeases 文案标明 worktree 累计，避免误读为本次 Execution 独占", async () => {
  const app = await Bun.file("src-tauri/web/src/App.tsx").text();
  expect(app).toContain("该受管 worktree 累计，含其他接续 Execution");
  expect(app).not.toContain("个重启前租约已在显式恢复时释放");
});
