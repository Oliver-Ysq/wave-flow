import {afterEach,expect,test} from "bun:test";
import {mkdtemp,rm,writeFile,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CliRuntimeRegistry} from "../../src/runtimes/registry";
import {verifyExecutable} from "../../src/runtimes/identity";
import type {CliRuntimeRecord} from "../../src/runtimes/types";
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),"wave-flow-auto-check-"));roots.push(root);
 const path=join(root,"kimi");await writeFile(path,"#!/bin/sh\nexit 0\n",{mode:0o700});
 const exe=await verifyExecutable(path);
 const record:CliRuntimeRecord={runtimeId:crypto.randomUUID(),cli:"claude",executablePath:exe.executablePath,executableIdentity:exe.identity,version:"kimi 1",discoveredFrom:"manual",discoveredShell:null,verifiedAdapter:{adapterId:"claude-acp",adapterVersion:"1",acpProtocolVersion:1,harnessTools:true},verifiedAt:new Date().toISOString(),status:"verified",diagnostic:null};
 return {root,path:exe.executablePath,record};
}
test("同路径更新并发仅一次完整复验，保留runtimeId与主控选择",async()=>{
 const f=await fixture();let calls=0;
 const registry=new CliRuntimeRegistry(f.root,async(cli,input)=>{calls++;expect(cli).toBe("claude");expect(input.executablePath).toBe(f.path);await Bun.sleep(20);const exe=await verifyExecutable(input.executablePath);return {...f.record,executableIdentity:exe.identity,version:"kimi 2"};});
 await registry.saveVerified(f.record);await registry.select(f.record.runtimeId);
 await writeFile(f.path,"#!/bin/sh\necho update\n",{mode:0o700});
 const checked=await Promise.all([registry.resolveSelectedHarness(),registry.resolveByIdHarness(f.record.runtimeId)]);
 expect(calls).toBe(1);expect(checked.map(r=>r.runtimeId)).toEqual([f.record.runtimeId,f.record.runtimeId]);
 expect(await registry.list()).toMatchObject({harnessRuntimeId:f.record.runtimeId,runtimes:[{status:"verified",version:"kimi 2"}]});
 await registry.resolveSelectedHarness();expect(calls).toBe(1);
});
test("自动复验失败不换CLI、不授权启动，明确保留失败原因",async()=>{
 const f=await fixture();const registry=new CliRuntimeRegistry(f.root,async()=>{throw Error("ACP协议不兼容");});
 await registry.saveVerified(f.record);await registry.select(f.record.runtimeId);await writeFile(f.path,"#!/bin/sh\necho update\n",{mode:0o700});
 await expect(registry.resolveSelectedHarness()).rejects.toThrow("ACP协议不兼容");
 expect(await registry.list()).toMatchObject({harnessRuntimeId:f.record.runtimeId,runtimes:[{status:"needs-revalidation"}]});
});
test("canonical路径被换成软链接时不执行探针",async()=>{
 const f=await fixture();let calls=0;const registry=new CliRuntimeRegistry(f.root,async()=>{calls++;return f.record;});
 await registry.saveVerified(f.record);await registry.select(f.record.runtimeId);
 const other=join(f.root,"other");await writeFile(other,"#!/bin/sh\nexit 0\n",{mode:0o700});await rm(f.path);await symlink(other,f.path);
 await expect(registry.resolveSelectedHarness()).rejects.toThrow("路径目标已变化");expect(calls).toBe(0);
});
