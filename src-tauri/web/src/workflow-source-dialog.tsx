import { createContext, useEffect, useRef, useState, type ReactNode } from "react";

/** 参数表单将保存操作放到弹窗固定底部；非弹窗表单缺省仍原地渲染。 */
export const WorkflowSourceActions = createContext<HTMLElement|null>(null);

/** 工作流来源共用弹窗；只管理阅读与焦点，不保存、检查或执行工作流。 */
export function WorkflowSourceDialog({ title, onClose, children }: {
  /** 可读弹窗标题。 */ title: string;
  /** 返回打开弹窗的页面；不删除已保存记录。 */ onClose: () => void;
  /** 来源选择/参数内容，保留各来源原事务。 */ children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const [actions,setActions]=useState<HTMLElement|null>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const prior = document.querySelector<HTMLElement>(`[data-workflow-source="${title === "预置工作流" ? "template" : "local"}"]`) ?? document.activeElement as HTMLElement | null;
    const background = [...document.querySelectorAll<HTMLElement>("main > section, main > aside")].filter(item => !item.contains(panel.current));
    const inert = background.map(item => item.inert);
    background.forEach(item => { item.inert = true; });
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key === "Tab") {
        const controls = [...panel.current?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]') ?? []].filter(item => item.getClientRects().length > 0);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      background.forEach((item, index) => { item.inert = inert[index]!; });
      requestAnimationFrame(() => { if (prior?.isConnected) prior.focus(); });
    };
  }, []);
  return <div className="connection-backdrop workflow-source-backdrop">
    <section ref={panel} role="dialog" aria-modal="true" aria-label={title} className="connection-panel workflow-source-dialog">
      <header><h2>{title}</h2><button type="button" className="source-dialog-close" aria-label={`关闭${title}`} onClick={onClose}>×</button></header>
      <WorkflowSourceActions.Provider value={actions}><div className="workflow-source-content">{children}</div></WorkflowSourceActions.Provider>
      <footer className="workflow-source-actions" ref={setActions}/>
    </section>
  </div>;
}
