import { afterEach, expect, spyOn, test as bunTest } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepository } from "../../src/workspace/git-repository";
import { SourcePersistenceError, isRetryableSourceError, WorkspaceManager, type WorkspaceAuthorization } from "../../src/workspace/workspace-manager";
import { GitCommandError } from "../../src/workspace/git-repository";
import { WorkflowContractError } from "../../src/workflow/errors";
import { WorkspaceExecutor } from "../../src/workspace/workspace-executor";
import type { AgentNodeSnapshot } from "../../src/runtime/run-types";
import { resolveIntegrationSources } from "../../src/workspace/integration-sources";

// 多次真实Git子进程的端到端测试使用明确预算，避免默认5s杀进程产生伪逻辑错误。
const test = (name: string, run: () => Promise<void>, timeout = 15_000) => bunTest(name, run, timeout);

const directories: string[] = [];
test("交付重试按错误类型分类，安全契约拒绝不误当临时失败",async()=>{
 expect(isRetryableSourceError(new SourcePersistenceError("fixture"))).toBe(true);
 expect(isRetryableSourceError(new GitCommandError("fixture"))).toBe(true);
 expect(isRetryableSourceError(new Error("disk"))).toBe(true);
 expect(isRetryableSourceError(new WorkflowContractError("未集成/越界/锁"))).toBe(false);
 const {manager,identity}=await fixture();
 await manager.recordSourceDiagnostic(identity.runId,"contract refused");
 expect(await manager.canRetrySource(identity.runId)).toBe(false);
 await manager.recordSourceDiagnostic(identity.runId,"disk",true);
 expect(await manager.canRetrySource(identity.runId)).toBe(true);
});
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-workspace-test-"))); directories.push(root);
  const cwd = join(root, "repo"); await mkdir(cwd);
  async function git(...args: string[]) { const child = Bun.spawn(["/usr/bin/git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, stdout: "pipe", stderr: "pipe" }); const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); if (code) throw new Error(err); return out.trim(); }
  await git("init", "-b", "main"); await writeFile(join(cwd, "a.txt"), "base\n"); await git("add", "--", "a.txt"); await git("commit", "-m", "fixture");
  const authorization: WorkspaceAuthorization = { authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), repository: cwd, baseCommit: await git("rev-parse", "HEAD"), excludeExistingDirty: false, nodes: [{ nodeId: "a" }, { nodeId: "b" }] };
  const manager = await WorkspaceManager.open(join(root, "state"), crypto.randomUUID());
  const workspaceId = crypto.randomUUID(), identity = { runId: crypto.randomUUID(), nodeId: "a", attempt: 1 };
  return { root, cwd, manager, workspaceId, authorization, identity };
}
test("原版恢复先核验writer与保存现场；漂移拒绝且不回滚，completed仅允许补收尾", async () => {
  const { manager, workspaceId, authorization, identity } = await fixture();
  const auth = { ...authorization, nodes: [authorization.nodes[0]] };
  const config = { version: 2 as const, authorization: auth, bindings: [{ nodeId: "a", workspaceId }] };
  const workspace = await manager.create(workspaceId, auth);
  await manager.assertResumeReady(config, identity.runId, []);
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, identity), "original-writer");
  await expect(manager.assertResumeReady(config, identity.runId, [])).rejects.toThrow("writer尚未交接");
  await expect(manager.assertResumeReady(config, crypto.randomUUID(), ["a"])).rejects.toThrow("writer尚未交接");
  await manager.assertResumeReady(config, identity.runId, ["a"]);
  expect((await manager.inspect(workspaceId)).lease).toEqual(lease);
  await writeFile(join(workspace.cwd, "a.txt"), "partial\n");
  await manager.finish(lease, false, async () => true);
  await manager.assertResumeReady(config, identity.runId, []);
  await writeFile(join(workspace.cwd, "a.txt"), "external-change\n");
  await expect(manager.assertResumeReady(config, identity.runId, [])).rejects.toThrow("请修订");
  expect(await Bun.file(join(workspace.cwd, "a.txt")).text()).toBe("external-change\n");
  expect((await manager.inspect(workspaceId)).lease).toBeNull();
});
test("跨Execution明确交接partial持续worktree，新授权不覆盖旧版且新节点重新工作",async()=>{
 const {manager,workspaceId,authorization,identity,root}=await fixture();
 const original={...authorization,nodes:[authorization.nodes[0]]},workspace=await manager.create(workspaceId,original);
 const lease=await manager.bindWriter(await manager.acquire(workspaceId,identity),"original");
 await writeFile(join(workspace.cwd,"a.txt"),"partial\n");await manager.finish(lease,false,async()=>true);
 const prior=(await manager.inspect(workspaceId)).results[0],executionId=crypto.randomUUID();
 const renewed={...original,authorizationId:crypto.randomUUID(),approvedAt:new Date().toISOString(),nodes:[{nodeId:"repair"}]};
 const config={version:2 as const,authorization:renewed,bindings:[{nodeId:"repair",workspaceId}],continuation:{executionId:identity.runId,heads:[{workspaceId,commit:prior.commit}]}};
 await manager.prepareExecution(executionId,config);await manager.prepareExecution(executionId,config);
 await expect(manager.prepareExecution(executionId,{...config,continuation:{...config.continuation,executionId:crypto.randomUUID()}})).rejects.toThrow("来源已冻结");
 await expect(manager.prepareExecution(executionId,{...config,continuation:{...config.continuation,heads:[{workspaceId,commit:original.baseCommit}]}})).rejects.toThrow("来源已冻结");
 const handed=await manager.inspect(workspaceId);expect(handed.authorization).toEqual(original);expect(handed.results).toEqual([prior]);expect(handed.executionAuthorizations).toHaveLength(1);
 expect(await Bun.file(join(workspace.cwd,"a.txt")).text()).toBe("partial\n");
 await expect(manager.acquire(workspaceId,identity)).rejects.toThrow("旧执行");
 await manager.assertResumeReady(config,executionId,[]);
 await expect(manager.acquire(workspaceId,{runId:executionId,nodeId:"a",attempt:1})).rejects.toThrow("未获");
 const next=await manager.bindWriter(await manager.acquire(workspaceId,{runId:executionId,nodeId:"repair",attempt:1}),"next");
 await writeFile(join(workspace.cwd,"a.txt"),"repaired\n");await manager.finish(next,true,async()=>true);
 const ready=await manager.finalizeSource(executionId,config,["repair"]);expect(ready.baseCommit).toBe(original.baseCommit);
 expect((await manager.inspect(workspaceId)).results).toHaveLength(2);expect(ready.commit).not.toBe(prior.commit);
 await expect(manager.assertResumeReady({version:2,authorization:original,bindings:[{nodeId:"a",workspaceId}]},identity.runId,[])).rejects.toThrow("旧版恢复只读");
 const reopened=await WorkspaceManager.open(join(root,"state"),crypto.randomUUID());expect(reopened.authorizationFor(await reopened.inspect(workspaceId),executionId)).toEqual(renewed);
},25_000);
test("续作拒绝旧批准、未知writer、来源漂移；拒绝时原授权和partial不变",async()=>{
 const {manager,workspaceId,authorization,identity}=await fixture(),original={...authorization,nodes:[authorization.nodes[0]]};
 const workspace=await manager.create(workspaceId,original),lease=await manager.bindWriter(await manager.acquire(workspaceId,identity),"original");
 const renewed={...original,authorizationId:crypto.randomUUID(),nodes:[{nodeId:"repair"}]},executionId=crypto.randomUUID();
 let config={version:2 as const,authorization:renewed,bindings:[{nodeId:"repair",workspaceId}],continuation:{executionId:identity.runId,heads:[{workspaceId,commit:original.baseCommit}]}};
 await expect(manager.prepareExecution(executionId,config)).rejects.toThrow("writer未交接");
 await writeFile(join(workspace.cwd,"a.txt"),"partial\n");await manager.finish(lease,false,async()=>true);
 const before=await manager.inspect(workspaceId);config={...config,continuation:{executionId:identity.runId,heads:[{workspaceId,commit:before.results[0].commit}]}};
 await expect(manager.prepareExecution(executionId,{...config,authorization:{...renewed,authorizationId:original.authorizationId}})).rejects.toThrow("独立新授权");
 await writeFile(join(workspace.cwd,"a.txt"),"external\n");await expect(manager.prepareExecution(executionId,config)).rejects.toThrow("现场变化");
 expect(await manager.inspect(workspaceId)).toEqual(before);expect(await Bun.file(join(workspace.cwd,"a.txt")).text()).toBe("external\n");
},20_000);
test("接管后的干净外部commit不等于批准现场，writer拒绝且保留新HEAD",async()=>{
 const {manager,workspaceId,authorization,identity}=await fixture(),original={...authorization,nodes:[authorization.nodes[0]]};
 const workspace=await manager.create(workspaceId,original),lease=await manager.bindWriter(await manager.acquire(workspaceId,identity),"original");
 await writeFile(join(workspace.cwd,"a.txt"),"saved\n");await manager.finish(lease,true,async()=>true);
 const commit=(await manager.inspect(workspaceId)).results[0].commit,executionId=crypto.randomUUID();
 const renewed={...original,authorizationId:crypto.randomUUID(),nodes:[{nodeId:"repair"}]};
 await manager.prepareExecution(executionId,{version:2,authorization:renewed,bindings:[{nodeId:"repair",workspaceId}],continuation:{executionId:identity.runId,heads:[{workspaceId,commit}]}});
 const child=Bun.spawn(["/usr/bin/git","-c","user.name=External","-c","user.email=external@example.invalid","commit","--allow-empty","-m","External scene change"],{cwd:workspace.cwd,stdout:"ignore",stderr:"pipe"});expect(await child.exited).toBe(0);
 const changed=(await (await GitRepository.open(workspace.cwd)).inspect()).head;expect(changed).not.toBe(commit);
 await expect(manager.acquire(workspaceId,{runId:executionId,nodeId:"repair",attempt:1})).rejects.toThrow("HEAD被外部修改");
 expect((await (await GitRepository.open(workspace.cwd)).inspect()).head).toBe(changed);expect((await manager.inspect(workspaceId)).lease).toBeNull();
},20_000);
test("多目录交接关联部分失败，原请求补剩余授权不重复、零writer投递",async()=>{
 const {manager,authorization,identity}=await fixture(),oldIds=[crypto.randomUUID(),crypto.randomUUID()],heads=[];
 for(let index=0;index<2;index++){
  const auth={...authorization,nodes:[authorization.nodes[index]]},workspace=await manager.create(oldIds[index],auth);
  const lease=await manager.bindWriter(await manager.acquire(oldIds[index],{...identity,nodeId:auth.nodes[0].nodeId}),"original");
  await writeFile(join(workspace.cwd,"a.txt"),`saved-${index}\n`);const saved=await manager.finish(lease,false,async()=>true);heads.push({workspaceId:oldIds[index],commit:saved.commit});
 }
 const executionId=crypto.randomUUID(),renewed={...authorization,authorizationId:crypto.randomUUID(),nodes:[{nodeId:"repair-a"},{nodeId:"repair-b"}]};
 const config={version:2 as const,authorization:renewed,bindings:oldIds.map((workspaceId,index)=>({workspaceId,nodeId:renewed.nodes[index].nodeId})),continuation:{executionId:identity.runId,heads}};
 const target=manager as unknown as {write:(...args:unknown[])=>Promise<void>},original=target.write.bind(manager);let writes=0;
 const injected=spyOn(target,"write").mockImplementation(async(...args)=>{if(++writes===2)throw Error("association disk error");return original(...args);});
 try{await expect(manager.prepareExecution(executionId,config)).rejects.toThrow("association disk error");}finally{injected.mockRestore();}
 expect((await manager.inspect(oldIds[0])).executionAuthorizations).toHaveLength(1);expect((await manager.inspect(oldIds[1])).executionAuthorizations).toBeUndefined();
 await manager.prepareExecution(executionId,config);
 for(const id of oldIds){const record=await manager.inspect(id);expect(record.executionAuthorizations).toHaveLength(1);expect(record.lease).toBeNull();expect(record.results).toHaveLength(1);}
},30_000);

