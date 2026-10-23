import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { cliDisplayName } from "./cli-meta";
import type { DiscoveredSkill, SkillDiscoverResult, SkillLibraryStatus, SkillSourceCli } from "./types";

/** 技能设置页：库状态、清单、从 CLI 导入与 ZIP 导入。 */
export function SkillsSettings() {
  const [status, setStatus] = useState<SkillLibraryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const closeAdd = useCallback(() => {
    setAddOpen(false);
    requestAnimationFrame(() => addButton.current?.focus());
  }, []);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await api.skillsStatus());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const openLibrary = useCallback(async () => {
    try {
      await api.skillsOpen();
      setError(null);
      window.dispatchEvent(new Event("wave-flow:skills-changed"));
      await loadStatus();
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [loadStatus]);

  return (
    <section className="settings-section skills-settings">
      <div className="section-row skills-head">
        <div>
          <strong>技能库</strong>
          <span>
            技能会在新任务中自动可用；正在运行的任务需要结束后重新打开。
            这里只管理技能文件，不会修改本地执行工具的配置。
          </span>
        </div>
        <div className="skills-head-actions">
          <button className="button-secondary" type="button" onClick={() => void openLibrary()}>
            打开目录
          </button>
          <button ref={addButton} className="button-primary" type="button" onClick={() => { setNotice(null); setAddOpen(true); }}>
            添加技能
          </button>
        </div>
      </div>

      {notice && <p className="skill-notice" role="status">{notice}</p>}
      {error && (
        <div className="manual-runtime-error" role="alert">
          <span>!</span>
          <div>
            <p>{error}</p>
            <button className="button-secondary" type="button" onClick={() => void loadStatus()} disabled={loading}>
              重新读取技能库
            </button>
          </div>
        </div>
      )}

      {loading && !status ? (
        <p className="skills-loading" role="status">正在读取技能库…</p>
      ) : status ? (
        <>
          <dl className="skills-meta">
            <dt>目录</dt>
            <dd><code>{status.root}</code></dd>
            <dt>技能数量</dt>
            <dd>{status.count}</dd>
            <dt>库摘要</dt>
            <dd><code>{status.digest ? status.digest.slice(0, 12) : "空库"}</code></dd>
            <dt>技能注入能力</dt>
            <dd className="skills-cli-list">
              {status.capabilities.map(item => (
                <span key={item.cli} className={`skill-capability ${item.injection}`}>
                  {item.displayName}
                  <em>{item.injection === "verified" ? "已验证" : "不支持"}</em>
                </span>
              ))}
              {status.unavailable.map(item => (
                <span key={item.cli} className="skill-capability unavailable" title={item.reason}>
                  {cliDisplayName(item.cli)}
                  <em>已暂停</em>
                </span>
              ))}
            </dd>
          </dl>
          <p className="skills-capability-note">“已验证”表示该工具支持 Wave Flow 的技能注入，不代表它已经安装或连接；实际可用工具请看执行工具设置。</p>

          {status.missingDependencies.length > 0 && (
            <div className="manual-runtime-error" role="alert">
              <span>!</span>
              <p>
                技能依赖未在当前 PATH 找到：{status.missingDependencies.join("、")}。
                skill 仍会注入，但对应工具调用可能失败；Wave Flow 不会自动安装依赖或修改 PATH。
              </p>
            </div>
          )}

          {status.invalid.length > 0 && (
            <div className="manual-runtime-error" role="alert">
              <span>!</span>
              <p>
                有 {status.invalid.length} 个 skill 未通过校验，已跳过且不会注入：
                {status.invalid.slice(0, 6).map(item => `${item.name}（${item.issue}）`).join("；")}
                {status.invalid.length > 6 ? `；另有 ${status.invalid.length - 6} 个` : ""}
              </p>
            </div>
          )}

          {status.skills.length === 0 ? (
            <div className="skills-empty">
              <strong>还没有技能</strong>
              <p>从一个已安装的 CLI 目录导入，或上传一个 skill.zip。</p>
              <button className="button-secondary" type="button" onClick={() => setAddOpen(true)}>
                添加第一个技能
              </button>
            </div>
          ) : (
            <div className="skills-grid">
              {status.skills.map(skill => (
                <article className="skill-card" key={skill.name}>
                  <div className="skill-card-head">
                    <strong>{skill.name}</strong>
                    <small>{skill.bytes} B</small>
                  </div>
                  <p>{skill.description || "未提供说明"}</p>
                  {skill.requiredBins.length > 0 && (
                    <small className={skill.missingBins.length > 0 ? "skill-deps missing" : "skill-deps"}>
                      依赖：{skill.requiredBins.join("、")}
                      {skill.missingBins.length > 0 ? `（缺少 ${skill.missingBins.join("、")}）` : ""}
                    </small>
                  )}
                </article>
              ))}
            </div>
          )}
        </>
      ) : null}

      {addOpen && (
        <AddSkillDialog
          onClose={closeAdd}
          onImported={async (message) => {
            closeAdd();
            setNotice(message);
            window.dispatchEvent(new Event("wave-flow:skills-changed"));
            await loadStatus();
          }}
        />
      )}
    </section>
  );
}

function AddSkillDialog({ onClose, onImported }: { readonly onClose: () => void; readonly onImported: (message: string) => Promise<void> }) {
  const [mode, setMode] = useState<"import" | "zip">("import");
  const [discover, setDiscover] = useState<SkillDiscoverResult | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | SkillSourceCli>("all");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [zipPath, setZipPath] = useState<string | null>(null);
  const [discoverAttempt, setDiscoverAttempt] = useState(0);
  const panel = useRef<HTMLElement>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;

  useEffect(() => {
    if (mode !== "import" || discover) return;
    let active = true;
    setDiscoverError(null);
    void api.skillsDiscover()
      .then(value => { if (active) setDiscover(value); })
      .catch(cause => { if (active) setDiscoverError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [mode, discover, discoverAttempt]);

  useEffect(() => {
    const focusables = () => panel.current
      ? [...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')]
        .filter(item => item.getClientRects().length > 0)
      : [];
    (panel.current?.querySelector<HTMLElement>(".skill-import-close") ?? focusables()[0])?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (busyRef.current) return;
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      const first = items[0], last = items.at(-1);
      if (!items.length) { event.preventDefault(); return; }
      if (!panel.current?.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown, true);
    return () => document.removeEventListener("keydown", keydown, true);
  }, [onClose]);

  const sources = discover?.sources.filter(source => source.exists) ?? [];
  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    return (discover?.skills ?? []).filter(skill =>
      (sourceFilter === "all" || skill.sourceCli === sourceFilter) &&
      (!text || `${skill.name} ${skill.description} ${skill.sourceLabel}`.toLowerCase().includes(text)));
  }, [discover, query, sourceFilter]);

  const selectable = (skill: DiscoveredSkill) => skill.valid && skill.installed === "none";
  // 选择跨来源保留：切换筛选后仍导入已勾选项，而不是只看当前筛选结果。
  const selectedSkills = (discover?.skills ?? []).filter(skill => selected.has(skill.path) && selectable(skill));

  const importSelected = async () => {
    if (selectedSkills.length === 0) return;
    setBusy(true); setActionError(null);
    const results = await Promise.allSettled(selectedSkills.map(skill => api.skillsImport(skill.path)));
    const failures = results.flatMap((result, index) => result.status === "rejected"
      ? [`${selectedSkills[index]!.name}：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
      : []);
    const imported = results.length - failures.length;
    if (imported > 0) await onImported(`已导入 ${imported} 个技能。${failures.length ? `失败 ${failures.length} 个：${failures.join("；")}` : ""}`);
    else setActionError(failures.join("；"));
    setBusy(false);
  };

  const pickZip = async () => {
    setActionError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ multiple: false, directory: false, filters: [{ name: "Skill ZIP", extensions: ["zip"] }] });
      if (typeof picked === "string") setZipPath(picked);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const importZip = async () => {
    if (!zipPath) return;
    setBusy(true); setActionError(null);
    try { const result = await api.skillsImportZip(zipPath); await onImported(`已导入技能 ${result.name}。`); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  return (
    <div className="skill-import-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section ref={panel} className="skill-import-panel" role="dialog" aria-modal="true" aria-label="添加技能">
        <header className="skill-import-head">
          <div>
            <strong>添加技能</strong>
            <p>从本机 CLI 导入，或上传一个 skill.zip。导入前会做与执行期相同的静态校验。</p>
          </div>
          <button className="skill-import-close" type="button" aria-label="关闭添加技能" onClick={onClose} disabled={busy}>×</button>
        </header>
        <div className="skill-import-tabs" role="tablist" aria-label="添加方式">
          <button role="tab" aria-selected={mode === "import"} className={mode === "import" ? "active" : ""} onClick={() => setMode("import")} disabled={busy}>从本机 CLI 导入</button>
          <button role="tab" aria-selected={mode === "zip"} className={mode === "zip" ? "active" : ""} onClick={() => setMode("zip")} disabled={busy}>上传 skill.zip</button>
        </div>

        {mode === "import" ? (
          <div className="skill-import-body">
            <div className="skill-source-chips" role="group" aria-label="按来源过滤">
              <button type="button" className={sourceFilter === "all" ? "active" : ""} onClick={() => setSourceFilter("all")}>全部</button>
              {sources.map(source => (
                <button key={source.cli} type="button" className={sourceFilter === source.cli ? "active" : ""} onClick={() => setSourceFilter(source.cli)}>
                  {source.label}
                </button>
              ))}
            </div>
            <input
              className="skill-import-search"
              type="search"
              value={query}
              placeholder="搜索 skill 名称、说明或来源"
              aria-label="搜索技能"
              onChange={event => setQuery(event.target.value)}
            />
            {discoverError ? (
              <div className="skill-import-empty" role="alert">
                <strong>暂时无法读取本机技能目录</strong>
                <p>{discoverError}</p>
                <button className="button-secondary" type="button" onClick={() => { setDiscover(null); setDiscoverError(null); setDiscoverAttempt(value => value + 1); }}>
                  重新扫描
                </button>
              </div>
            ) : !discover ? (
              <p className="skill-import-empty" role="status">正在扫描本机 CLI 技能目录…</p>
            ) : filtered.length === 0 ? (
              <div className="skill-import-empty">
                <strong>没有匹配的技能</strong>
                <p>换个关键词，或切换来源；也可以改用“上传 skill.zip”。</p>
              </div>
            ) : (
              <ul className="skill-import-list">
                {filtered.map(skill => {
                  const disabled = !selectable(skill);
                  return (
                    <li key={skill.path} className={disabled ? "disabled" : ""}>
                      <label>
                        <input
                          type="checkbox"
                          checked={selected.has(skill.path)}
                          disabled={disabled}
                          onChange={() => setSelected(prev => {
                            const next = new Set(prev);
                            if (next.has(skill.path)) next.delete(skill.path); else next.add(skill.path);
                            return next;
                          })}
                        />
                        <span>
                          <strong>{skill.name}</strong>
                          <small>{skill.description || skill.sourceLabel}</small>
                        </span>
                        <em>
                          {skill.installed === "same" ? "已安装·SKILL.md 相同" : skill.installed === "different" ? "同名不同内容" : skill.valid ? skill.sourceLabel : "校验失败"}
                        </em>
                      </label>
                      {!skill.valid && <p>{skill.issue}</p>}
                    </li>
                  );
                })}
              </ul>
            )}
            {actionError && <p className="skill-import-error" role="alert">{actionError}</p>}
            <footer className="skill-import-footer">
              <span>已选 {selectedSkills.length} 个</span>
              <div>
                <button className="button-secondary" type="button" onClick={onClose} disabled={busy}>取消</button>
                <button className="button-primary" type="button" onClick={() => void importSelected()} disabled={busy || selectedSkills.length === 0}>
                  {busy ? "正在导入…" : "导入所选"}
                </button>
              </div>
            </footer>
          </div>
        ) : (
          <div className="skill-import-body">
            <div className="skill-zip">
              <strong>选择一个 skill.zip</strong>
              <p>ZIP 内必须只有一个 skill：根目录含 SKILL.md，或恰好一个顶层目录含 SKILL.md；最大 50MiB。</p>
              <button className="button-secondary" type="button" onClick={() => void pickZip()} disabled={busy}>
                {zipPath ? "重新选择" : "选择 .zip 文件"}
              </button>
              {zipPath && <code>{zipPath}</code>}
            </div>
            {actionError && <p className="skill-import-error" role="alert">{actionError}</p>}
            <footer className="skill-import-footer">
              <span>导入前会校验 SKILL.md、frontmatter、软链与同名冲突。</span>
              <div>
                <button className="button-secondary" type="button" onClick={onClose} disabled={busy}>取消</button>
                <button className="button-primary" type="button" onClick={() => void importZip()} disabled={busy || !zipPath}>
                  {busy ? "正在导入…" : "校验并导入"}
                </button>
              </div>
            </footer>
          </div>
        )}
      </section>
    </div>
  );
}
