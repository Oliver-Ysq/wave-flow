import { memo,useEffect,useState,type ComponentType } from "react";
import {createSharedRendererLoader,rendererRequestUrl} from "./renderer-loader";
import rendererUrl from "virtual:markdown-renderer-url";
const loadRenderer=createSharedRendererLoader(attempt=>import(/* @vite-ignore */ rendererRequestUrl(rendererUrl,attempt)).then(module=>module.MarkdownRenderer));

/** 按需加载完整Markdown能力；等待/失败保留正文，失败仅显式重试，不影响Engine或草稿。 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const [Renderer,setRenderer]=useState<ComponentType<{text:string}>|null>(null);
  const [failed,setFailed]=useState(false),[attempt,setAttempt]=useState(0);
  useEffect(()=>{let live=true;setFailed(false);void loadRenderer().then(renderer=>{if(live)setRenderer(()=>renderer);}).catch(()=>{if(live)setFailed(true);});return()=>{live=false;};},[attempt]);
  if(Renderer)return <Renderer text={text}/>;
  return <div className="wf-markdown"><div style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{text}</div>{failed?<><small role="status">正文格式加载失败，内容已保留。</small><button type="button" onClick={()=>setAttempt(value=>value+1)}>重新加载正文格式</button></>:<small role="status">正在加载正文格式…</small>}</div>;
});
