import { afterEach, expect, spyOn, test as bunTest } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepository } from "../../src/workspace/git-repository";
import { DeliveryPersistenceError, isRetryableDeliveryError, WorkspaceManager, type WorkspaceAuthorization } from "../../src/workspace/workspace-manager";
import { GitCommandError } from "../../src/workspace/git-repository";
import { WorkflowContractError } from "../../src/workflow/errors";
import { WorkspaceExecutor } from "../../src/workspace/workspace-executor";
import type { AgentNodeSnapshot } from "../../src/runtime/run-types";
import { resolveIntegrationSources } from "../../src/workspace/integration-sources";

// 多次真实Git子进程的端到端测试使用明确预算，避免默认5s杀进程产生伪逻辑错误。
const test = (name: string, run: () => Promise<void>, timeout = 15_000) => bunTest(name, run, timeout);

const directories: string[] = [];
test("交付重试按错误类型分类，安全契约拒绝不误当临时失败",async()=>{
 expect(isRetryableDeliveryError(new DeliveryPersistenceError("fixture"))).toBe(true);
 expect(isRetryableDeliveryError(new GitCommandError("fixture"))).toBe(true);
 expect(isRetryableDeliveryError(new Error("disk"))).toBe(true);
 expect(isRetryableDeliveryError(new WorkflowContractError("未集成/越界/锁"))).toBe(false);
 const {manager,identity}=await fixture();
 await manager.recordDeliveryDiagnostic(identity.runId,"contract refused");
 expect(await manager.canRetryDelivery(identity.runId)).toBe(false);
 await manager.recordDeliveryDiagnostic(identity.runId,"disk",true);
 expect(await manager.canRetryDelivery(identity.runId)).toBe(true);
});
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-workspace-test-"))); directories.push(root);
  const cwd = join(root, "repo"); await mkdir(cwd);
  async function git(...args: string[]) { const child = Bun.spawn(["/usr/bin/git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, stdout: "pipe", stderr: "pipe" }); const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); if (code) throw new Error(err); return out.trim(); }
  await git("init", "-b", "main"); await writeFile(join(cwd, "a.txt"), "base\n"); await git("add", "--", "a.txt"); await git("commit", "-m", "fixture");
  const authorization: WorkspaceAuthorization = { authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), repository: cwd, baseCommit: await git("rev-parse", "HEAD"), excludeExistingDirty: false, autoSquashDelivery: true, nodes: [{ nodeId: "a", paths: ["a.txt"] }, { nodeId: "b", paths: ["a.txt"] }] };
  const manager = await WorkspaceManager.open(join(root, "state"), crypto.randomUUID());
  const workspaceId = crypto.randomUUID(), identity = { runId: crypto.randomUUID(), nodeId: "a", attempt: 1 };
  return { root, cwd, manager, workspaceId, authorization, identity };
}
test("最终交付拒绝锁/漂移，清理后仍可单父交付且关联失败重试不重复commit", async () => {
  const { manager, workspaceId, authorization, identity, cwd } = await fixture();
  const auth = { ...authorization, nodes: [authorization.nodes[0]] };
  const config = { version: 1 as const, authorization: auth, bindings: [{ nodeId: "a", workspaceId }] };
  const workspace = await manager.create(workspaceId, auth);
  await expect(manager.deliverSquash(identity.runId, { ...config, authorization: { ...auth, autoSquashDelivery: false } })).rejects.toThrow("授权未包含");
  await expect(manager.deliverSquash(identity.runId, config, ["a"])).rejects.toThrow("缺ready");
  await expect(manager.deliverSquash(identity.runId, config, ["unknown"])).rejects.toThrow("未授权");
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, identity), "group");
  await expect(manager.deliverSquash(identity.runId, config)).rejects.toThrow("锁");
  await writeFile(join(workspace.cwd, "a.txt"), "final\n");
  const saved = await manager.finish(lease, true, async () => true);
  await writeFile(join(workspace.cwd, "a.txt"), "drift\n");
  await expect(manager.deliverSquash(identity.runId, config)).rejects.toThrow("漂移");
  await writeFile(join(workspace.cwd, "a.txt"), "final\n");
  await manager.cleanup(workspaceId, true);
  const write = spyOn(manager as unknown as { write: (...args: unknown[]) => Promise<void> }, "write").mockRejectedValueOnce(new Error("delivery association failed"));
  try { await expect(manager.deliverSquash(identity.runId, config)).rejects.toThrow("association failed"); } finally { write.mockRestore(); }
  const result = await manager.deliverSquash(identity.runId, config);
  expect(result.sourceCommit).toBe(saved.commit);
  expect(await manager.deliverSquash(identity.runId, config)).toEqual(result);
  expect(await manager.inspectDelivery(identity.runId)).toEqual(result);
  await expect((await GitRepository.open(cwd)).inspect()).resolves.toMatchObject({ head: authorization.baseCommit });
});

