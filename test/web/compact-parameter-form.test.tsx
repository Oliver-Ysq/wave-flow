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
test("字段较多时必填与可选分区，不把保存动作复制进滚动字段列表",()=>{
 const properties=Object.fromEntries(Array.from({length:12},(_,index)=>[`field${index}`,{type:"string",title:`字段${index}`}])) as Record<string,unknown>;
 const html=renderToStaticMarkup(<CompactParameterForm schema={{type:"object",required:["field0","field1","field2"],properties}} onSubmit={async()=>{}}/>);
 expect(html.match(/compact-parameter-field/g)?.length).toBe(12);
 expect(html).toContain("更多选项");
 expect(html.match(/保存待运行/g)?.length).toBe(1);
});
test("必填字段按required业务顺序，不受properties键顺序影响",()=>{
 const html=renderToStaticMarkup(<CompactParameterForm schema={{type:"object",properties:{focus:{type:"string"},maxFindings:{type:"integer"},target:{type:"string"}},required:["target","focus","maxFindings"]}} onSubmit={async()=>{}}/>);
 expect(html.indexOf("审查范围")).toBeLessThan(html.indexOf("关注重点"));
 expect(html.indexOf("关注重点")).toBeLessThan(html.indexOf("最多问题数"));
});
test("枚举与是或否下拉关联字段错误，支持首错定位而不改变已有选择",()=>{
 const schema={type:"object",properties:{mode:{type:"string",title:"运行方式",enum:["fast","safe"]},enabled:{type:"boolean",title:"启用检查"}},required:["mode","enabled"]};
 const errors=validateAnswer(schema,{});
 const html=renderToStaticMarkup(<CompactParameterForm schema={schema} validationErrors={errors} onSubmit={async()=>{}}/>);
 const selects=html.match(/<select[^>]+>/g)??[];
 expect(selects).toHaveLength(2);
 for(const select of selects){expect(select).toContain('aria-invalid="true"');expect(select).toContain('aria-describedby=');expect(select).toContain('id=');}
 expect(html).toContain('role="alert"');
 const valid=renderToStaticMarkup(<CompactParameterForm schema={schema} initialValue={{mode:"safe",enabled:false}} onSubmit={async()=>{}}/>);
 expect(valid).toContain('value="safe" selected=""');
 expect(valid).toContain('value="false" selected=""');
});
test("多个错误在字段前显示可定位摘要，转义字段名且优先使用Schema标题",()=>{
 const schema={type:"object",properties:{"a/b~c":{type:"string",title:"检查范围"},enabled:{type:"boolean",title:"启用检查"}},required:["a/b~c","enabled"]};
 const html=renderToStaticMarkup(<CompactParameterForm schema={schema} validationErrors={validateAnswer(schema,{})} onSubmit={async()=>{}}/>);
 expect(html).toContain("检查范围：必填字段未填写");
 expect(html).toContain("启用检查：必填字段未填写");
 expect(html.match(/<a href=/g)).toHaveLength(2);
 expect(html.indexOf('parameter-error-summary')).toBeLessThan(html.indexOf('compact-parameter-grid'));
 expect(html).toContain('a/b~c');
 const single=renderToStaticMarkup(<CompactParameterForm schema={{type:"object",properties:{target:{type:"string"}},required:["target"]}} validationErrors={[{path:"target",pointer:"/target",message:"必填字段未填写"}]} onSubmit={async()=>{}}/>);
 expect(single).not.toContain('parameter-error-summary');
 expect(single).toContain('aria-invalid="true"');
});
