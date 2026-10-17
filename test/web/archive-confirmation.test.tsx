import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ArchiveImpactConfirmation } from "../../src-tauri/web/src/conversation/archive-confirmation";
import { editableRevision, singleChainCell } from "../../src-tauri/web/src/workbench-navigation";
import type { ArchivePreview, HarnessSnapshot, WorkflowRevision } from "../../src-tauri/web/src/types";

/** 覆盖三类待定项的完整归档预览。 */
const preview: ArchivePreview = {
  harnessRunId: "task-1",
  requiresAbandon: true,
  candidate: {
    revision: 3,
    cardId: "card-1",
    goal: "只读核验归档确认页",
    scope: "不改动业务文件",
    sourceHash: "hash-3",
    createdAt: "2026-10-16T08:00:00Z",
    origin: "local",
  },
  pendingSummaries: [
    { key: "s-1", executionId: "execution-aaaabbbbcccc", attempt: 1, status: "pending" },
    { key: "s-2", executionId: "execution-aaaabbbbcccc", attempt: 2, status: "running" },
    { key: "s-3", executionId: "execution-ddddeeeeffff", attempt: 1, status: "interrupted" },
  ],
  pendingDecisions: [
    { decisionId: "d-1", question: "是否继续补充影响面证据？", createdAt: "2026-10-16T08:30:00Z" },
  ],
};

test("归档确认页列出候选草案、未完成总结与未答决策三类待定项明细", () => {
  const html = renderToStaticMarkup(<ArchiveImpactConfirmation preview={preview} onClose={() => {}} onConfirm={async () => {}} />);
  expect(html).toContain("放弃待定项并归档？");
  expect(html).toContain("第 3 版");
  expect(html).toContain("只读核验归档确认页");
  expect(html).toContain("范围：不改动业务文件");
  expect(html).toContain("来源：本地文件");
  expect(html).toContain("未完成影响面总结（3 份）");
  expect(html).toContain("attempt #1");
  expect(html).toContain("准备中");
  expect(html).toContain("进行中");
  expect(html).toContain("已中断");
  expect(html).toContain("是否继续补充影响面证据？");
  expect(html).toContain("放弃待定项并归档");
  expect(html).toContain("返回处理");
  // 应用内模态约束：dialog 语义、Esc 关闭与焦点恢复沿用现有连接面板样式。
  expect(html).toContain('role="dialog"');
  expect(html).toContain('aria-modal="true"');
});

test("归档确认页只呈现实际存在的待定项类别，不补造空分组", () => {
  const onlyDecision: ArchivePreview = { harnessRunId: "task-1", requiresAbandon: true, candidate: null, pendingSummaries: [], pendingDecisions: preview.pendingDecisions };
  const html = renderToStaticMarkup(<ArchiveImpactConfirmation preview={onlyDecision} onClose={() => {}} onConfirm={async () => {}} />);
  expect(html).not.toContain("候选修订草案");
  expect(html).not.toContain("未完成影响面总结");
  expect(html).toContain("未回答的主控决策（1 项，将失效）");
});

test("未知来源或总结状态显示原始值，不补造成空白或错误文案", () => {
  const unknown: ArchivePreview = {
    harnessRunId: "task-1",
    requiresAbandon: true,
    candidate: { ...preview.candidate!, origin: "future-origin" as never },
    pendingSummaries: [{ key: "s-x", executionId: "execution-xxxxyyyyzzzz", attempt: 1, status: "future-state" as never }],
    pendingDecisions: [],
  };
  const html = renderToStaticMarkup(<ArchiveImpactConfirmation preview={unknown} onClose={() => {}} onConfirm={async () => {}} />);
  expect(html).toContain("来源：future-origin");
  expect(html).toContain("future-state");
  expect(html).not.toContain("undefined");
});

test("归档进行中无可用按钮时 Tab 必须保持焦点陷阱，不能逃逸到背景", async () => {
  const source = await Bun.file("src-tauri/web/src/conversation/archive-confirmation.tsx").text();
  const tabStart = source.indexOf('event.key === "Tab"');
  const tabSource = source.slice(tabStart, source.indexOf("first.focus()", tabStart));
  expect(tabSource).toContain("button:not(:disabled)");
  expect(tabSource).toContain("if (!buttons?.length) {");
  expect(tabSource).toContain("event.preventDefault();");
});

