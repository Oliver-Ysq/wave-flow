import { useEffect, useRef, useState } from "react";
import type { ArchivePreview } from "../types";

/** 待定总结状态的中文展示；与后端 ArchivePreviewSummary.status 一一对应。 */
const summaryStatusLabel = (status: ArchivePreview["pendingSummaries"][number]["status"]) =>
  ({ pending: "准备中", running: "进行中", interrupted: "已中断" })[status];
/** 候选草案来源的中文展示；历史缺省按 generated（主控生成）。 */
const candidateOriginLabel = (origin: "template" | "local" | "generated") =>
  ({ template: "预置模板", local: "本地文件", generated: "主控生成" })[origin];

/**
 * 归档确认页：列出归档前全部待定项（候选草案、未完成影响面总结、未答主控决策），
 * 主操作“放弃待定项并归档”，次操作“返回处理”。应用内模态，Esc 关闭、Tab 焦点循环、
 * 关闭后焦点回到归档按钮；本组件不直接调用任何 API，确认/取消语义全由回调决定。
 */
export function ArchiveImpactConfirmation({
  preview,
  onClose,
  onConfirm,
}: {
  /** 归档预览的全部待定项；调用方保证 requiresAbandon 为 true 才打开本页。 */
  preview: ArchivePreview;
  /** 返回处理；与 Esc、点击遮罩同义，不触发任何写动作。 */
  onClose: () => void;
  /** 明确放弃待定项并归档；resolve 表示后端已封存，reject 保持模态并展示错误。 */
  onConfirm: () => Promise<void>;
}) {
  const dialog = useRef<HTMLElement | null>(null);
  /** 归档进行中禁用两个操作；失败错误留在模态内，不假装已归档。 */
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const previous =
      document.querySelector<HTMLButtonElement>("[data-archive-task]") ??
      (document.activeElement as HTMLElement | null);
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };
  return (
    <div
      className="connection-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="archive-impact-title"
        className="connection-panel"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            if (!busy) onClose();
          }
          if (event.key === "Tab") {
            const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
            if (!buttons?.length) return;
            const first = buttons[0],
              last = buttons[buttons.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div className="connection-panel-head">
          <h2 id="archive-impact-title">放弃待定项并归档？</h2>
        </div>
        <div className="connection-form">
          <p>
            归档后任务只读，不能再发消息、批准方案、启动或恢复执行；未完成影响会保留在历史中。
          </p>
          {preview.candidate && (
            <section aria-label="候选修订草案">
              <h3>候选修订草案（将被放弃）</h3>
              <ul>
                <li>
                  第 {preview.candidate.revision} 版 ·{" "}
                  {preview.candidate.goal ?? "未保存独立目标"}
                  {preview.candidate.scope
                    ? ` · 范围：${preview.candidate.scope}`
                    : ""}{" "}
                  · 来源：{candidateOriginLabel(preview.candidate.origin)}
                </li>
              </ul>
            </section>
          )}
          {preview.pendingSummaries.length > 0 && (
            <section aria-label="未完成影响面总结">
              <h3>未完成影响面总结（{preview.pendingSummaries.length} 份）</h3>
              <ul>
                {preview.pendingSummaries.map((item) => (
                  <li key={item.key}>
                    执行 {item.executionId.slice(0, 12)} · attempt #{item.attempt} ·{" "}
                    {summaryStatusLabel(item.status)}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {preview.pendingDecisions.length > 0 && (
            <section aria-label="未回答的主控决策">
              <h3>未回答的主控决策（{preview.pendingDecisions.length} 项，将失效）</h3>
              <ul>
                {preview.pendingDecisions.map((item) => (
                  <li key={item.decisionId}>{item.question}</li>
                ))}
              </ul>
            </section>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
        <div className="modal-actions">
          <button disabled={busy} onClick={onClose}>
            返回处理
          </button>
          <button className="danger" disabled={busy} onClick={() => void confirm()}>
            {busy ? "正在归档…" : "放弃待定项并归档"}
          </button>
        </div>
      </section>
    </div>
  );
}
