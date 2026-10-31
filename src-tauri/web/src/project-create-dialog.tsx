import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { droppedProjectPath } from "./project-navigation";

/** 仅登记现有本机目录；拖入/选择/关闭不创建Task或启动执行。 */
export function ProjectCreateDialog({ onClose, onCreated }: {
  /** 取消草稿并恢复原入口焦点；提交中不允许关闭。 */ onClose: () => void;
  /** Engine确认登记成功后回传原项目，重复目录仍使用原身份。 */ onCreated: (project: import("./types").LeadProject) => void;
}) {
  const [cwd, setCwd] = useState(""), [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [hover, setHover] = useState(false), [checking, setChecking] = useState(false);
  const panel = useRef<HTMLElement>(null), dropZone = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const alive = useRef(true), serial = useRef(0), submitting = useRef(false);
  const validating = useRef(false);
  const selecting = useRef(false);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    alive.current = true;
    const prior = document.activeElement as HTMLElement | null;
    const background = [...document.querySelectorAll<HTMLElement>("main > aside, main > section")].filter(el => !el.contains(panel.current));
    const original = background.map(el => el.inert); background.forEach(el => el.inert = true);
    input.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!submitting.current) close.current(); }
      if (event.key === "Tab") {
        const items = [...panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') ?? []].filter(item => item.getClientRects().length > 0);
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        else if (first && !panel.current?.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", key, true);
    return () => {
      alive.current = false; serial.current++;
      document.removeEventListener("keydown", key, true);
      background.forEach((el, i) => el.inert = original[i]!);
      requestAnimationFrame(() => { if (prior?.isConnected) prior.focus(); });
    };
  }, []);
  async function acceptPaths(paths: readonly string[]) {
    if (submitting.current || validating.current || selecting.current) return;
    const token = ++serial.current; validating.current = true; setChecking(true); setError(null);
    try {
      const path = droppedProjectPath(paths);
      // 新拖入/选择替换旧目录；核验失败不能让旧路径继续冒充这次选择。
      setCwd("");
      const value = await api.validateProjectPath(path);
      if (alive.current && serial.current === token) { setCwd(value.cwd); input.current?.focus(); }
    } catch (cause) { if (alive.current && serial.current === token) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (alive.current && serial.current === token) { validating.current = false; setChecking(false); } }
  }
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    const unlisten = getCurrentWindow().onDragDropEvent(event => {
      if (disposed || submitting.current || validating.current || selecting.current) return;
      const kind = event.payload.type;
      if (kind === "leave") { setHover(false); return; }
      // 弹窗是模态的，唯一拖放目标就是本区域，直接接受 drop。
      // 不按 position/devicePixelRatio 做命中判断：Tauri 在多显示器不同缩放时
      // 可能上报错误的物理坐标（tauri-apps/tauri#7890），会把有效拖入误判为区域外。
      setHover(kind !== "drop");
      if (kind === "drop") void acceptPaths(event.payload.paths);
    });
    void unlisten.catch(() => { if (!disposed) setError("文件夹拖入暂不可用，请输入路径或选择文件夹。"); });
    return () => { disposed = true; void unlisten.then(fn => fn()).catch(() => {}); };
  }, []);
  async function create() {
    if (submitting.current || validating.current || selecting.current || !cwd.trim()) return;
    submitting.current = true; serial.current++; setBusy(true); setHover(false); setError(null);
    try { const response = await api.createProject(cwd.trim(), title.trim()); if (alive.current) onCreated(response.project); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { submitting.current = false; if (alive.current) setBusy(false); }
  }
  return <div className="connection-backdrop" onClick={event => { if (event.target === event.currentTarget && !submitting.current) onClose(); }}>
    <section ref={panel} className="connection-panel project-create" role="dialog" aria-modal="true" aria-labelledby="project-create-title">
      <header className="connection-panel-head"><h2 id="project-create-title">创建项目</h2><button className="modal-close" disabled={busy} onClick={onClose} aria-label="关闭创建项目">×</button></header>
      <div className="connection-form project-fields">
        <label className="connection-field"><span>项目路径</span><input ref={input} value={cwd} disabled={busy} onChange={event => { serial.current++; validating.current = false; setChecking(false); setCwd(event.target.value); setError(null); }} placeholder="/绝对路径/项目文件夹" /></label>
        <div ref={dropZone} className={`project-folder-drop${hover ? " hovering" : ""}`}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5h6l2 2h10v12H3z" /></svg>
          <span role="status">{checking ? "正在检查文件夹…" : "拖入一个文件夹，或从本机选择"}</span>
          <button className="button-secondary" disabled={busy || checking} onClick={async () => {
            if (submitting.current || validating.current || selecting.current) return;
            selecting.current = true;
            const token = ++serial.current;
            try {
              const path = await open({ directory: true, multiple: false });
              selecting.current = false;
              if (alive.current && serial.current === token && typeof path === "string") await acceptPaths([path]);
            } catch (cause) { if (alive.current && serial.current === token) setError(String(cause)); }
            finally { selecting.current = false; }
          }}>选择文件夹</button>
        </div>
        <label className="connection-field"><span>显示名称 <i>可选</i></span><input value={title} disabled={busy} onChange={event => { setTitle(event.target.value); setError(null); }} placeholder="默认使用文件夹名" maxLength={120} /></label>
        {error && <p className="project-create-error" role="alert">{error}</p>}
      </div>
      <footer className="modal-actions"><button className="button-secondary" disabled={busy} onClick={onClose}>取消</button><button className="button-primary" disabled={busy || checking || !cwd.trim()} onClick={() => void create()}>{busy ? "正在创建…" : "创建项目"}</button></footer>
    </section>
  </div>;
}
