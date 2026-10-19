import { expect, test } from "bun:test";
import ts from "typescript";

/** 执行生产JSX回调而非匹配空格：模拟真实冒泡，验证加号不触发父级折叠。 */
function compile(source:string,context:Record<string,unknown>):any {
  const output=ts.transpileModule(`const element=(${source}); return element;`,{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022}}).outputText;
  return new Function("React",...Object.keys(context),output)({createElement:(type:any,props:any,...children:any[])=>({type,props:{...props,children}})},...Object.values(context));
}
function click(child:any,parent?:any){let stopped=false;child.props.onClick({stopPropagation(){stopped=true;}});if(!stopped)parent?.props.onClick();return stopped;}
test("项目分区加号打开创建但不折叠；名称行仍能折叠",async()=>{
  const app=await Bun.file("src-tauri/web/src/App.tsx").text();
  const source=app.slice(app.indexOf('<div className="projects-section-header"'),app.indexOf('<div className="task-section-title"'));
  let expanded=true,creates=0;
  const render=()=>compile(source,{projectsExpanded:expanded,setProjectsExpanded:(value:boolean)=>expanded=value,setCreatingProject:()=>creates++});
  for(let n=0;n<3;n++){const tree=render(),plus=tree.props.children[1];expect(click(plus,tree)).toBe(true);expect(expanded).toBe(true);}
  expect(creates).toBe(3);render().props.onClick();expect(expanded).toBe(false);
  const collapsed=render();click(collapsed.props.children[1],collapsed);expect(expanded).toBe(false);expect(creates).toBe(4);
});
test("项目新建会话加号确保本项目展开，连续点击不toggle",async()=>{
  const app=await Bun.file("src-tauri/web/src/App.tsx").text(),start=app.indexOf('<button\n            className="project-new-session"');
  const source=app.slice(start,app.indexOf('</button>',start)+9);let expanded=false,sessions=0;
  const tree=compile(source,{project:{title:"测试项目"},setExpanded:(value:boolean)=>expanded=value,onNewSession:()=>sessions++});
  for(let n=0;n<3;n++){expect(click(tree,{props:{onClick:()=>expanded=!expanded}})).toBe(true);expect(expanded).toBe(true);}
  expect(sessions).toBe(3);
});
