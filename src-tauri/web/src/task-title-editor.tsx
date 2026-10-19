import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { normalizeTaskTitle } from "../../../src/shared/task-title";
import { SidebarHoverCard } from "./sidebar-hover-card";

/** 原位改名：双击/F2进入，Enter/失焦保存，Esc取消，归档只读。 */
export function TaskTitleEditor({title, readOnly, className, onSelect, onSave, children, hoverContent}: {
  /** 可选的只读悬浮详情；编辑时不渲染。 */ hoverContent?:ReactNode;
  /** 当前耐久名称；编辑期间不覆盖草稿。 */ title: string;
  /** 归档或无Task时true；运行中允许改名。 */ readOnly: boolean;
  /** 非编辑行样式。 */ className: string;
  /** 单击打开对话。 */ onSelect: () => void;
  /** 成功才结束编辑；失败不覆盖耐久名称。 */ onSave: (title: string) => Promise<void>;
  /** 原标题、状态与未读展示。 */ children: ReactNode;
}) {
  const [editing,setEditing]=useState(false),[draft,setDraft]=useState(title),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
  const input=useRef<HTMLInputElement>(null),button=useRef<HTMLButtonElement>(null),restoreFocus=useRef(false),saving=useRef(false),cancelled=useRef(false),errorId=useId();
  useEffect(()=>{if(editing){input.current?.focus();input.current?.select();}},[editing]);
  useEffect(()=>{if(!editing&&restoreFocus.current){restoreFocus.current=false;button.current?.focus();}},[editing]);
  useEffect(()=>{if(readOnly){cancelled.current=true;setEditing(false);}},[readOnly]);
  function begin(){if(readOnly||saving.current)return;cancelled.current=false;setDraft(title);setError(null);setEditing(true);}
  async function save(){
    if(saving.current||cancelled.current||readOnly)return;
    let value:string;
    try{value=normalizeTaskTitle(draft);}catch(cause){setError((cause as Error).message);return;}
    saving.current=true;setBusy(true);setError(null);
    try{await onSave(value);setEditing(false);}catch(cause){setError(String(cause));}finally{saving.current=false;setBusy(false);}
  }
  const row=<button ref={button} className={className} onClick={onSelect}
    onDoubleClick={event=>{event.preventDefault();event.stopPropagation();begin();}}
    onKeyDown={event=>{if(event.key==="F2"&&!readOnly){event.preventDefault();begin();}}}>{children}</button>;
  if(!editing)return hoverContent ? <SidebarHoverCard content={hoverContent}>{row}</SidebarHoverCard> : row;
  return <div className="task-title-edit" onClick={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()}>
    <input ref={input} aria-label="对话名称" aria-invalid={!!error} aria-describedby={error?errorId:undefined} value={draft} disabled={busy}
      onChange={event=>{setDraft(event.target.value);setError(null);}} onBlur={()=>{if(!saving.current)restoreFocus.current=false;void save();}} onKeyDown={event=>{
        event.stopPropagation();if(event.nativeEvent.isComposing)return;
        if(event.key==="Escape"){event.preventDefault();cancelled.current=true;restoreFocus.current=true;setEditing(false);}
        if(event.key==="Enter"){event.preventDefault();restoreFocus.current=true;void save();}
      }}/>
    {busy&&<small role="status">正在保存…</small>}
    {error&&<small id={errorId} role="alert">{error}</small>}
  </div>;
}
