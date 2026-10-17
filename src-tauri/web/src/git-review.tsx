import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { GitFileDiff, GitMergeResult, GitReview } from "../../../src/workspace/git-repository";

/** 冻结成果审阅；按文件加载，导航后丢弃迟到响应，合入必须显式点击。 */
export function GitReviewPanel({ taskId, executionId, sourceCommit, writable }: {
  /** 原Task身份，不从全局选择补取。 */ taskId: string;
  /** 原Execution身份。 */ executionId: string;
  /** 已ready来源完整oid，变化后重置审阅。 */ sourceCommit: string;
  /** 最新未归档终态才允许合入。 */ writable: boolean;
}) {
  const [review, setReview] = useState<GitReview | null>(null), [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [target, setTarget] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [merged, setMerged] = useState<GitMergeResult | null>(null);
  const generation = useRef(0), request = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => {
    const token = ++generation.current;
    setReview(null); setDiff(null); setTarget(""); setError(null); setMerged(null); setBusy(true); request.current = null;
    void api.reviewGit(taskId, executionId).then(value => { if (generation.current === token) {setReview(value);setMerged(value.merged??null);} }).catch(error => { if (generation.current === token) setError(String(error)); }).finally(() => { if (generation.current === token) setBusy(false); });
    return () => { generation.current++; };
  }, [taskId, executionId, sourceCommit]);
  async function load(path: string) {
    const token = ++generation.current; setBusy(true); setError(null); setDiff(null);
    try { const value = await api.fileDiff(taskId, executionId, path); if (generation.current === token) setDiff(value); }
    catch (error) { if (generation.current === token) setError(String(error)); }
    finally { if (generation.current === token) setBusy(false); }
  }
  async function merge() {
    const selected = review?.targets.find(item => item.branch === target); if (!selected || !review) return;
    const token = ++generation.current, key = JSON.stringify({ taskId, executionId, sourceCommit, ...selected });
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    setBusy(true); setError(null);
    try { const value = await api.mergeGit(taskId, executionId, { requestId: request.current.id, sourceCommit: review.sourceCommit, targetBranch: selected.branch, targetHead: selected.head }); if (generation.current === token) setMerged(value); }
    catch (error) { if (generation.current === token) setError(String(error)); }
    finally { if (generation.current === token) setBusy(false); }
  }
  return <section className="execution-workspace-evidence" aria-label="Git 成果审阅" aria-busy={busy}><h3>成果 diff 与合入</h3>
    <p>对比冻结基准与已保存成果。Git 不覆盖工作区外影响；二进制及过大文件需在本地审阅。</p>
    {busy && <p role="status">正在读取或处理 Git…</p>}{error && <p role="alert">{error}</p>}
    {review && <><p>{review.paths.length.toLocaleString()} 个变化文件 · 来源 {review.sourceCommit.slice(0,12)}</p>
      <label>查看文件<select disabled={busy} value={diff?.path ?? ""} onChange={event => { if (event.target.value) void load(event.target.value); }}><option value="">选择文件查看 diff</option>{review.paths.map(path => <option key={path} value={path}>{path}</option>)}</select></label>
      {diff && <article><h4>{diff.path}</h4>{diff.omitted ? <p role="status">{diff.reason === "binary" ? "二进制文件，无法内联显示" : "diff 超过 2MB，请在本地 Git 工具审阅"}</p> : <pre style={{ overflowX:"auto",maxHeight:"32rem" }}><code>{diff.patch}</code></pre>}</article>}
      {writable && !merged && <><label>目标本机分支<select disabled={busy} value={target} onChange={event => setTarget(event.target.value)}><option value="">选择目标分支</option>{review.targets.map(item => <option key={item.branch} value={item.branch}>{item.branch} · {item.head.slice(0,12)}</option>)}</select></label><p>点击即将以上完整成果 squash 合入所选分支。不自动 push；目标已前进或存在未提交内容时拒绝。</p><button disabled={busy || !target || !review.paths.length} onClick={() => void merge()}>确认 squash 合入 {target || "目标分支"}</button></>}
      {merged && <p role="status">已合入 {merged.targetBranch} · {merged.commit.slice(0,12)}，未 push。</p>}
    </>}
  </section>;
}
