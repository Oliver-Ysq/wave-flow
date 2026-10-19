import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskTitleEditor } from "../../src-tauri/web/src/task-title-editor";
test("标题行支持键盘入口与归档只读，创建入口移除",async()=>{
  const html=renderToStaticMarkup(<TaskTitleEditor title="标题" readOnly={false} className="row" onSelect={()=>{}} onSave={async()=>{}}>标题</TaskTitleEditor>);
  expect(html).toContain("标题");expect(html).not.toContain("<input");
  const readonly=renderToStaticMarkup(<TaskTitleEditor title="归档" readOnly className="row" onSelect={()=>{}} onSave={async()=>{}}>归档</TaskTitleEditor>);
  expect(readonly).not.toContain("F2");
  const app=await Bun.file("src-tauri/web/src/App.tsx").text();expect(app).not.toContain("setTaskTitle");expect(app).not.toContain("任务标题（可选）");
});
