import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareSessionScratch } from "../../src/workspace/session-scratch";
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
test("私有scratch与项目重叠时创建前拒绝，不留下项目目录",async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),"wave-flow-lead-scratch-test-")));roots.push(root);const project=join(root,"project");await mkdir(project);
 const invalid=join(project,"state");await expect(prepareSessionScratch(invalid,project)).rejects.toThrow("重叠");expect(await Bun.file(invalid).exists()).toBe(false);
 const state=join(root,"state");const a=await prepareSessionScratch(state,project),b=await prepareSessionScratch(state,project);expect(a).not.toBe(b);expect(a.startsWith(`${state}/session-`)).toBe(true);
 await symlink(state,join(root,"link"));await expect(prepareSessionScratch(join(root,"link","new"),project)).rejects.toThrow("符号链接");expect(await Bun.file(join(state,"new")).exists()).toBe(false);
 if(process.platform==="darwin"){
  const systemTmp=join("/tmp",`wave-flow-scratch-${crypto.randomUUID()}`);roots.push(systemTmp);
  const scratch=await prepareSessionScratch(systemTmp,project);expect(scratch.startsWith("/private/tmp/")).toBe(true);
 }
});
