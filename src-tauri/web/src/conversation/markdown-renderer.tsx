import {memo,type ComponentProps} from "react";
import ReactMarkdown,{defaultUrlTransform} from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
/** 仅允许http/https/mailto；其他链接退化文本，原始HTML不执行、图片不请求远端。 */
function safeUrlTransform(url:string):string{return /^(https?:|mailto:)/i.test(url)?defaultUrlTransform(url):"";}
/** 完整GFM与默认代码高亮能力，单独分块但不削减原有语言支持。 */
export const MarkdownRenderer=memo(function MarkdownRenderer({text}:{text:string}){
 // 超过 28 字符的行内代码（哈希、长 ID）额外允许任意断行，避免在正文里撑成一条高亮横条；
 // 代码块不受影响（样式只作用于 :not(pre) > code）。
 const code=({children,className,node:_node,...props}:ComponentProps<"code"> & {node?:unknown})=>{
  const raw=typeof children==="string"?children:Array.isArray(children)?children.join(""):"";
  return <code className={[className,raw.length>28?"wf-code-long":""].filter(Boolean).join(" ")||undefined} {...props}>{children}</code>;
 };
 return <div className="wf-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} urlTransform={safeUrlTransform} components={{code,img:({alt})=><span className="wf-image-placeholder">[图片{alt?`：${alt}`:""}]</span>,a:({href,children})=>href?<a href={href} rel="noreferrer" target="_blank">{children}</a>:<span>{children}</span>}}>{text}</ReactMarkdown></div>;
});
