import {expect,test} from "bun:test";
import {designExecutionConfig,DesignConfirmationCache} from "../../src-tauri/web/src/workflow-design-config";
import type {ExecutionPlanResponse} from "../../src-tauri/web/src/types";
const runtime=(runtimeId:string,cli:"codex"|"kimi")=>({runtimeId,cli,status:"verified",verifiedAdapter:{adapterId:cli==="codex"?"codex-acp":"kimi-acp",adapterVersion:"1",harnessTools:true}});
const plan={workers:[{id:"reviewer"},{id:"verifier"}],pool:[runtime("c","codex"),runtime("k","kimi")],harnessRuntime:runtime("c","codex")} as unknown as ExecutionPlanResponse;
test("内联CLI默认主控，手工选择记录user，动态默认与固定Worker独立",()=>{
 const config=designExecutionConfig(plan,{verifier:"k","*":"k"},"2026-10-16T00:00:00Z");
 expect(config.assignments[0]).toMatchObject({agentId:"reviewer",cli:"codex",source:"harness-cli"});
 expect(config.assignments[1]).toMatchObject({agentId:"verifier",cli:"kimi",source:"user"});
 expect(config.defaultAssignment).toMatchObject({cli:"kimi",source:"user"});
 expect(config.fallbackRuntimeId).toBe("c");expect(config.ruleText).toBeNull();
});
test("内联CLI失效或未知节点拒绝，不静默随机或替换",()=>{
 expect(()=>designExecutionConfig(plan,{reviewer:"missing"})).toThrow("不可用");
 expect(()=>designExecutionConfig(plan,{ghost:"c"})).toThrow("未知");
});
test("导航后相同确认重试复用UUID和原配置，读取副本不能污染缓存",()=>{
 const cache=new DesignConfirmationCache();
 const first=cache.get("task:card:1",{target:"a.ts"},{reviewer:"k"},plan);
 const expected=structuredClone(first);
 first.config.assignments[0]!.runtimeId="mutated";
 const retry=cache.get("task:card:1",{target:"a.ts"},{reviewer:"k"},plan);
 expect(retry).toEqual(expected);
});
test("参数或CLI改变生成新确认，返回原载荷仍复用原请求，身份之间不串用",()=>{
 const cache=new DesignConfirmationCache();
 const first=cache.get("task:card:1",{target:"a.ts"},{},plan);
 expect(cache.get("task:card:1",{target:"b.ts"},{},plan).id).not.toBe(first.id);
 expect(cache.get("task:card:1",{target:"a.ts"},{reviewer:"k"},plan).id).not.toBe(first.id);
 expect(cache.get("other:card:1",{target:"a.ts"},{},plan).id).not.toBe(first.id);
 expect(cache.get("task:card:2",{target:"a.ts"},{},plan).id).not.toBe(first.id);
 expect(cache.get("task:card:1",{target:"a.ts"},{},plan)).toEqual(first);
});
test("确认缓存有界且App新会话不假装恢复旧请求",()=>{
 const cache=new DesignConfirmationCache();
 const first=cache.get("task:card:1",{}, {},plan);
 for(let i=0;i<64;i++)cache.get(`other:card:${i}`,{}, {},plan);
 expect(cache.get("task:card:1",{}, {},plan).id).not.toBe(first.id);
 expect(new DesignConfirmationCache().get("task:card:1",{}, {},plan).id).not.toBe(first.id);
});