test("多独立分支拒绝交付，真实多父集成后只交付完整tree", async () => {
  const { manager, authorization, identity, root, cwd } = await fixture();
  const auth = { ...authorization, nodes: [{ nodeId: "a", paths: ["a.txt"] }, { nodeId: "b", paths: ["b.txt"] }, { nodeId: "merge", paths: ["a.txt", "b.txt"] }] };
  const bindings = auth.nodes.map(node => ({ nodeId: node.nodeId, workspaceId: crypto.randomUUID() }));
  const config = { version: 1 as const, authorization: auth, bindings: bindings.map(binding => binding.nodeId === "merge" ? { ...binding, integrationSources: { nodeIds: ["a", "b"] } } : binding) };
  const commits: string[] = [];
  for (const binding of bindings) {
    const workspace = await manager.create(binding.workspaceId, { ...auth, nodes: auth.nodes.filter(node => node.nodeId === binding.nodeId) });
    if (binding.nodeId === "merge") continue;
    const lease = await manager.bindWriter(await manager.acquire(binding.workspaceId, { ...identity, nodeId: binding.nodeId }), "group");
    await writeFile(join(workspace.cwd, `${binding.nodeId}.txt`), binding.nodeId + "\n");
    commits.push((await manager.finish(lease, true, async () => true)).commit);
  }
  await expect(manager.deliverSquash(identity.runId, config)).rejects.toThrow("尚未完整显式集成");
  const merge = await manager.inspect(bindings[2].workspaceId);
  const lease = await manager.bindWriter(await manager.acquire(merge.workspaceId, { ...identity, nodeId: "merge" }, commits), "merge-group");
  await manager.createScratch(lease.leaseId); await mkdir(join(root, "state", "scratch", lease.leaseId, "objects"));
  const child = Bun.spawn(["/usr/bin/git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-commit", "--no-ff", ...commits], { cwd: merge.cwd, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(child.stderr).text(); expect(await child.exited, stderr).toBe(0);
  const merged = await manager.finish(lease, true, async () => true);
  const delivery = await manager.deliverSquash(identity.runId, config);
  expect(delivery.paths).toEqual(["a.txt", "b.txt"]);
  expect(delivery.sourceCommit).toBe(merged.commit);
  async function git(...args: string[]) { const p = Bun.spawn(["/usr/bin/git", ...args], { cwd, stdout: "pipe" }); const out = await new Response(p.stdout).text(); expect(await p.exited).toBe(0); return out.trim(); }
  expect(await git("show", "-s", "--format=%P", delivery.commit)).toBe(auth.baseCommit);
  expect(await git("rev-parse", `${delivery.commit}^{tree}`)).toBe(await git("rev-parse", `${merged.commit}^{tree}`));
  expect(await git("rev-list", "--count", `${auth.baseCommit}..${delivery.commit}`)).toBe("1");
});

test("partial不能自动最终交付，失败诊断耐久但不制造交付记录", async () => {
  const { manager, workspaceId, authorization, identity, root } = await fixture();
  const auth = { ...authorization, nodes: [authorization.nodes[0]] };
  const workspace = await manager.create(workspaceId, auth);
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, identity), "group");
  await writeFile(join(workspace.cwd, "a.txt"), "partial\n"); await manager.finish(lease, false, async () => true);
  await expect(manager.deliverSquash(identity.runId, { version: 1, authorization: auth, bindings: [{ nodeId: "a", workspaceId }] })).rejects.toThrow("partial");
  await manager.recordDeliveryDiagnostic(identity.runId, "partial");
  const reopened = await WorkspaceManager.open(join(root, "state"), crypto.randomUUID());
  expect(await reopened.inspectDelivery(identity.runId)).toBeNull();
  expect(await reopened.inspectDeliveryDiagnostic(identity.runId)).toBe("partial");
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
  const external = { ...authorization, nodes: [{ nodeId: "a", paths: ["a.txt"], externalResources: ["port:4173"] }] };
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
  await executor.stop(node);await executor.finalizePartial({...node,status:"cancelled"});expect((await manager.inspect(workspaceId)).results[0]).toMatchObject({ready:false,paths:["a.txt"]});
  expect((await manager.inspect(workspaceId)).lease).toBeNull();
},15_000);
test("清理只移除ready且干净的checkout，保留分支commit供后续集成核验",async()=>{
  const {manager,workspaceId,authorization,identity,cwd}=await fixture();const workspace=await manager.create(workspaceId,authorization);
  const lease=await manager.bindWriter(await manager.acquire(workspaceId,identity),"group");await writeFile(join(workspace.cwd,"a.txt"),"ready\n");const saved=await manager.finish(lease,true,async()=>true);
  await expect(manager.cleanup(workspaceId,false)).rejects.toThrow("明确授权");const cleaned=await manager.cleanup(workspaceId,true);expect(cleaned.cleanedAt).not.toBeNull();expect(await Bun.file(workspace.cwd).exists()).toBe(false);
  const repo=await GitRepository.open(cwd);await repo.verifyCommitObject(saved.commit,authorization.baseCommit,["a.txt"],["a.txt"]);expect(await Bun.file(join(cwd,"a.txt")).text()).toBe("base\n");
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
  const targetId = crypto.randomUUID(); const targetWorkspace = await manager.create(targetId, { ...authorization, nodes: [{ nodeId: "integrate", paths: ["a.txt"] }] });
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
