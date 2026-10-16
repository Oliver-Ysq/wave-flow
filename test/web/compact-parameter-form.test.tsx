import {expect,test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {CompactParameterForm} from "../../src-tauri/web/src/forms/compact-parameter-form";
import {validateAnswer} from "../../src-tauri/web/src/forms/schema-support";
test("普通参数错误使用中文，不泄露AJV英文或类型树",()=>{
 const errors=validateAnswer({type:"object",properties:{target:{type:"string",minLength:1},maxFindings:{type:"integer",minimum:1,maximum:30},focus:{type:"array",minItems:1}},required:["target"]},{target:"",maxFindings:31,focus:[]});
 expect(errors.map(item=>item.message)).toContain("请填写内容");expect(errors.map(item=>item.message)).toContain("不能大于 30");expect(errors.map(item=>item.message)).toContain("至少填写 1 项");
});
test("紧凑参数中文标签、可选折叠、不显示类型树和JSON入口",()=>{
 const html=renderToStaticMarkup(<CompactParameterForm schema={{type:"object",required:["target"],properties:{target:{type:"string"},context:{type:["string","null"]}}}} initialValue={{target:"src/"}} onSubmit={async()=>{}}/>);
 expect(html).toContain("审查范围");expect(html).toContain("更多选项");expect(html).toContain('value="src/"');expect(html).not.toContain("高级 JSON");expect(html).not.toContain("未填");expect(html).not.toContain("object");
});
test("复杂参数保留原值，不转成object字符串输入导致数据损坏",()=>{
 const html=renderToStaticMarkup(<CompactParameterForm schema={{type:"object",properties:{config:{type:"object"},counts:{type:"array",items:{type:"integer"}}}}} initialValue={{config:{enabled:true},counts:[1,2]}} onSubmit={async()=>{}}/>);
 expect(html).toContain("复杂参数已保留");expect(html).not.toContain("[object Object]");expect(html).not.toContain('value="1，2"');
});