test("归档入口去重与决策问题行截断有实现锚点", async () => {
  const app = await Bun.file("src-tauri/web/src/App.tsx").text();
  expect(app).toContain("archiveEntryRef.current === id");
  expect(app).toContain("if (archiveEntryRef.current === id) return;");
  const modal = await Bun.file("src-tauri/web/src/conversation/archive-confirmation.tsx").text();
  expect(modal).toContain('className="archive-pending-list"');
  const css = await Bun.file("src-tauri/web/src/workbench.css").text();
  expect(css).toContain(".archive-pending-list li");
  expect(css).toContain("-webkit-line-clamp:2");
});

test("单链子项与多卡分支共享 Worker 待答提示", async () => {
  const app = await Bun.file("src-tauri/web/src/App.tsx").text();
  expect(app).toContain("singleAttention");
  const singleStart = app.indexOf("singleCell ?");
  const singleSource = app.slice(singleStart, app.indexOf("workflowCells(item).map", singleStart));
  expect(singleSource).toContain("需要回答 · ${singleAttention.workerRequests} 个 Worker / ${singleAttention.scriptGates} 个确认");
});

test("归档确认页不直接调用任何 API：返回处理与确认参数完全由回调决定", async () => {
  const source = await Bun.file("src-tauri/web/src/conversation/archive-confirmation.tsx").text();
  expect(source).not.toContain("from \"../api\"");
  expect(source).not.toContain("api.");
  // 返回处理只是关闭回调；主操作通过 onConfirm Promise 反馈归档中/失败状态。
  expect(source).toContain("onClose()");
  expect(source).toContain("await onConfirm()");
  expect(source).toContain("正在归档…");
});

test("前端归档契约迁移到 archivePreview + abandonPending，不再保留旧封装", async () => {
  const api = await Bun.file("src-tauri/web/src/api.ts").text();
  expect(api).toContain('"harnesses.archivePreview"');
  expect(api).toContain("abandonPending:true");
  expect(api).not.toContain("abandonImpactSummaries");
  expect(api).not.toContain("archiveAbandoningSummaries");
  const app = await Bun.file("src-tauri/web/src/App.tsx").text();
  expect(app).toContain("api.archivePreview");
  expect(app).toContain("preview.requiresAbandon");
  expect(app).toContain("api.archiveAbandoningPending");
  expect(app).not.toContain("archiveAbandoningSummaries");
});

test("已归档任务只读：草案不可编辑，执行控制与答题入口隐藏", async () => {
  const revision: WorkflowRevision = { revision: 1, cardId: "card", source: "", sourceHash: "x", createdAt: "", acceptedAt: null };
  const archived = { task: { title: "固定" }, status: "completed", workflowRevisions: [revision], executions: [] } as unknown as HarnessSnapshot;
  expect(editableRevision(archived, revision)).toBe(false);
  const app = await Bun.file("src-tauri/web/src/App.tsx").text();
  expect(app).toContain('archived={harness.status==="completed"}');
  expect(app).toContain("任务已归档；执行记录只读，不能恢复或控制。");
  const card = await Bun.file("src-tauri/web/src/conversation/revision-card.tsx").text();
  expect(card).toContain("任务已归档；方案与参数只读");
  // 输入区与归档按钮在已完成任务上本就不渲染（conversation-view 现有分支）。
  const view = await Bun.file("src-tauri/web/src/conversation/conversation-view.tsx").text();
  expect(view).toContain('harness.status !== "completed"');
});

test("单链导航分支只影响 single-workflow-v1 任务，旧任务保持多卡列表", () => {
  const revision = (n: number): WorkflowRevision => ({ revision: n, cardId: "card", source: "", sourceHash: "x", createdAt: "", acceptedAt: null });
  const single = { task: { title: "单链", workflowContract: "single-workflow-v1" }, workflowRevisions: [revision(1), revision(2)], executions: [] } as unknown as HarnessSnapshot;
  expect(singleChainCell(single)?.revision).toBe(2);
  const legacy = { task: { title: "旧多卡" }, workflowRevisions: [revision(1), revision(2)], executions: [] } as unknown as HarnessSnapshot;
  expect(singleChainCell(legacy)).toBeNull();
  const empty = { task: { title: "空", workflowContract: "single-workflow-v1" }, workflowRevisions: [], executions: [] } as unknown as HarnessSnapshot;
  expect(singleChainCell(empty)).toBeNull();
});

test("单链子项进入最新 revision 的中央方案视图，且只在侧栏分支生效", async () => {
  const app = await Bun.file("src-tauri/web/src/App.tsx").text();
  expect(app).toContain("singleChainCell(item)");
  // 单链子项显式打开 plan 页签；版本/Execution/attempt 仍在中央区域内选择。
  expect(app).toContain('onWorkflow(singleCell,"plan")');
  // 旧多卡分支仍按 cardId 逐卡渲染，不受单链分支影响。
  expect(app).toContain("workflowCells(item).map");
});
