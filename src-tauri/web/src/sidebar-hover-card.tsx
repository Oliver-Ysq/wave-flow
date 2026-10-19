import {useEffect,useId,useRef,useState,type ReactNode} from "react";
import {createPortal} from "react-dom";

/** 固定定位只读提示卡的位置；右侧优先，窗口边缘夹紧，不依赖侧栏overflow。 */
export function hoverCardPosition(anchor:{right:number;left:number;top:number},size:{width:number;height:number},viewport:{width:number;height:number}) {
  const gap=8,margin=8;
  return {left:Math.max(margin,Math.min(anchor.right+gap,viewport.width-size.width-margin)),top:Math.max(margin,Math.min(anchor.top,viewport.height-size.height-margin))};
}
/** 包裹行而不增加按钮；hover/焦点可读，Esc关闭，移入卡片不消失。 */
export function SidebarHoverCard({children,content,disabled=false}:{
  /** 原位编辑或其他不适用状态时隐藏。 */ disabled?:boolean;
  /** 原行控制，不改变点击语义。 */ children:ReactNode;
  /** 只读完整名称、项目和元信息。 */ content:ReactNode;
}) {
  const [open,setOpen]=useState(false),[position,setPosition]=useState({left:0,top:0});
  const anchor=useRef<HTMLDivElement>(null),card=useRef<HTMLDivElement>(null),timer=useRef<ReturnType<typeof setTimeout>|null>(null),id=useId();
  const clear=()=>{if(timer.current)clearTimeout(timer.current);timer.current=null;};
  const show=()=>{clear();if(!disabled)timer.current=setTimeout(()=>setOpen(true),250);};
  const hide=()=>{clear();timer.current=setTimeout(()=>setOpen(false),150);};
  useEffect(()=>()=>clear(),[]);
  useEffect(()=>{if(disabled){clear();setOpen(false);}},[disabled]);
  useEffect(()=>{
    if(!open)return;
    const place=()=>{if(!anchor.current||!card.current)return;const box=anchor.current.getBoundingClientRect(),size=card.current.getBoundingClientRect();setPosition(hoverCardPosition(box,size,{width:window.innerWidth,height:window.innerHeight}));};
    place();
    const close=()=>{clear();setOpen(false);};
    const key=(event:KeyboardEvent)=>{if(event.key==="Escape"){event.stopPropagation();close();}};
    window.addEventListener("resize",close);window.addEventListener("scroll",close,true);document.addEventListener("keydown",key,true);
    return()=>{window.removeEventListener("resize",close);window.removeEventListener("scroll",close,true);document.removeEventListener("keydown",key,true);};
  },[open]);
  return <div ref={anchor} className="sidebar-hover-anchor" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} aria-describedby={open?id:undefined}>
    {children}
    {open&&!disabled&&createPortal(<div ref={card} id={id} role="tooltip" className="sidebar-hover-card" style={position} onMouseEnter={clear} onMouseLeave={hide}>{content}</div>,document.body)}
  </div>;
}
