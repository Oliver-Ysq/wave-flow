import {expect,test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {hoverCardPosition,SidebarHoverCard} from "../../src-tauri/web/src/sidebar-hover-card";
test("提示卡夹紧窗口边缘，侧栏overflow不决定坐标",()=>{
  expect(hoverCardPosition({right:260,left:9,top:300},{width:340,height:140},{width:1280,height:860})).toEqual({left:268,top:300});
  expect(hoverCardPosition({right:680,left:420,top:850},{width:340,height:140},{width:700,height:860})).toEqual({left:352,top:712});
  expect(hoverCardPosition({right:100,left:0,top:-20},{width:340,height:140},{width:360,height:200})).toEqual({left:12,top:8});
});
test("提示默认隐藏，四种侧栏行共用尺寸与高亮，元信息不常驻",async()=>{
  const html=renderToStaticMarkup(<SidebarHoverCard content={<strong>完整信息</strong>}><button>标题</button></SidebarHoverCard>);
  expect(html).not.toContain("完整信息");expect(html).toContain("标题");
  const css=await Bun.file("src-tauri/web/src/workbench.css").text();
  expect(css).toContain("--wf-sidebar-row-height:40px");expect(css).toContain("--wf-sidebar-row-highlight:var(--wf-panel-raised)");expect(css).toContain("height:var(--wf-sidebar-row-height)!important");
  const app=await Bun.file("src-tauri/web/src/App.tsx").text(),row=app.slice(app.indexOf("function HarnessListItem("),app.indexOf("function TaskTreeItem("));
  expect(row).toContain("hoverContent=");expect(row.slice(row.indexOf('className="sidebar-title-line"'))).not.toContain("<small>");
});
