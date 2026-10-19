import {expect,test} from "bun:test";
import {parameterGroups,parameterErrorKey,parameterErrorMessage} from "../../src-tauri/web/src/forms/parameter-presentation";

test("参数分组只收起可选项及合法显式默认，非法默认不降低必填可见性",()=>{
 const schema={type:"object",properties:{required:{type:"string"},safe:{type:"string",enum:["safe","fast"],default:"safe"},bad:{type:"integer",minimum:1,default:0},optional:{type:"string"}},required:["required","safe","bad"]};
 expect(parameterGroups(schema)).toEqual({primary:["required","bad"],advanced:["safe","optional"]});
});

test("缺值错误转为动作指引，已有无效值保留原校验原因",()=>{
 expect(parameterErrorMessage({path:"mode",message:"必填字段未填写"},{type:"string",enum:["a"]},"模式",undefined)).toBe("请选择模式");
 expect(parameterErrorMessage({path:"enabled",message:"必填字段未填写"},{type:"boolean"},"启用",undefined)).toBe("请选择是或否");
 expect(parameterErrorMessage({path:"count",message:"必填字段未填写"},{type:"integer",minimum:1,maximum:10},"数量",undefined)).toBe("请输入 1–10 的整数");
 expect(parameterErrorMessage({path:"count",message:"不能大于 10"},{type:"integer",maximum:10},"数量",11)).toBe("不能大于 10");
});

test("错误字段身份按JSON Pointer解码，不按点号猜测",()=>{
 expect(parameterErrorKey({path:"a/b~c",pointer:"/a~1b~0c",message:"错误"},{"a/b~c":{}})).toBe("a/b~c");
 expect(parameterErrorKey({path:"",pointer:"",message:"顶层错误"},{target:{}})).toBeUndefined();
});