test("现场指纹识别同一路径dirty内容变化，读取不创建commit或覆盖文件", async () => {
  const { cwd, authorization } = await fixture();
  const repo = await GitRepository.open(cwd);
  const first = await repo.sceneFingerprint();
  await writeFile(join(cwd, "a.txt"), "dirty-one\n");
  const second = await repo.sceneFingerprint();
  await writeFile(join(cwd, "a.txt"), "dirty-two\n");
  const third = await repo.sceneFingerprint();
  expect(second.state.changedPaths).toEqual(third.state.changedPaths);
  expect(second.hash).not.toBe(first.hash); expect(third.hash).not.toBe(second.hash);
  expect((await repo.inspect()).head).toBe(authorization.baseCommit);
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("dirty-two\n");
});
test("现场指纹拒绝软链接和超限内容，不追读链接或接受不完整证据", async () => {
  const { cwd, root } = await fixture();
  const repo = await GitRepository.open(cwd);
  await writeFile(join(root,"outside.txt"),"outside");
  await symlink(join(root,"outside.txt"),join(cwd,"linked.txt"));
  await expect(repo.sceneFingerprint()).rejects.toThrow();
  expect(await Bun.file(join(root,"outside.txt")).text()).toBe("outside");
  await rm(join(cwd,"linked.txt"));
  await writeFile(join(cwd,"large.bin"),new Uint8Array(16*1024*1024+1));
  await expect(repo.sceneFingerprint()).rejects.toThrow("16MiB");
  expect((await repo.inspect()).changedPaths).toEqual(["large.bin"]);
});
test("工作文件回到HEAD但暂存区不同仍改变现场指纹，读取不清除暂存",async()=>{
 const {cwd}=await fixture(),repo=await GitRepository.open(cwd);
 const original=await repo.sceneFingerprint();
 await writeFile(join(cwd,"a.txt"),"staged\n");
 const add=Bun.spawn(["/usr/bin/git","add","--","a.txt"],{cwd,stdout:"ignore",stderr:"pipe"});expect(await add.exited).toBe(0);
 await writeFile(join(cwd,"a.txt"),"base\n");
 const changed=await repo.sceneFingerprint();expect(changed.hash).not.toBe(original.hash);
 expect(changed.state.changedPaths).toEqual(["a.txt"]);
 const read=Bun.spawn(["/usr/bin/git","show",":a.txt"],{cwd,stdout:"pipe",stderr:"pipe"});expect(await new Response(read.stdout).text()).toBe("staged\n");expect(await read.exited).toBe(0);
});
test("受管现场仅暂存区有变化时拒绝交接与空成果，不清除暂存内容",async()=>{
 const {manager,workspaceId,authorization,identity}=await fixture();
 const auth={...authorization,nodes:[authorization.nodes[0]]},workspace=await manager.create(workspaceId,auth);
 await writeFile(join(workspace.cwd,"a.txt"),"staged\n");
 const add=Bun.spawn(["/usr/bin/git","add","--","a.txt"],{cwd:workspace.cwd,stdout:"ignore",stderr:"pipe"});expect(await add.exited).toBe(0);
 await writeFile(join(workspace.cwd,"a.txt"),"base\n");
 await expect(manager.acquire(workspaceId,identity)).rejects.toThrow("未收尾");
 await expect((await GitRepository.open(workspace.cwd)).save({requestId:crypto.randomUUID(),baseCommit:auth.baseCommit,startCommit:auth.baseCommit})).rejects.toThrow("暂存区与工作文件不一致");
 const read=Bun.spawn(["/usr/bin/git","show",":a.txt"],{cwd:workspace.cwd,stdout:"pipe",stderr:"pipe"});expect(await new Response(read.stdout).text()).toBe("staged\n");expect(await read.exited).toBe(0);
 expect((await (await GitRepository.open(workspace.cwd)).inspect()).head).toBe(auth.baseCommit);
});
test("最终交付拒绝锁/漂移，清理后仍可读取完整来源且关联失败重试不重复commit", async () => {
  const { manager, workspaceId, authorization, identity, cwd } = await fixture();
  const auth = { ...authorization, nodes: [authorization.nodes[0]] };
  const config = { version: 2 as const, authorization: auth, bindings: [{ nodeId: "a", workspaceId }] };
  const workspace = await manager.create(workspaceId, auth);
  await expect(manager.finalizeSource(identity.runId, { ...config, version: 1 } as never)).rejects.toThrow("v2");
  await expect(manager.finalizeSource(identity.runId, config, ["a"])).rejects.toThrow("缺ready");
  await expect(manager.finalizeSource(identity.runId, config, ["unknown"])).rejects.toThrow("未授权");
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, identity), "group");
  await expect(manager.finalizeSource(identity.runId, config)).rejects.toThrow("锁");
  await writeFile(join(workspace.cwd, "a.txt"), "final\n");
  const saved = await manager.finish(lease, true, async () => true);
  await writeFile(join(workspace.cwd, "a.txt"), "drift\n");
  await expect(manager.finalizeSource(identity.runId, config)).rejects.toThrow("漂移");
  await writeFile(join(workspace.cwd, "a.txt"), "final\n");
  await manager.cleanup(workspaceId, true);
  const write = spyOn(manager as unknown as { write: (...args: unknown[]) => Promise<void> }, "write").mockRejectedValueOnce(new Error("delivery association failed"));
  try { await expect(manager.finalizeSource(identity.runId, config)).rejects.toThrow("association failed"); } finally { write.mockRestore(); }
  const result = await manager.finalizeSource(identity.runId, config);
  expect(result.sourceCommit).toBe(saved.commit);
  expect(await manager.finalizeSource(identity.runId, config)).toEqual(result);
  expect(await manager.inspectSource(identity.runId)).toEqual(result);
  await expect((await GitRepository.open(cwd)).inspect()).resolves.toMatchObject({ head: authorization.baseCommit });
});

