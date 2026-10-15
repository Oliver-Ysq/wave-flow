import { memo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

/**
 * 链接协议白名单：只允许 http/https/mailto，其余协议（javascript: 等）清空 href，
 * 交由下方的 a 渲染器退化为纯文本。
 */
function safeUrlTransform(url: string): string {
  if (/^(https?:|mailto:)/i.test(url)) return defaultUrlTransform(url);
  return "";
}

/**
 * 工作台唯一 Markdown 渲染入口：GFM（表格/列表/删除线）+ 代码块高亮。
 * 不启用 rehype-raw，原始 HTML 一律按文本处理；图片不加载远端资源，只显示 alt 占位。
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="wf-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        urlTransform={safeUrlTransform}
        components={{
          img: ({ alt }) => (
            <span className="wf-image-placeholder">
              [图片{alt ? `：${alt}` : ""}]
            </span>
          ),
          a: ({ href, children }) =>
            href ? (
              <a href={href} rel="noreferrer" target="_blank">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
