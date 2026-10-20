import { useEffect, useRef, useState } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import { api } from "./api";
import type { GitFileDiff, GitMergeResult, GitReview } from "../../../src/workspace/git-repository";

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

/** 冻结改动的右侧审阅面板：左列文件清单，右列并排 diff；采用必须显式点击。 */
export function ChangesPanel({ taskId, executionId, sourceCommit, writable, theme, onClose }: {
  /** 原Task身份，不从全局选择补取。 */ taskId: string;
  /** 原Execution身份。 */ executionId: string;
  /** 已ready来源完整oid，变化后重置审阅。 */ sourceCommit: string;
  /** 最新未归档终态才允许采用。 */ writable: boolean;
  /** 当前应用主题，驱动 diff 高亮配色。 */ theme: ColorTheme;
  /** 关闭面板；不改变任何业务状态。 */ onClose: () => void;
}) {
  const [review, setReview] = useState<GitReview | null>(null);
  const [diffs, setDiffs] = useState<Readonly<Record<string, GitFileDiff>>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [merged, setMerged] = useState<GitMergeResult | null>(null);
  const generation = useRef(0), request = useRef<{ key: string; id: string } | null>(null);

  useEffect(() => {
    const token = ++generation.current;
    setReview(null); setDiffs({}); setSelected(null); setTarget(""); setError(null); setMerged(null); setBusy(true); request.current = null;
    void api.reviewGit(taskId, executionId).then(value => {
      if (generation.current !== token) return;
      setReview(value); setMerged(value.merged ?? null);
      setTarget(value.currentBranch && value.targets.some(item => item.branch === value.currentBranch) ? value.currentBranch : "");
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

  async function merge() {
    const selectedTarget = review?.targets.find(item => item.branch === target); if (!selectedTarget || !review) return;
    const token = ++generation.current, key = JSON.stringify({ taskId, executionId, sourceCommit, ...selectedTarget });
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    setBusy(true); setError(null);
    try {
      const value = await api.mergeGit(taskId, executionId, { requestId: request.current.id, sourceCommit: review.sourceCommit, targetBranch: selectedTarget.branch, targetHead: selectedTarget.head });
      if (generation.current === token) setMerged(value);
    } catch (error) { if (generation.current === token) setError(String(error)); }
    finally { if (generation.current === token) setBusy(false); }
  }

  const currentDiff = selected ? diffs[selected] : undefined;
  return <aside className="changes-panel" aria-label="变更" aria-busy={busy}>
    <header>
      <strong>变更{review ? ` · ${review.paths.length.toLocaleString()} 个文件` : ""}</strong>
      <button aria-label="关闭变更面板" onClick={onClose}>×</button>
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
      <div className="changes-diff">
        {selected && !currentDiff && !error && <p role="status">正在读取 {selected}…</p>}
        {currentDiff?.omitted && <p role="status">{currentDiff.reason === "binary" ? "二进制文件，无法内联显示" : "diff 超过 2MB，请在本地 Git 工具审阅"}</p>}
        {currentDiff && !currentDiff.omitted && <PatchDiff
          key={`${sourceCommit}:${selected}`}
          patch={currentDiff.patch}
          disableWorkerPool
          options={{ diffStyle: "split", themeType: theme, overflow: "scroll" }}
        />}
      </div>
    </div>}
    {review && <footer>
      {merged && <p role="status">已采用到 {merged.targetBranch}（未推送）</p>}
      {!merged && writable && <>
        {review.targets.length > 1
          ? <label>采用到<select disabled={busy} value={target} onChange={event => setTarget(event.target.value)}><option value="">选择分支</option>{review.targets.map(item => <option key={item.branch} value={item.branch}>{item.branch}</option>)}</select></label>
          : <span>采用到 {target || "当前分支"}</span>}
        <button className="changes-apply" disabled={busy || !target || !review.paths.length} onClick={() => void merge()}>采用这些改动</button>
        <small>将作为一次提交合入所选分支，不会推送。</small>
      </>}
      {!merged && !writable && <small>此记录只读；改动保留在已保存的成果中。</small>}
    </footer>}
  </aside>;
}
