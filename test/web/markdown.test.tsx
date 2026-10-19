import {expect,test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {MarkdownRenderer} from "../../src-tauri/web/src/conversation/markdown-renderer";
import {createSharedRendererLoader,rendererRequestUrl} from "../../src-tauri/web/src/conversation/renderer-loader";
test("正文不做产品角色替换，代码与链接地址保持原文",async()=>{
 const text='主控设计说明\n\n`主控配置.json`\n\n```text\n主控配置.json\n```\n\n[配置](https://example.com/主控配置)';
 const html=renderToStaticMarkup(<MarkdownRenderer text={text}/>);
 expect(html).toContain('主控设计说明');
 expect(html).toContain('主控配置.json');
 expect(html).toContain(`https://example.com/${encodeURIComponent('主控配置')}`);
 const loader=await Bun.file('src-tauri/web/src/conversation/markdown.tsx').text();
 expect(loader).not.toContain('userFacingText');
});
test("完整渲染保留GFM表格和多语言高亮，链接图片安全边界不改变",()=>{
 const html=renderToStaticMarkup(<MarkdownRenderer text={'| 名称 | 值 |\n| --- | --- |\n| a | 1 |\n\n```typescript\nconst x: number = 1;\n```\n\n```swift\nlet x = 1\n```\n\n![图片](https://example.com/a.png)\n\n[安全](https://example.com) [危险](javascript:alert%281%29)\n\n<script>alert(1)</script>'}/>);
 expect(html).toContain("<table>");expect(html).toContain("hljs-keyword");expect(html).toContain("language-swift");expect(html).toContain('href="https://example.com"');expect(html).not.toContain('href="javascript:');expect(html).not.toContain("<img");expect(html).not.toContain("<script>");
});
test("模块失败重试生成新地址，并发与成功不增加attempt",async()=>{
 const attempts:number[]=[];const load=createSharedRendererLoader(async attempt=>{attempts.push(attempt);if(attempt===0)throw Error("503");return "ok";});
 await expect(load()).rejects.toThrow("503");await Promise.all([load(),load()]);await load();expect(attempts).toEqual([0,1]);
 expect(rendererRequestUrl("/assets/body.js",0)).toBe("/assets/body.js?wf-render-attempt=0");expect(rendererRequestUrl("/assets/body.js",1)).not.toBe(rendererRequestUrl("/assets/body.js",0));
});
test("渲染器加载并发去重、成功缓存，失败可显式重试",async()=>{
 let calls=0;const load=createSharedRendererLoader(async()=>{calls++;if(calls===1)throw Error("加载失败");return "renderer";});
 const first=load();expect(load()).toBe(first);await expect(first).rejects.toThrow("加载失败");
 expect(calls).toBe(1);const retry=load();expect(load()).toBe(retry);expect(await retry).toBe("renderer");expect(await load()).toBe("renderer");expect(calls).toBe(2);
});
