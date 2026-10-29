import {useState,type ReactNode} from "react";
import {ViewCache} from "./workbench-state";

/** 会话内有界展开标记，不保存正文、源码或答案。 */
const expansions=new ViewCache<boolean>(256);

/** 原生键盘可达的折叠区，状态绑定完整页面/条目身份。 */
export function PersistedDetails({identity,defaultOpen=false,children,className}:{
  /** Task/card/revision 或 Execution/attempt/node 等原身份组合，不用标题猜测。 */
  identity:string;
  /** 首次渲染的展开状态；用户手动切换后仍按身份记忆。 */
  defaultOpen?:boolean;
  /** summary 与折叠正文。 */
  children:ReactNode;
  /** 可选展示类名，不参与身份。 */
  className?:string;
}){
  const [open,setOpen]=useState(()=>expansions.get(identity)??defaultOpen);
  return <details className={className} open={open} onToggle={event=>{const next=event.currentTarget.open;expansions.set(identity,next);setOpen(next);}}>{children}</details>;
}
