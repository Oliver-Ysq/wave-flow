import {expect,test} from "bun:test";
import {suggestedParameters} from "../../src-tauri/web/src/forms/parameter-defaults";
test("建议值显式初填但不覆盖空串/null/已有数组，快照相互隔离",()=>{
 const schema={properties:{focus:{default:["安全"]},count:{default:8},context:{default:"背景"}}};
 const input={context:null,count:0};
 const value=suggestedParameters(schema,input);
 expect(value).toEqual({context:null,count:0,focus:["安全"]});expect(input).toEqual({context:null,count:0});
 (value.focus as string[]).push("新增");expect(suggestedParameters(schema,{}).focus).toEqual(["安全"]);
 expect(suggestedParameters(schema,{context:"",focus:[]}).context).toBe("");
});