test("多独立分支拒绝交付，真实多父集成后只交付完整tree", async () => {
  const { manager, authorization, identity, root, cwd } = await fixture();
  const auth = { ...authorization, nodes: [{ nodeId: "a" }, { nodeId: "b" }, { nodeId: "merge" }] };
  const bindings = auth.nodes.map(node => ({ nodeId: node.nodeId, workspaceId: crypto.randomUUID() }));
  const config = { version: 2 as const, authorization: auth, bindings: bindings.map(binding => binding.nodeId === "merge" ? { ...binding, integrationSources: { nodeIds: ["a", "b"] } } : binding) };
  const commits: string[] = [];
  for (const binding of bindings) {
    const workspace = await manager.create(binding.workspaceId, { ...auth, nodes: auth.nodes.filter(node => node.nodeId === binding.nodeId) });
    if (binding.nodeId === "merge") continue;
    const lease = await manager.bindWriter(await manager.acquire(binding.workspaceId, { ...identity, nodeId: binding.nodeId }), "group");
    await writeFile(join(workspace.cwd, `${binding.nodeId}.txt`), binding.nodeId + "\n");
    commits.push((await manager.finish(lease, true, async () => true)).commit);
  }
  await expect(manager.finalizeSource(identity.runId, config)).rejects.toThrow("尚未完整显式集成");
  const merge = await manager.inspect(bindings[2].workspaceId);
  const lease = await manager.bindWriter(await manager.acquire(merge.workspaceId, { ...identity, nodeId: "merge" }, commits), "merge-group");
  await manager.createScratch(lease.leaseId); await mkdir(join(root, "state", "scratch", lease.leaseId, "objects"));
  const child = Bun.spawn(["/usr/bin/git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-commit", "--no-ff", ...commits], { cwd: merge.cwd, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(child.stderr).text(); expect(await child.exited, stderr).toBe(0);
  const merged = await manager.finish(lease, true, async () => true);
  const delivery = await manager.finalizeSource(identity.runId, config);
  expect(delivery.paths).toEqual(["a.txt", "b.txt"]);
  expect(delivery.sourceCommit).toBe(merged.commit);
  async function git(...args: string[]) { const p = Bun.spawn(["/usr/bin/git", ...args], { cwd, stdout: "pipe" }); const out = await new Response(p.stdout).text(); expect(await p.exited).toBe(0); return out.trim(); }
  expect(delivery.commit).toBe(merged.commit); expect(await git("show", "-s", "--format=%P", delivery.commit)).toBe([auth.baseCommit,...commits].join(" "));
  expect(await git("rev-parse", `${delivery.commit}^{tree}`)).toBe(await git("rev-parse", `${merged.commit}^{tree}`));
  expect(await git("rev-list", "--count", `${auth.baseCommit}..${delivery.commit}`)).toBe("3");
  const executionId=crypto.randomUUID(),renewed={...auth,authorizationId:crypto.randomUUID(),nodes:[{nodeId:"repair"}]};
  const continuation={executionId:identity.runId,heads:[...bindings.slice(0,2).map((binding,index)=>({workspaceId:binding.workspaceId,commit:commits[index]})),{workspaceId:merge.workspaceId,commit:merged.commit}]};
  await expect(manager.prepareExecution(executionId,{version:2,authorization:renewed,bindings:[{nodeId:"repair",workspaceId:bindings[0].workspaceId}],continuation})).rejects.toThrow("尚未被所选现场显式集成");
  const nextConfig={version:2 as const,authorization:renewed,bindings:[{nodeId:"repair",workspaceId:merge.workspaceId}],continuation};
  await manager.prepareExecution(executionId,nextConfig);
  const nextLease=await manager.bindWriter(await manager.acquire(merge.workspaceId,{runId:executionId,nodeId:"repair",attempt:1}),"new-writer");
  await writeFile(join(merge.cwd,"a.txt"),"repaired\n");await manager.finish(nextLease,true,async()=>true);
  const next=await manager.finalizeSource(executionId,nextConfig,["repair"]);expect(await mainContains(next.commit,merged.commit)).toBe(true);
  async function mainContains(source:string,parent:string){return (await git("merge-base",source,parent))===parent;}
},40_000);

test("partial不能自动最终交付，失败诊断耐久但不制造交付记录", async () => {
  const { manager, workspaceId, authorization, identity, root } = await fixture();
  const auth = { ...authorization, nodes: [authorization.nodes[0]] };
  const workspace = await manager.create(workspaceId, auth);
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, identity), "group");
  await writeFile(join(workspace.cwd, "a.txt"), "partial\n"); await manager.finish(lease, false, async () => true);
  await expect(manager.finalizeSource(identity.runId, { version: 2, authorization: auth, bindings: [{ nodeId: "a", workspaceId }] })).rejects.toThrow("partial");
  await manager.recordSourceDiagnostic(identity.runId, "partial");
  const reopened = await WorkspaceManager.open(join(root, "state"), crypto.randomUUID());
  expect(await reopened.inspectSource(identity.runId)).toBeNull();
  expect(await reopened.inspectSourceDiagnostic(identity.runId)).toBe("partial");
});

