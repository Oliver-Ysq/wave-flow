import {memo} from "react";
import ReactMarkdown,{defaultUrlTransform} from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
/** 仅允许http/https/mailto；其他链接退化文本，原始HTML不执行、图片不请求远端。 */
function safeUrlTransform(url:string):string{return /^(https?:|mailto:)/i.test(url)?defaultUrlTransform(url):"";}
/** 完整GFM与默认代码高亮能力，单独分块但不削减原有语言支持。 */
export const MarkdownRenderer=memo(function MarkdownRenderer({text}:{text:string}){
 return <div className="wf-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} urlTransform={safeUrlTransform} components={{img:({alt})=><span className="wf-image-placeholder">[图片{alt?`：${alt}`:""}]</span>,a:({href,children})=>href?<a href={href} rel="noreferrer" target="_blank">{children}</a>:<span>{children}</span>}}>{text}</ReactMarkdown></div>;
});
