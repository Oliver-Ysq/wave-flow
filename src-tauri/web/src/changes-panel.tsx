import { useEffect, useRef, useState } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import { api } from "./api";
import type { GitFileDiff, GitReview } from "../../../src/workspace/git-repository";

/** 应用明暗主题；与 App.tsx 的 ColorTheme 保持一致。 */
type ColorTheme = "dark" | "light";

/** 自动应用结果；由Execution证据提供，不在面板内触发Git写入。 */
type AppliedState = { at: string; paths: string[] } | { skippedAt: string; reason: string };

/** 从 unified patch 统计增删行数，忽略 ---/+++ 文件头。 */
function patchStats(patch: string) {
  let additions = 0, deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

/** diff 列可用的最小像素宽度；面板最大 820px，扣除文件列与内边距后约 560px。 */
const SPLIT_DIFF_MIN_WIDTH = 540;

/** 按 diff 容器实际宽度选择并排或单列，避免窄面板里两列被横向裁切。 */
export function diffStyleForWidth(width: number): "split" | "unified" {
  return width >= SPLIT_DIFF_MIN_WIDTH ? "split" : "unified";
}

/** 自动应用结果页脚；拆成纯组件便于静态渲染回归测试。 */
export function ChangesFooter({ applied, hasPaths }: {
  /** 主工作区自动应用结果；缺省表示证据尚未就位。 */ applied?: AppliedState;
  /** 最终封存是否包含文件；为空时不显示收尾说明。 */ hasPaths: boolean;
}) {
  if (!applied && !hasPaths) return null;
  return <footer>
    {applied && "at" in applied && (
      <p role="status">已自动应用到主工作区（未提交、未推送）</p>
    )}
    {applied && "skippedAt" in applied && (
      <p role="alert">未自动应用：{applied.reason}</p>
    )}
    {!applied && hasPaths && (
      <small>改动已封存在受管 worktree 中；自动应用结果由执行页展示。</small>
    )}
    {applied && "skippedAt" in applied && (
      <small>处理主工作区后，可在执行页重新整理改动；不会重新执行 Workflow。</small>
    )}
  </footer>;
}

/** 冻结改动的右侧审阅面板：左列文件清单，右侧按可用宽度选择并排或单列 diff；自动应用结果只读展示。 */
export function ChangesPanel({ taskId, executionId, sourceCommit, applied, theme, onClose }: {
  /** 原Task身份，不从全局选择补取。 */ taskId: string;
  /** 原Execution身份。 */ executionId: string;
  /** 最终封存commit完整oid，变化后重置审阅。 */ sourceCommit: string;
  /** 主工作区自动应用结果；缺省表示尚未收尾。 */ applied?: AppliedState;
  /** 当前应用主题，驱动 diff 高亮配色。 */ theme: ColorTheme;
  /** 关闭面板；不改变任何业务状态。 */ onClose: () => void;
}) {
  const [review, setReview] = useState<GitReview | null>(null);
  const [diffs, setDiffs] = useState<Readonly<Record<string, GitFileDiff>>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  /** 只有 review 渲染后才存在 diff 容器；用回调 ref 持有它，挂载时立刻测量。 */
  const [diffHost, setDiffHost] = useState<HTMLDivElement | null>(null);
  /** 面板较窄时改用单列 diff，避免并排两列被横向裁切。 */
  const [diffStyle, setDiffStyle] = useState<"split" | "unified">("unified");

  useEffect(() => {
    if (!diffHost) return;
    const update = () => setDiffStyle(diffStyleForWidth(diffHost.clientWidth));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(diffHost);
    return () => observer.disconnect();
  }, [diffHost]);

  /** 面板从右侧展开后把焦点放到关闭按钮；关闭时还原到打开它的控件。 */
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    return () => {
      if (prior?.isConnected) prior.focus();
    };
  }, []);

  /** Tab 焦点必须留在面板内；面板是详情弹窗的侧栏，不允许 Tab 逃到背后的遮罩控件。 */
  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.isComposing) return;
      const items = [
        ...element.querySelectorAll<HTMLElement>(
          'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]',
        ),
      ].filter((item) => item.getClientRects().length > 0);
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const first = items[0]!, last = items[items.length - 1]!;
      if (!element.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => document.removeEventListener("keydown", keydown, true);
  }, []);

  useEffect(() => {
    const token = ++generation.current;
    setReview(null); setDiffs({}); setSelected(null); setError(null); setBusy(true);
    void api.reviewGit(taskId, executionId).then(value => {
      if (generation.current !== token) return;
      setReview(value);
      const first = value.paths[0] ?? null; setSelected(first);
      if (first) void load(first, value);
    }).catch(error => { if (generation.current === token) setError(String(error)); })
      .finally(() => { if (generation.current === token) setBusy(false); });
    return () => { generation.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, executionId, sourceCommit]);

  /** 按文件懒加载 patch；导航后丢弃迟到响应，已加载的保留在本地缓存。 */
  async function load(path: string, knownReview?: GitReview) {
    const currentReview = knownReview ?? review; if (!currentReview) return;
    const token = ++generation.current; setBusy(true); setError(null);
    try {
      const value = await api.fileDiff(taskId, executionId, path);
      if (generation.current === token) setDiffs(current => ({ ...current, [path]: value }));
    } catch (error) { if (generation.current === token) setError(String(error)); }
    finally { if (generation.current === token) setBusy(false); }
  }

  const currentDiff = selected ? diffs[selected] : undefined;
  return <aside ref={panel} className="changes-panel" aria-label="变更" aria-busy={busy}>
    <header>
      <strong>变更{review ? ` · ${review.paths.length.toLocaleString()} 个文件` : ""}</strong>
      <button ref={closeButton} aria-label="关闭变更面板" onClick={onClose}>×</button>
    </header>
    {error && <p role="alert">{error}</p>}
    {!review && !error && <p role="status">正在读取改动…</p>}
    {review && <div className="changes-body">
      <div className="changes-files" role="listbox" aria-label="变更文件">
        {review.paths.map(path => {
          const loaded = diffs[path]; const stats = loaded && !loaded.omitted ? patchStats(loaded.patch) : null;
          return <button key={path} role="option" aria-selected={selected === path} className={selected === path ? "active" : ""} onClick={() => { setSelected(path); if (!diffs[path]) void load(path); }}>
            <span className="changes-file-path">{path}</span>
            {stats && <small>+{stats.additions} −{stats.deletions}</small>}
          </button>;
        })}
      </div>
      <div className="changes-diff" ref={setDiffHost}>
        {selected && !currentDiff && !error && <p role="status">正在读取 {selected}…</p>}
        {currentDiff?.omitted && <p role="status">{currentDiff.reason === "binary" ? "二进制文件，无法内联显示" : "diff 超过 2MB，请在本地 Git 工具审阅"}</p>}
        {currentDiff && !currentDiff.omitted && <PatchDiff
          key={`${sourceCommit}:${selected}`}
          patch={currentDiff.patch}
          disableWorkerPool
          options={{ diffStyle, themeType: theme, overflow: diffStyle === "unified" ? "wrap" : "scroll" }}
        />}
      </div>
    </div>}
    {review && <ChangesFooter applied={applied} hasPaths={review.paths.length > 0} />}
  </aside>;
}