test("首次dirty基线拒绝；显式排除用户内容后创建且同身份重试不重复分支", async () => {
  const { cwd, manager, workspaceId, authorization } = await fixture();
  await writeFile(join(cwd, "a.txt"), "dirty\n");
  await expect(manager.create(workspaceId, authorization)).rejects.toThrow("dirty");
  const approved = { ...authorization, excludeExistingDirty: true };
  const workspace = await manager.create(workspaceId, approved);
  expect(await manager.create(workspaceId, approved)).toEqual(workspace);
  expect(await Bun.file(join(workspace.cwd, "a.txt")).text()).toBe("base\n");
  await expect(manager.create(workspaceId, { ...approved, authorizationId: crypto.randomUUID() })).rejects.toThrow("冲突");
});
test("同目录互斥；未退出writer保存拒绝且锁保留，退出后保存关联才能交接", async () => {
  const { manager, workspaceId, authorization, identity } = await fixture(); const workspace = await manager.create(workspaceId, authorization);
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, identity), "test-process-group");
  await expect(manager.acquire(workspaceId, { ...identity, nodeId: "b" })).rejects.toThrow("租约占用");
  await writeFile(join(workspace.cwd, "a.txt"), "result\n");
  await expect(manager.finish(lease, true, async () => false)).rejects.toThrow("退出不可核验");
  expect((await manager.inspect(workspaceId)).lease).toEqual(lease);
  const result = await manager.finish(lease, true, async () => true);
  expect(await manager.finish(lease, true, async () => { throw new Error("已关联响应重试不重新认领writer"); })).toEqual(result);
  const record = await manager.inspect(workspaceId); expect(record.lease).toBeNull(); expect(record.results[0]).toMatchObject({ ...identity, commit: result.commit, ready: true });
  const next = await manager.acquire(workspaceId, { ...identity, nodeId: "b" }); expect(next.startCommit).toBe(result.commit);
  await manager.abandonUnstarted(next);
});
test("保存成功但关联失败保留commit和锁，重试只补关联", async () => {
  const { manager, workspaceId, authorization, identity } = await fixture(); const workspace = await manager.create(workspaceId, authorization);
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, identity), "test-group"); await writeFile(join(workspace.cwd, "a.txt"), "saved\n");
  const repo = await GitRepository.open(workspace.cwd); const inspect = spyOn(manager as unknown as { write: (...args: unknown[]) => Promise<void> }, "write").mockRejectedValueOnce(new Error("关联落盘失败"));
  try { await expect(manager.finish(lease, true, async () => true)).rejects.toThrow("关联落盘失败"); } finally { inspect.mockRestore(); }
  const savedHead = (await repo.inspect()).head; expect(savedHead).not.toBe(authorization.baseCommit); expect((await manager.inspect(workspaceId)).lease).toEqual(lease);
  expect((await manager.finish(lease, true, async () => true)).commit).toBe(savedHead);
  expect((await manager.inspect(workspaceId)).results).toHaveLength(1);
});
test("重启不按旧租约/PID认领writer，partial保存不伪装ready", async () => {
  const { root, manager, workspaceId, authorization, identity } = await fixture(); const workspace = await manager.create(workspaceId, authorization);
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, identity), "old-process");
  const restarted = await WorkspaceManager.open(join(root, "state"), crypto.randomUUID());
  await expect(restarted.acquire(workspaceId, identity)).rejects.toThrow("租约占用");
  await expect(restarted.abandonUnstarted(lease)).rejects.toThrow("旧Engine");
  await expect(restarted.finish(lease, false, async () => false)).rejects.toThrow("退出不可核验");
  await writeFile(join(workspace.cwd, "a.txt"), "partial\n");
  await restarted.finish(lease, false, async () => true);
  expect((await restarted.inspect(workspaceId)).results[0].ready).toBe(false);
});

