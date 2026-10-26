import { useEffect, useRef, useState } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import { api } from "./api";
import type { GitFileDiff, GitReview } from "../../../src/workspace/git-repository";

/** 应用明暗主题；与 App.tsx 的 ColorTheme 保持一致。 */
type ColorTheme = "dark" | "light";

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

/** 文件清单每页条数；大 Execution 一次渲染全部条目不可用。 */
export const CHANGES_PAGE_SIZE = 200;

/** 总页数；空清单按一页计，避免显示“第 1 / 0 页”。 */
export function changesPageCount(total: number): number {
  return Math.max(1, Math.ceil(total / CHANGES_PAGE_SIZE));
}

/** 把页码收敛到合法范围；清单缩短后旧页码可能越界。 */
export function clampChangesPage(total: number, page: number): number {
  return Math.min(Math.max(0, page), changesPageCount(total) - 1);
}

/** 当前页的文件切片；页码越界时收敛到合法范围。 */
export function changesPageSlice<T>(paths: readonly T[], page: number): readonly T[] {
  const clamped = clampChangesPage(paths.length, page);
  return paths.slice(clamped * CHANGES_PAGE_SIZE, clamped * CHANGES_PAGE_SIZE + CHANGES_PAGE_SIZE);
}

/** 冻结改动的右侧只读审阅面板：左列文件清单，右侧按可用宽度选择并排或单列 diff。 */
export function ChangesPanel({ taskId, executionId, sourceTree, theme, onClose }: {
  /** 原Task身份，不从全局选择补取。 */ taskId: string;
  /** 原Execution身份。 */ executionId: string;
  /** 最终快照 tree 完整oid，变化后重置审阅。 */ sourceTree: string;
  /** 当前应用主题，驱动 diff 高亮配色。 */ theme: ColorTheme;
  /** 关闭面板；不改变任何业务状态。 */ onClose: () => void;
}) {
  const [review, setReview] = useState<GitReview | null>(null);
  const [diffs, setDiffs] = useState<Readonly<Record<string, GitFileDiff>>>({});
  const [selected, setSelected] = useState<string | null>(null);
  /** 文件清单当前页（0 基）；选中文件独立于页码，翻页不丢合法选择。 */
  const [page, setPage] = useState(0);
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
    setReview(null); setDiffs({}); setSelected(null); setPage(0); setError(null); setBusy(true);
    void api.reviewGit(taskId, executionId).then(value => {
      if (generation.current !== token) return;
      setReview(value);
      const first = value.paths[0] ?? null; setSelected(first);
      if (first) void load(first, value);
    }).catch(error => { if (generation.current === token) setError(String(error)); })
      .finally(() => { if (generation.current === token) setBusy(false); });
    return () => { generation.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, executionId, sourceTree]);

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
  const pageCount = changesPageCount(review?.paths.length ?? 0);
  const currentPage = review ? clampChangesPage(review.paths.length, page) : 0;
  const pagePaths = review ? changesPageSlice(review.paths, currentPage) : [];
  return <aside ref={panel} className="changes-panel" aria-label="变更" aria-busy={busy}>
    <header>
      <strong>变更{review ? ` · ${review.paths.length.toLocaleString()} 个文件` : ""}</strong>
      <button ref={closeButton} aria-label="关闭变更面板" onClick={onClose}>×</button>
    </header>
    {error && <p role="alert">{error}</p>}
    {!review && !error && <p role="status">正在读取改动…</p>}
    {review && <div className="changes-body">
      <div className="changes-files" role="listbox" aria-label="变更文件">
        {pagePaths.map(path => {
          const loaded = diffs[path]; const stats = loaded && !loaded.omitted ? patchStats(loaded.patch) : null;
          return <button key={path} role="option" aria-selected={selected === path} className={selected === path ? "active" : ""} onClick={() => { setSelected(path); if (!diffs[path]) void load(path); }}>
            <span className="changes-file-path">{path}</span>
            {stats && <small>+{stats.additions} −{stats.deletions}</small>}
          </button>;
        })}
        {pageCount > 1 && <div className="changes-pages">
          <button type="button" aria-label="上一页" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>‹</button>
          <span role="status">第 {currentPage + 1} / {pageCount} 页 · 共 {review.paths.length.toLocaleString()} 个文件</span>
          <button type="button" aria-label="下一页" disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)}>›</button>
        </div>}
      </div>
      <div className="changes-diff" ref={setDiffHost}>
        {selected && !currentDiff && !error && <p role="status">正在读取 {selected}…</p>}
        {currentDiff?.omitted && <p role="status">{currentDiff.reason === "binary" ? "二进制文件，无法内联显示" : "diff 超过 2MB，请在本地 Git 工具审阅"}</p>}
        {currentDiff && !currentDiff.omitted && <PatchDiff
          key={`${sourceTree}:${selected}`}
          patch={currentDiff.patch}
          disableWorkerPool
          options={{ diffStyle, themeType: theme, overflow: diffStyle === "unified" ? "wrap" : "scroll" }}
        />}
      </div>
    </div>}
    {review && <p className="changes-footer-note">只读审阅；改动保留在受管工作区，不会自动写入项目目录。</p>}
  </aside>;
}