test("不同worktree的同名外部资源互斥，成果关联后释放", async () => {
  const { root, manager, authorization, identity } = await fixture();
  const firstId = crypto.randomUUID(), secondId = crypto.randomUUID();
  const external = { ...authorization, nodes: [{ nodeId: "a", externalResources: ["port:4173"] }] };
  const first = await manager.create(firstId, external), second = await manager.create(secondId, { ...external, authorizationId: crypto.randomUUID() });
  const lease = await manager.bindWriter(await manager.acquire(firstId, identity), "writer");
  await expect(manager.acquire(secondId, identity)).rejects.toThrow("外部资源");
  await writeFile(join(first.cwd, "a.txt"), "done\n"); await manager.finish(lease, true, async () => true);
  const next = await manager.acquire(secondId, identity); expect(next.externalResources).toEqual(["port:4173"]); await manager.abandonUnstarted(next);
  expect(await Bun.file(join(second.cwd, "a.txt")).text()).toBe("base\n");
}, 15_000);

test("WorkspaceExecutor实际改动只发生在受管cwd，finalize才保存，重开只复用原成果", async () => {
  const { root, cwd, manager, workspaceId, authorization, identity } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  const node: AgentNodeSnapshot = { id: "a", phase: "run", executionAttemptId: 1, phaseVisitId: 1, sequence: 1, executionBatch: { sequence: 1, mode: "serial" }, cli: "codex", sandbox: "workspace-write", cwd, label: "a", status: "running", result: null, diagnostic: null, createdAt: new Date().toISOString(), startedAt: null, endedAt: null, agentSessionId: crypto.randomUUID(), block: null, request: { id: "a", cli: "codex", sandbox: "workspace-write", cwd, phase: "run", prompt: "work" } };
  let calls = 0;
  const executor = new WorkspaceExecutor(manager, identity.runId, [{ nodeId: "a", workspaceId }], { execute: async () => { throw new Error("不应使用只读执行器"); } }, (_, binding) => ({ bindControl() {}, bindWriter: binding.bindWriter, verifyExited: async () => true, execute: async actual => { calls++; expect(actual.cwd).toBe(workspace.cwd); await binding.bindWriter("test-group"); await writeFile(join(actual.cwd, "a.txt"), "managed\n"); return { ok: true }; } }));
  executor.bindControl({} as any);
  expect(await executor.execute(node)).toEqual({ ok: true });
  expect((await manager.inspect(workspaceId)).results).toHaveLength(0);
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("base\n");
  const completed = { ...node, status: "completed" as const, result: { ok: true } };
  await executor.finalizeCompleted(completed); expect((await manager.inspect(workspaceId)).results[0].ready).toBe(true);
  const reopened = new WorkspaceExecutor(await WorkspaceManager.open(join(root, "state"), crypto.randomUUID()), identity.runId, [{ nodeId: "a", workspaceId }], { execute: async () => null }, () => { throw new Error("不应重新创建writer"); }); reopened.bindControl({} as any);
  await reopened.finalizeCompleted(completed); expect(calls).toBe(1);
  await writeFile(join(workspace.cwd,"a.txt"),"changed-after-save\n");
  await expect(reopened.finalizeCompleted(completed)).rejects.toThrow("漂移");
  await expect(executor.execute({ ...node, id: "unknown" })).rejects.toThrow("未绑定");
});
test("持续worktree后续ready提交不使前一completed成果失效，但未收尾HEAD拒绝复用",async()=>{
 const {manager,workspaceId,authorization,identity}=await fixture();const workspace=await manager.create(workspaceId,authorization);
 const first=await manager.bindWriter(await manager.acquire(workspaceId,identity),"first");await writeFile(join(workspace.cwd,"a.txt"),"first\n");const a=await manager.finish(first,true,async()=>true);
 const secondIdentity={...identity,nodeId:"b"};const second=await manager.bindWriter(await manager.acquire(workspaceId,secondIdentity),"second");await writeFile(join(workspace.cwd,"a.txt"),"second\n");const b=await manager.finish(second,true,async()=>true);expect(b.commit).not.toBe(a.commit);
 const reopened=new WorkspaceExecutor(manager,identity.runId,[{nodeId:"a",workspaceId},{nodeId:"b",workspaceId}],{execute:async()=>null},()=>{throw new Error("不应重跑")});reopened.bindControl({} as any);
 const node={id:"a",phase:"run",executionAttemptId:1,phaseVisitId:1,sequence:1,executionBatch:{sequence:1,mode:"serial"},cli:"codex",sandbox:"workspace-write",cwd:authorization.repository,label:"a",status:"completed",result:{ok:true},diagnostic:null,createdAt:new Date().toISOString(),startedAt:null,endedAt:null,agentSessionId:crypto.randomUUID(),block:null,request:{id:"a",cli:"codex",sandbox:"workspace-write",cwd:authorization.repository,phase:"run",prompt:"work"}} as AgentNodeSnapshot;
 await reopened.finalizeCompleted(node);await writeFile(join(workspace.cwd,"a.txt"),"uncommitted\n");await expect(reopened.finalizeCompleted(node)).rejects.toThrow("漂移");
},15_000);
test("用户stop后的partial关联不冒充ready，失败保留业务外的租约现场", async()=>{
  const {manager,workspaceId,authorization,identity}=await fixture();const workspace=await manager.create(workspaceId,authorization);
  let exited=true;
  const executor=new WorkspaceExecutor(manager,identity.runId,[{nodeId:"a",workspaceId}],{execute:async()=>null},(_,binding)=>({bindControl(){},bindWriter:binding.bindWriter,verifyExited:async()=>exited,execute:async actual=>{await binding.bindWriter("group");await writeFile(join(actual.cwd,"a.txt"),"partial\n");return new Promise(()=>{});},stop:async()=>{},finalizePartial:async()=>{}}));executor.bindControl({} as any);
  const node={id:"a",phase:"run",executionAttemptId:1,phaseVisitId:1,sequence:1,executionBatch:{sequence:1,mode:"serial"},cli:"codex",sandbox:"workspace-write",cwd:authorization.repository,label:"a",status:"running",result:null,diagnostic:null,createdAt:new Date().toISOString(),startedAt:null,endedAt:null,agentSessionId:crypto.randomUUID(),block:null,request:{id:"a",cli:"codex",sandbox:"workspace-write",cwd:authorization.repository,phase:"run",prompt:"work"}} as AgentNodeSnapshot;
  void executor.execute(node);while(!(await manager.inspect(workspaceId)).lease?.writerIdentity)await Bun.sleep(1);
  await executor.stop(node);await executor.finalizePartial({...node,status:"cancelled"});expect((await manager.inspect(workspaceId)).results[0]).toMatchObject({ready:false});
  expect((await manager.inspect(workspaceId)).lease).toBeNull();
},15_000);
test("清理只移除ready且干净的checkout，保留分支commit供后续集成核验",async()=>{
  const {manager,workspaceId,authorization,identity,cwd}=await fixture();const workspace=await manager.create(workspaceId,authorization);
  const lease=await manager.bindWriter(await manager.acquire(workspaceId,identity),"group");await writeFile(join(workspace.cwd,"a.txt"),"ready\n");const saved=await manager.finish(lease,true,async()=>true);
  await expect(manager.cleanup(workspaceId,false)).rejects.toThrow("明确授权");const cleaned=await manager.cleanup(workspaceId,true);expect(cleaned.cleanedAt).not.toBeNull();expect(await Bun.file(workspace.cwd).exists()).toBe(false);
  const repo=await GitRepository.open(cwd);await repo.verifyCommitObject(saved.commit,authorization.baseCommit,["a.txt"]);expect(await Bun.file(join(cwd,"a.txt")).text()).toBe("base\n");
},15_000);
test("partial、未保存或仍持锁worktree拒绝清理",async()=>{
 const {manager,workspaceId,authorization,identity}=await fixture();await manager.create(workspaceId,authorization);await expect(manager.cleanup(workspaceId,true)).rejects.toThrow("未交付");const lease=await manager.bindWriter(await manager.acquire(workspaceId,identity),"group");await expect(manager.cleanup(workspaceId,true)).rejects.toThrow("锁");await manager.finish(lease,false,async()=>true);await expect(manager.cleanup(workspaceId,true)).rejects.toThrow("partial");
},15_000);
test("ignored未知文件即使Git工作树看似干净也不能被清理",async()=>{
 const {manager,workspaceId,authorization,identity,cwd}=await fixture();
 // 仓库级exclude不执行过滤器，只让文件不在git status出现。
 await writeFile(join(cwd,".git","info","exclude"),"local.cache\n");
 const workspace=await manager.create(workspaceId,authorization);const lease=await manager.bindWriter(await manager.acquire(workspaceId,identity),"group");await manager.finish(lease,true,async()=>true);
 await writeFile(join(workspace.cwd,"local.cache"),"unknown-content");await expect(manager.cleanup(workspaceId,true)).rejects.toThrow("ignored");expect(await Bun.file(join(workspace.cwd,"local.cache")).text()).toBe("unknown-content");
},15_000);
test("checkout已移除但cleaned关联失败时，重试按耐久意图补关联且不重复删除",async()=>{
 const {manager,workspaceId,authorization,identity}=await fixture();const workspace=await manager.create(workspaceId,authorization);const lease=await manager.bindWriter(await manager.acquire(workspaceId,identity),"group");await writeFile(join(workspace.cwd,"a.txt"),"ready\n");await manager.finish(lease,true,async()=>true);
 const target=manager as unknown as {write:(...args:unknown[])=>Promise<void>},original=target.write.bind(manager);const write=spyOn(target,"write");let writes=0;write.mockImplementation(async(...args:unknown[])=>{writes++;if(writes===2)throw new Error("cleaned关联失败");return original(...args);});
 await expect(manager.cleanup(workspaceId,true)).rejects.toThrow("关联失败");write.mockRestore();expect(await Bun.file(workspace.cwd).exists()).toBe(false);
 await expect(manager.acquire(workspaceId,identity)).rejects.toThrow("清理意图");
 const recovered=await manager.cleanup(workspaceId,true);expect(recovered.cleanedAt).not.toBeNull();expect(recovered.cleanupRequestedAt).not.toBeNull();
},15_000);

test("显式集成真实来源commit：缺失/未来/partial/仍有锁拒绝，ready批次传递实际hash且现场变化拒绝", async () => {
  const { manager, workspaceId, authorization, identity } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  const targetId = crypto.randomUUID(); const targetWorkspace = await manager.create(targetId, { ...authorization, nodes: [{ nodeId: "integrate" }] });
  const node: AgentNodeSnapshot = { id: "a", phase: "run", executionAttemptId: 1, phaseVisitId: 1, sequence: 1, executionBatch: { sequence: 1, mode: "parallel" }, cli: "codex", sandbox: "workspace-write", cwd: workspace.cwd, label: "a", status: "completed", result: { ok: true }, diagnostic: null, createdAt: new Date().toISOString(), startedAt: null, endedAt: null, agentSessionId: crypto.randomUUID(), block: null, request: { id: "a", cli: "codex", sandbox: "workspace-write", cwd: workspace.cwd, phase: "run", prompt: "work" } };
  const target = { ...node, id: "integrate", sequence: 2, status: "running" as const };
  const options = { runId: identity.runId, integrationNode: target, nodes: [node, target], selection: { nodeIds: ["a"] }, bindings: [{ nodeId: "a", workspaceId }, { nodeId: "integrate", workspaceId: targetId }], manager, targetCommonDirectory: targetWorkspace.commonDirectory };
  await expect(resolveIntegrationSources({ ...options, selection: { nodeIds: ["missing"] } })).rejects.toThrow("未在本调用前");
  await expect(resolveIntegrationSources({ ...options, selection: { nodeIds: ["integrate"] } })).rejects.toThrow("未在本调用前");
  await expect(resolveIntegrationSources(options)).rejects.toThrow("未ready");
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, identity), "test-group");
  await writeFile(join(workspace.cwd, "a.txt"), "ready\n");
  await expect(resolveIntegrationSources(options)).rejects.toThrow("writer锁");
  const saved = await manager.finish(lease, true, async () => true);
  expect(await resolveIntegrationSources(options)).toEqual([{ runId: identity.runId, nodeId: "a", attempt: 1, workspaceId, commonDirectory: workspace.commonDirectory, commit: saved.commit, paths: ["a.txt"] }]);
  expect((await resolveIntegrationSources({ ...options, nodes: [node], selection: { batchSequence: 1 } }))[0].commit).toBe(saved.commit);
  await expect(resolveIntegrationSources({ ...options, nodes: [node, { ...node, id: "b", sequence: 2, status: "running" }], selection: { batchSequence: 1 } })).rejects.toThrow("未在本调用前");
  await writeFile(join(workspace.cwd, "a.txt"), "later\n");
  await expect(resolveIntegrationSources(options)).rejects.toThrow("现场漂移");
}, 15_000);
