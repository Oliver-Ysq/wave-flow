import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessExecutionService } from "../../src/harness/executions";
import { HarnessJournal } from "../../src/harness/journal";
import { RunJournal } from "../../src/journal/run-journal";
import { HarnessService } from "../../src/harness/service";
import type { ResolvedHarnessModelConfig } from "../../src/harness/config";
import type { HarnessSession } from "../../src/harness/session";
import { DeterministicExecutor } from "../../src/runtime/deterministic-executor";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const model: ResolvedHarnessModelConfig = { model: "test-model", baseUrl: "http://127.0.0.1:9", apiKey: "test-key" };
const createPi = (): HarnessSession => { throw new Error("测试不创建真实 Pi 会话。 "); };

async function fixture(): Promise<{ harness: HarnessService; executions: HarnessExecutionService; harnessRunId: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-execution-"));
  directories.push(root);
  const harness = new HarnessService(root, async () => model, createPi);
  const executions = new HarnessExecutionService(harness, () => ({ executor: new DeterministicExecutor() }), {}, root);
  const created = await harness.create(root);
  return { harness, executions, harnessRunId: created.harnessRunId, root };
}

test("只读Execution现场仍检测Git文件内容变化；非Git明确缺基线而非伪造Git证据", async () => {
  const { harness, executions, harnessRunId, root } = await fixture();
  await harness.proposeWorkflowRevision(harnessRunId, SIMPLE_SOURCE);
  await harness.acceptWorkflowRevision(harnessRunId, 1);
  const created = await executions.createExecution(harnessRunId, 1, {}, testConfig());
  await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].finishedAt !== null);
  expect(await executions.sceneEvidence(harnessRunId, created.execution.executionId)).toMatchObject({ kind: "no-git-baseline" });
  for (const args of [["init", "-b", "main"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Initial fixture"]]) {
    const process = Bun.spawn(["/usr/bin/git", ...args], { cwd: root, stdout: "ignore", stderr: "pipe" });
    expect(await process.exited).toBe(0);
  }
  const before = await executions.sceneEvidence(harnessRunId, created.execution.executionId) as { project: { hash: string } };
  await (await import("node:fs/promises")).writeFile(join(root, "new.txt"), "one");
  const changed = await executions.sceneEvidence(harnessRunId, created.execution.executionId) as { project: { hash: string } };
  await (await import("node:fs/promises")).writeFile(join(root, "new.txt"), "two");
  const again = await executions.sceneEvidence(harnessRunId, created.execution.executionId) as { project: { hash: string } };
  expect(changed.project.hash).not.toBe(before.project.hash);
  expect(again.project.hash).not.toBe(changed.project.hash);
}, 15_000);

/** 测试冻结配置；服务层不核对 runtimeId 真实性（那是 Engine action 的职责）。 */
function testConfig(): import("../../src/harness/types").ExecutionConfigSnapshot {
  const assignment = (agentId: string): import("../../src/harness/types").WorkerAssignment => ({ agentId, cli: "codex", model: "cli-default", source: "harness-cli", runtimeId: "test-runtime", adapterId: "codex-acp", adapterVersion: "0.0.0-test" });
  return { version: 1, createdAt: new Date().toISOString(), fallbackRuntimeId: "test-runtime", ruleText: null, ruleDegraded: false, defaultAssignment: assignment("*"), assignments: [assignment("w1"), assignment("w2")] };
}

const SIMPLE_SOURCE = `const meta = { name: "exec-simple", description: "简单执行", phases: [{ title: "工作" }] };
async function run(args) {
  phase("工作");
  const done = await agent("完成任务", { id: "w1", cli: "codex" });
  return { ok: true, node: done.nodeId, note: args.note ?? null };
}`;

const GATE_SOURCE = `const meta = { name: "exec-gate", description: "带决策门", phases: [{ title: "工作" }] };
async function run(args) {
  phase("工作");
  await agent("第一阶段", { id: "w1", cli: "codex" });
  const answer = await decisionGate({ id: "confirm", question: "是否进入第二阶段？" });
  if (!answer.ok) throw new Error("用户拒绝");
  return agent("第二阶段", { id: "w2", cli: "codex" });
}`;

async function waitFor(condition: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("等待条件超时。 ");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("HarnessExecutionService", () => {
  test("写现场跨只读轮次仍保留证据，下次写入不能退回历史基准另起",async()=>{
    const root=await mkdtemp(join(tmpdir(),"wave-flow-inherited-scene-"));directories.push(root);let basis=0;
    const writeSource=SIMPLE_SOURCE.replace('cli: "codex"','cli: "codex", sandbox: "workspace-write"');
    const harness=new HarnessService(root,async(_id,_cwd,_prior,actions)=>({isRunning:false,subscribe:()=>()=>{},abort:()=>{},prompt:async(text)=>{
      if(text.startsWith("请总结"))return "完整总结，测试不证明外部副作用。";
      await actions.proposeWorkflowRevision(basis===1?SIMPLE_SOURCE:writeSource,"同目标继续","现场保留",undefined,basis++);return "方案";
    }}),undefined,async()=>({fingerprint:"injected-harness-session"}),true);
    const service=new HarnessExecutionService(harness,()=>({executor:new DeterministicExecutor()}),{},root);
    harness.setExecutionCapsuleReader((task,execution,attempt)=>service.capsuleEvidence(task,execution,attempt));harness.setExecutionSceneReader(async()=>({stable:true}));
    try{
      const task=await harness.startTask(root,{clientRequestId:crypto.randomUUID(),projectId:"p",text:"写任务"});
      await waitFor(async()=>(await harness.snapshot(task.harnessRunId)).status==="idle");await harness.acceptWorkflowRevision(task.harnessRunId,1);
      const config={...testConfig(),workspaces:{version:2 as const,authorization:{authorizationId:crypto.randomUUID(),approvedAt:new Date().toISOString(),repository:root,baseCommit:"a".repeat(40),excludeExistingDirty:false,nodes:[{nodeId:"w1"}]},bindings:[{nodeId:"w1",workspaceId:crypto.randomUUID()}]}};
      await service.createExecution(task.harnessRunId,1,{},config);
      await waitFor(async()=>(await harness.snapshot(task.harnessRunId)).impactSummaries?.[0]?.status==="completed");
      await harness.send(task.harnessRunId,"先只读复核");await waitFor(async()=>(await harness.snapshot(task.harnessRunId)).status==="idle");await harness.acceptWorkflowRevision(task.harnessRunId,2);
      const read=await service.createExecution(task.harnessRunId,2,{},testConfig(),{confirmationRequestId:crypto.randomUUID(),confirmationPayloadHash:"b".repeat(64),sceneEvidenceHash:(await harness.currentImpactEvidence(task.harnessRunId))!});
      await waitFor(async()=>(await harness.snapshot(task.harnessRunId)).impactSummaries?.some(item=>item.executionId===read.execution.executionId&&item.status==="completed")===true);
      // 引用受管现场丢失时必须拒绝证据读取，不能回退只读轮次的项目根固定证据。
      await expect(service.sceneEvidence(task.harnessRunId,read.execution.executionId)).rejects.toThrow();
      await harness.send(task.harnessRunId,"再次修正");await waitFor(async()=>(await harness.snapshot(task.harnessRunId)).status==="idle");await harness.acceptWorkflowRevision(task.harnessRunId,3);
      await expect(service.createExecution(task.harnessRunId,3,{},config,{confirmationRequestId:crypto.randomUUID(),confirmationPayloadHash:"c".repeat(64),sceneEvidenceHash:(await harness.currentImpactEvidence(task.harnessRunId))!})).rejects.toThrow("明确接续原受管现场");
      expect((await service.listExecutions(task.harnessRunId))).toHaveLength(2);
    }finally{harness.close();}
  });
  test("resume控制接线再次失败耐久中断，零业务投递且仍可显式恢复",async()=>{
    const {harness,harnessRunId,root}=await fixture();let broken=true,calls=0;
    const executions=new HarnessExecutionService(harness,()=>({executor:{execute:async()=>{calls++;return {nodeId:"w1"};}}}),{wireControl:()=>{if(broken)throw Error("control unavailable");}},root);
    await harness.proposeWorkflowRevision(harnessRunId,SIMPLE_SOURCE);await harness.acceptWorkflowRevision(harnessRunId,1);
    await expect(executions.createExecution(harnessRunId,1,{},testConfig())).rejects.toThrow("control unavailable");
    const id=(await executions.listExecutions(harnessRunId))[0].executionId;
    await expect(executions.resume(harnessRunId,id)).rejects.toThrow("control unavailable");
    expect((await executions.listExecutions(harnessRunId))[0]).toMatchObject({status:"interrupted",diagnostic:expect.stringContaining("恢复控制初始化失败")});
    expect(calls).toBe(0);expect(executions.isControllable(id)).toBe(false);
    broken=false;await executions.resume(harnessRunId,id);await waitFor(async()=>(await executions.listExecutions(harnessRunId))[0].status==="completed");expect(calls).toBe(1);
  });
  test("单链新版Execution零跨执行Replay，冻结确认现场且旧版只读恢复",async()=>{
    const root=await mkdtemp(join(tmpdir(),"wave-flow-revision-execution-"));directories.push(root);let basis=0,calls=0;
    const harness=new HarnessService(root,async(_id,_cwd,_prior,actions)=>({isRunning:false,subscribe:()=>()=>{},abort:()=>{},prompt:async(text)=>{
      if(text.startsWith("请总结"))return "完整说明，仅证明测试执行结果，不证明文件或外部副作用。";
      await actions.proposeWorkflowRevision(SIMPLE_SOURCE,"原目标修正","只读",undefined,basis++);return "修改方案保留现场";
    }}),undefined,async()=>({fingerprint:"injected-harness-session"}),true);
    const service=new HarnessExecutionService(harness,()=>({executor:{execute:async()=>{calls++;return {nodeId:"w1"};}}}),{},root);
    harness.setExecutionCapsuleReader((task,execution,attempt)=>service.capsuleEvidence(task,execution,attempt));
    harness.setExecutionSceneReader(async()=>({scene:"stable"}));
    try{
      const task=await harness.startTask(root,{clientRequestId:crypto.randomUUID(),projectId:"p",text:"首次只读"});
      await waitFor(async()=>(await harness.snapshot(task.harnessRunId)).status==="idle");await harness.acceptWorkflowRevision(task.harnessRunId,1);
      const first=await service.createExecution(task.harnessRunId,1,{},testConfig());
      await waitFor(async()=>(await harness.snapshot(task.harnessRunId)).impactSummaries?.[0]?.status==="completed");
      const original=(await service.listExecutions(task.harnessRunId))[0];
      const exposed=await harness.snapshot(task.harnessRunId);
      (exposed.workflowRevisions[0] as {source:string}).source="tampered";
      (exposed.executions[0].config!.assignments[0] as {cli:string}).cli="kimi";
      expect((await harness.snapshot(task.harnessRunId)).workflowRevisions[0].source).toBe(SIMPLE_SOURCE);
      expect((await harness.snapshot(task.harnessRunId)).executions[0].config!.assignments[0].cli).toBe("codex");
      await harness.send(task.harnessRunId,"不满意，请按原目标重新检查");await waitFor(async()=>(await harness.snapshot(task.harnessRunId)).status==="idle");
      await harness.acceptWorkflowRevision(task.harnessRunId,2);
      await expect(service.createExecution(task.harnessRunId,2,{},testConfig())).rejects.toThrow("明确确认");
      const hash=await harness.currentImpactEvidence(task.harnessRunId);
      const second=await service.createExecution(task.harnessRunId,2,{},testConfig(),{confirmationRequestId:crypto.randomUUID(),confirmationPayloadHash:"a".repeat(64),sceneEvidenceHash:hash!});
      await waitFor(async()=>(await harness.snapshot(task.harnessRunId)).impactSummaries?.some(item=>item.executionId===second.execution.executionId&&!item.supplementOf&&item.status==="completed")===true);
      expect(calls).toBe(2);expect(second.execution.executionId).not.toBe(first.execution.executionId);expect(second.execution.sourceHash).toBe(first.execution.sourceHash);
      expect((await service.snapshotExecution(task.harnessRunId,second.execution.executionId)).currentExecutionAttemptId).toBe(1);
      expect((await service.listExecutions(task.harnessRunId))[0]).toEqual(original);
      await expect(service.resume(task.harnessRunId,first.execution.executionId)).rejects.toThrow("旧执行只能查看历史");
      const reopened=await HarnessJournal.open(task.harnessRunId,root);expect(reopened.snapshot.executions).toHaveLength(2);expect(reopened.snapshot.executions[1].sceneEvidenceHash).toBe(hash!);
    }finally{harness.close();}
  });
  test("原completed成果补收尾失败不重开Execution、不派发第二Worker，错误可诊断", async () => {
    const {harness,harnessRunId,root}=await fixture();let calls=0,prepares=0;
    const config={...testConfig(),workspaces:{version:2 as const,authorization:{authorizationId:crypto.randomUUID(),approvedAt:new Date().toISOString(),repository:root,baseCommit:"a".repeat(40),excludeExistingDirty:false,nodes:[{nodeId:"w1"}]},bindings:[{nodeId:"w1",workspaceId:crypto.randomUUID()}]}};
    const service=new HarnessExecutionService(harness,()=>({executor:{execute:async()=>{calls++;return {ok:true};}}}),{prepareResume:async()=>{prepares++;throw Error("writer退出仍未知");}},root);
    await harness.proposeWorkflowRevision(harnessRunId,SIMPLE_SOURCE.replace('cli: "codex"','cli: "codex", sandbox: "workspace-write"'));await harness.acceptWorkflowRevision(harnessRunId,1);
    const {execution}=await service.createExecution(harnessRunId,1,{},config);
    await waitFor(async()=>(await service.listExecutions(harnessRunId))[0].finishedAt!==null);
    const prior=(await service.listExecutions(harnessRunId))[0];
    await expect(service.resume(harnessRunId,execution.executionId)).rejects.toThrow("writer退出仍未知");
    expect(calls).toBe(1);expect(prepares).toBe(1);expect((await service.listExecutions(harnessRunId))[0]).toEqual(prior);
    expect((await service.snapshotExecution(harnessRunId,execution.executionId)).currentExecutionAttemptId).toBe(1);
    await writeFile(join(root,harnessRunId,"executions",execution.executionId,"source.ts"),"changed source");
    await expect(service.resume(harnessRunId,execution.executionId)).rejects.toThrow("冻结源码快照与登记 hash 不一致");
    expect(prepares).toBe(1);expect(calls).toBe(1);
  });
  test("来源收尾在Worker收尾之后且终态发布之前运行，失败不丢失业务completed", async () => {
    const { harness, harnessRunId, root } = await fixture();
    let finalized = false, called = 0;
    const config = { ...testConfig(), workspaces: { version: 2 as const, authorization: { authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), repository: root, baseCommit: "a".repeat(40), excludeExistingDirty: false, nodes: [{ nodeId: "w1" }] }, bindings: [{ nodeId: "w1", workspaceId: crypto.randomUUID() }] } };
    const executions = new HarnessExecutionService(harness, () => ({ executor: { execute: async () => ({ ok: true }), finalizeCompleted: async () => { finalized = true; } } }), {
      finalizeSource: async (id, frozen) => {
        expect(finalized).toBe(true); expect(frozen).toEqual(config); called++;
        expect((await harness.snapshot(harnessRunId)).executions.find(item => item.executionId === id)?.finishedAt).toBeNull();
        throw new Error("模拟交付证据磁盘失败");
      },
    }, root);
    try {
      const source = SIMPLE_SOURCE.replace('cli: "codex"', 'cli: "codex", sandbox: "workspace-write"');
      await harness.proposeWorkflowRevision(harnessRunId, source); await harness.acceptWorkflowRevision(harnessRunId, 1);
      const { execution } = await executions.createExecution(harnessRunId, 1, {}, config);
      await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].finishedAt !== null);
      const record = (await executions.listExecutions(harnessRunId))[0];
      expect(record.status).toBe("completed"); expect(record.diagnostic).toContain("模拟交付证据磁盘失败"); expect(called).toBe(1);
      expect((await executions.snapshotExecution(harnessRunId, execution.executionId)).status).toBe("completed");
    } finally { harness.close(); }
  });
  test("控制初始化失败保留原Execution并收敛interrupted，不创建Worker",async()=>{
    const {harness,harnessRunId,root}=await fixture();let workers=0;
    const executions=new HarnessExecutionService(harness,()=>({executor:{execute:async()=>{workers++;return {};}}}),{wireControl:()=>{throw Error("接线失败");}},root);
    await harness.proposeWorkflowRevision(harnessRunId,SIMPLE_SOURCE);await harness.acceptWorkflowRevision(harnessRunId,1);
    await expect(executions.createExecution(harnessRunId,1,{},testConfig())).rejects.toThrow("接线失败");
    const records=await executions.listExecutions(harnessRunId);expect(records).toHaveLength(1);expect(records[0].status).toBe("interrupted");expect(workers).toBe(0);
    expect((await executions.snapshotExecution(harnessRunId,records[0].executionId)).status).toBe("interrupted");
  });
  test("已执行候选拒绝重复创建；新候选须显式准备且历史结果保持原身份", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-task-execution-")); directories.push(root);
    const harness = new HarnessService(root, async (_id,_cwd,_prior,actions) => ({ isRunning:false, subscribe:()=>()=>{}, abort:()=>{}, prompt:async(text)=> { if(text.startsWith("请总结"))return "执行完成，交付已保存，影响证据不足。";await actions.proposeWorkflowRevision(SIMPLE_SOURCE,"检查目标","只读"); return "方案已提出"; } }));
    const executions = new HarnessExecutionService(harness, () => ({ executor: new DeterministicExecutor() }), {}, root);
    harness.setExecutionCapsuleReader((task,execution,attempt)=>executions.capsuleEvidence(task,execution,attempt));
    const task = await harness.startTask(root, { clientRequestId:crypto.randomUUID(),projectId:"project",text:"验证启动资格" });
    await waitFor(async()=> (await harness.snapshot(task.harnessRunId)).status === "idle");
    await harness.acceptWorkflowRevision(task.harnessRunId, 1);
    const { execution: first } = await executions.createExecution(task.harnessRunId, 1, {}, testConfig());
    await waitFor(async()=> (await executions.snapshotExecution(task.harnessRunId,first.executionId)).status === "completed");
    await waitFor(async()=> (await harness.snapshot(task.harnessRunId)).impactSummaries?.[0]?.status==="completed");
    const before = await readdir(join(root,task.harnessRunId,"executions"));
    await expect(executions.createExecution(task.harnessRunId,1,{},testConfig())).rejects.toThrow("取代");
    expect(await readdir(join(root,task.harnessRunId,"executions"))).toEqual(before);
    expect((await harness.snapshot(task.harnessRunId)).executions).toHaveLength(1);
    const evidence=await executions.attemptResults(task.harnessRunId,first.executionId,1);
    expect(evidence.attempt).toBe(1);expect(evidence.nodes).toHaveLength(1);expect(evidence.summary).not.toBeNull();
    await expect(executions.attemptResults(task.harnessRunId,first.executionId,999)).rejects.toThrow("不存在");
    const unrelated=await harness.create(root);
    await expect(executions.snapshotExecution(unrelated.harnessRunId,first.executionId)).rejects.toThrow("未知");
    await expect(executions.attemptResults(unrelated.harnessRunId,first.executionId,1)).rejects.toThrow("未知");
  });
  test("退出后旧任务迟到收尾不能覆盖 resume 实例或释放其控制资源", async () => {
    const { harness, harnessRunId, root } = await fixture();
    let releaseOld!: () => void;
    const oldTail = new Promise<void>(resolve => { releaseOld = resolve; });
    let oldReturned!: () => void;
    const oldReturn = new Promise<void>(resolve => { oldReturned = resolve; });
    const runtimes: import("../../src/runtime/run-runtime").RunRuntime[] = [];
    const releases: number[] = [];
    const executions = new HarnessExecutionService(harness, () => ({ executor: new DeterministicExecutor() }), {
      wireControl(runtime) {
        runtimes.push(runtime);
        const instanceNumber = runtimes.length;
        const run = runtime.run.bind(runtime);
        // 只在测试中精确控制旧调用栈退场时机，不依赖 sleep 或机器负载撞竞态。
        if (instanceNumber === 1) runtime.run = async (...args) => {
          try { return await run(...args); }
          finally { await oldTail; oldReturned(); }
        };
        return () => { releases.push(instanceNumber); };
      },
    }, root);
    try {
      await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
      await harness.acceptWorkflowRevision(harnessRunId, 1);
      const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
      await waitFor(() => runtimes[0].snapshot().gates.length === 1);
      await executions.cancelForDesktopExit("test-exit");
      expect(releases).toEqual([1]);
      await executions.resume(harnessRunId, execution.executionId);
      releaseOld();
      await oldReturn;
      // 等待旧后台 promise 的 then/finally 执行完，且不让新回合提前完成。
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(releases).toEqual([1]);
      await expect(executions.answerGate(harnessRunId, execution.executionId, "confirm", { ok: true })).resolves.toBeDefined();
      await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].status === "completed");
      expect((await executions.snapshotExecution(harnessRunId, execution.executionId)).currentExecutionAttemptId).toBe(2);
      const reopened = await HarnessJournal.open(harnessRunId, root);
      expect(reopened.snapshot.executions[0].status).toBe("completed");
      expect(releases).toEqual([1, 2]);
    } finally { releaseOld(); }
  });
  test("草稿与未接受 revision 永远不能创建 Execution", async () => {
    const { harness, executions, harnessRunId } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, SIMPLE_SOURCE);
    await expect(executions.createExecution(harnessRunId, 1, {}, testConfig())).rejects.toThrow("草稿永远不能执行");
    await expect(executions.createExecution(harnessRunId, 99)).rejects.toThrow("revision 不存在");
    expect(await executions.listExecutions(harnessRunId)).toEqual([]);
  });

  test("不可编译脚本在提案时即被拒绝，不存在可创建 Execution 的 revision", async () => {
    const { harness, executions, harnessRunId } = await fixture();
    await expect(harness.proposeWorkflowRevision(harnessRunId, `const meta = { name: "bad", description: "坏脚本", phases: [{ title: "工作" }] };\nasync function run(args) { return process.cwd(); }`)).rejects.toThrow("未注入的标识符：process");
    expect((await harness.snapshot(harnessRunId)).workflowRevisions).toEqual([]);
    await expect(executions.createExecution(harnessRunId, 1, {}, testConfig())).rejects.toThrow("revision 不存在");
    expect(await executions.listExecutions(harnessRunId)).toEqual([]);
  });

  test("无配置快照的 Harness Execution 拒绝创建", async () => {
    const { harness, executions, harnessRunId } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, SIMPLE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    await expect(executions.createExecution(harnessRunId, 1)).rejects.toThrow("执行配置快照");
    expect(await executions.listExecutions(harnessRunId)).toEqual([]);
  });

  test("配置快照随登记耐久并在生效请求中改写 cli 与 assignedRuntimeId", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, SIMPLE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].finishedAt !== null);
    const reopened = await HarnessJournal.open(harnessRunId, root);
    expect(reopened.snapshot.executions[0].config).toMatchObject({ version: 1, fallbackRuntimeId: "test-runtime", ruleDegraded: false });
    // Journal 记录的是生效请求：脚本字面量 cli 被快照指派覆盖，assignedRuntimeId 进入指纹。
    const detail = await executions.snapshotExecution(harnessRunId, execution.executionId);
    expect(detail.phases[0].agents[0].request).toMatchObject({ id: "w1", cli: "codex", assignedRuntimeId: "test-runtime" });
  });

  test("接受冻结后创建 Execution，完成后登记终态与摘要", async () => {
    const { harness, executions, harnessRunId } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, SIMPLE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution, snapshot } = await executions.createExecution(harnessRunId, 1, { note: "来自用户" }, testConfig());
    expect(execution).toMatchObject({ revision: 1, status: "running", finishedAt: null });
    expect(snapshot.workflow.name).toBe("exec-simple");
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].finishedAt !== null);
    const [finished] = await executions.listExecutions(harnessRunId);
    expect(finished).toMatchObject({ status: "completed", summary: { ok: true, node: "w1", note: "来自用户" } });
    const detail = await executions.snapshotExecution(harnessRunId, execution.executionId);
    expect(detail.status).toBe("completed");
    expect(detail.phases[0].agents[0]).toMatchObject({ id: "w1", status: "completed" });
  });

  test("一个 Harness 顺序拥有多个 Execution：活跃期拒绝新执行", async () => {
    const { harness, executions, harnessRunId,root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    // 第一个 Execution 停在决策门上，未达终态。
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, execution.executionId)).gates.length === 1);
    expect(executions.attention(execution.executionId)).toEqual({workerRequests:0,scriptGates:1});
    const unrelated=await harness.create(root);
    await expect(executions.answerGate(unrelated.harnessRunId,execution.executionId,"confirm",{ok:true})).rejects.toThrow("未知");
    await expect(executions.stop(unrelated.harnessRunId,execution.executionId)).rejects.toThrow("不属于");
    expect((await executions.snapshotExecution(harnessRunId,execution.executionId)).gates[0].answer).toBeNull();
    await expect(executions.createExecution(harnessRunId, 1, {}, testConfig())).rejects.toThrow("未结束");
    await executions.answerGate(harnessRunId, execution.executionId, "confirm", { ok: true });
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].status === "completed");
    // 终态后新 revision 可以创建下一个 Execution。
    await harness.proposeWorkflowRevision(harnessRunId, SIMPLE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 2);
    const second = await executions.createExecution(harnessRunId, 2, {}, testConfig());
    expect(second.execution.revision).toBe(2);
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[1]?.status === "completed");
    expect((await executions.listExecutions(harnessRunId)).map((item) => item.status)).toEqual(["completed", "completed"]);
  });

  test("并发创建只登记首个 Execution，拒绝请求不会留下孤儿嵌套 Run", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const results = await Promise.allSettled([
      executions.createExecution(harnessRunId, 1, {}, testConfig()),
      executions.createExecution(harnessRunId, 1, {}, testConfig()),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(await executions.listExecutions(harnessRunId)).toHaveLength(1);
    expect(await readdir(join(root, harnessRunId, "executions"))).toHaveLength(1);
  });

  test("stop 是终态并拒绝 pending 决策门；离线 Execution 不可控制", async () => {
    const { harness, executions, harnessRunId } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, execution.executionId)).gates.length === 1);
    const stopped = await executions.stop(harnessRunId, execution.executionId);
    expect(stopped.status).toBe("cancelled");
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].status === "cancelled");
    await expect(executions.answerGate(harnessRunId, execution.executionId, "confirm", { ok: true })).rejects.toThrow("可控制生命周期");
  });

  test("退出与 settle 并发登记终态只写一条 execution_finished，Journal 可重开", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, execution.executionId)).gates.length === 1);
    // 退出路径与后台 settle 会同时尝试登记终态；第二条 execution_finished
    // 会让 Journal 重放永久失败，因此必须幂等。
    await executions.cancelForDesktopExit("exit-engine");
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].finishedAt !== null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const reopened = await HarnessJournal.open(harnessRunId, root);
    const finished = reopened.events.filter((event) => event.type === "workflow.execution_finished" && event.executionId === execution.executionId);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ status: "cancelled", diagnostic: "退出 Wave Flow 时停止。 " });
    expect(reopened.snapshot.executions[0]).toMatchObject({ status: "cancelled" });
  });

  test("recordExecutionFinished 对已终态 Execution 幂等，不产生重复事实", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, SIMPLE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].finishedAt !== null);
    await harness.recordExecutionFinished(harnessRunId, execution.executionId, "cancelled", "迟到的重复登记。 ", null);
    const reopened = await HarnessJournal.open(harnessRunId, root);
    const finished = reopened.events.filter((event) => event.type === "workflow.execution_finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ status: "completed" });
    expect(reopened.snapshot.executions[0]).toMatchObject({ status: "completed" });
  });

  test("blocked Worker 的 Execution 在退出时收敛为 cancelled 且可显式 resume", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, execution.executionId)).gates.length === 1);
    await executions.cancelForDesktopExit("exit-engine");
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].finishedAt !== null);
    expect((await executions.listExecutions(harnessRunId))[0].status).toBe("cancelled");
    await executions.resume(harnessRunId, execution.executionId);
    await executions.answerGate(harnessRunId, execution.executionId, "confirm", { ok: true });
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].status === "completed");
    expect((await executions.snapshotExecution(harnessRunId, execution.executionId)).currentExecutionAttemptId).toBe(2);
    const reopened = await HarnessJournal.open(harnessRunId, root);
    expect(reopened.snapshot.executions[0]).toMatchObject({ status: "completed" });
    const history=reopened.snapshot.executionHistory!;
    expect(history.filter(item=>item.kind==="finished").map(item=>item.status)).toEqual(["cancelled","completed"]);
    expect(history.find(item=>item.status==="cancelled")?.summary).toBeNull();
    expect(history.find(item=>item.status==="completed")?.attempt).toBe(2);
    expect((await executions.attemptResults(harnessRunId,execution.executionId,1)).status).toBe("cancelled");
    expect((await executions.attemptResults(harnessRunId,execution.executionId,2)).status).toBe("completed");
  });

  test("用户取消的 Execution 可显式 resume 为新 attempt", async () => {
    const { harness, executions, harnessRunId } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, execution.executionId)).gates.length === 1);
    await executions.stop(harnessRunId, execution.executionId);
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].status === "cancelled");
    await executions.resume(harnessRunId, execution.executionId);
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, execution.executionId)).currentExecutionAttemptId === 2);
    expect((await executions.snapshotExecution(harnessRunId, execution.executionId)).status).toBe("running");
    await executions.answerGate(harnessRunId, execution.executionId, "confirm", { ok: true });
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].status === "completed");
    expect((await executions.snapshotExecution(harnessRunId, execution.executionId)).currentExecutionAttemptId).toBe(2);
  });

  test("Engine 重启后只读还原登记事实，显式 resume 以新 attempt 继续未答 gate", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, execution.executionId)).gates.length === 1);

    // 模拟 Engine 重启：全新服务实例，没有任何内存 Runtime。
    let executions2Count = 0;
    const harness2 = new HarnessService(root, async () => model, createPi);
    const executions2 = new HarnessExecutionService(harness2, () => ({ executor: { execute: async () => { executions2Count += 1; return { n: executions2Count }; } } }), {}, root);
    const records = await executions2.listExecutions(harnessRunId);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("running");
    expect(executions2.isControllable(execution.executionId)).toBe(false);
    await expect(executions2.answerGate(harnessRunId, execution.executionId, "confirm", { ok: true })).rejects.toThrow("可控制生命周期");

    // 显式 resume：w1 复用 completed 结果，已创建的 gate 不重复落盘，等待原 gate 答案。
    const resumed = await executions2.resume(harnessRunId, execution.executionId);
    expect(resumed.status).toBe("running");
    expect(executions2.isControllable(execution.executionId)).toBe(true);
    await executions2.answerGate(harnessRunId, execution.executionId, "confirm", { ok: true });
    await waitFor(async () => (await executions2.listExecutions(harnessRunId))[0].status === "completed");
    const detail = await executions2.snapshotExecution(harnessRunId, execution.executionId);
    expect(detail.gates).toHaveLength(1);
    // w1 在尝试 #1 已完成并被复用；答题后新建的 w2 属于新尝试 #2。
    expect(detail.currentExecutionAttemptId).toBe(2);
    expect(executions2Count).toBe(1);
    expect(detail.phases[0].agents.map((agent) => `${agent.id}:${agent.status}`)).toEqual(["w2:completed"]);
  });

  test("Engine 重启时遗留的 active Execution 必须收敛为 interrupted，不能伪装为工作中", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, execution.executionId)).gates.length === 1);

    const restartedHarness = new HarnessService(root, async () => model, createPi);
    const restarted = new HarnessExecutionService(restartedHarness, () => ({ executor: new DeterministicExecutor() }), {}, root);
    await restarted.convergeStaleExecutions(harnessRunId);
    await expect(restarted.listExecutions(harnessRunId)).resolves.toMatchObject([
      { executionId: execution.executionId, status: "interrupted", finishedAt: expect.any(String), diagnostic: expect.stringContaining("不可跨进程认领") },
    ]);
    await expect(restarted.snapshotExecution(harnessRunId, execution.executionId)).resolves.toMatchObject({ status: "interrupted" });
    const detail = await restarted.snapshotExecution(harnessRunId, execution.executionId);
    expect(detail.phases.flatMap((phase) => phase.agents)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "w1", status: "completed" }),
    ]));
    expect(detail.phases.flatMap((phase) => phase.agents).every((node) => node.status !== "running" && node.status !== "blocked")).toBe(true);
  });

  test("重启收敛为 interrupted 后，用户仍可显式 resume 创建新 attempt", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, execution.executionId)).gates.length === 1);

    let resumedNodes = 0;
    const restartedHarness = new HarnessService(root, async () => model, createPi);
    const restarted = new HarnessExecutionService(restartedHarness, () => ({ executor: { execute: async () => ({ n: ++resumedNodes }) } }), {}, root);
    await restarted.convergeStaleExecutions(harnessRunId);
    // interrupted 的 running 事实由首个重放节点通过调用指纹校验后才写入；resume
    // 返回时可以仍是 interrupted，但后台重放必须实际创建 attempt #2。
    await expect(restarted.resume(harnessRunId, execution.executionId)).resolves.toMatchObject({ status: "interrupted", currentExecutionAttemptId: 1 });
    await restarted.answerGate(harnessRunId, execution.executionId, "confirm", { ok: true });
    await waitFor(async () => (await restarted.listExecutions(harnessRunId))[0].status === "completed");
    const detail = await restarted.snapshotExecution(harnessRunId, execution.executionId);
    expect(detail.currentExecutionAttemptId).toBe(2);
    expect(resumedNodes).toBe(1);

    // 跨 attempt 聚合读取：两个 attempt 的 Phase 访问都按（attempt, visitId）稳定可见，
    // 供 UI 补齐"历史访问已交付、本次 replay 复用"的 Phase → Agent 关系。
    const all = await restarted.listExecutionPhaseVisits(harnessRunId, execution.executionId);
    expect(all.items.map((item) => [item.executionAttemptId, item.title])).toEqual([[1, "工作"], [2, "工作"]]);
    expect(all.items[0].batches.flatMap((batch) => batch.agents).map((agent) => `${agent.id}:${agent.status}`)).toEqual(["w1:completed"]);
    expect(all.items[1].batches.flatMap((batch) => batch.agents).map((agent) => `${agent.id}:${agent.status}`)).toEqual(["w2:completed"]);
    await expect(restarted.listExecutionPhaseVisits(harnessRunId, execution.executionId, { attempt: 99 })).rejects.toThrow("指定执行尝试不存在");
    await expect(restarted.listExecutionPhaseVisits(harnessRunId, execution.executionId, { attempt: 1 })).resolves.toMatchObject({ items: [{ executionAttemptId: 1 }], nextCursor: null });
  });

  test("损坏的嵌套 Execution 不阻止后续 active Execution 在重启时收敛", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, SIMPLE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const first = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].status === "completed");
    await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 2);
    const second = await executions.createExecution(harnessRunId, 2, {}, testConfig());
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, second.execution.executionId)).gates.length === 1);
    await Bun.write(join(root, harnessRunId, "executions", first.execution.executionId, "manifest.json"), "{}\n");

    const restartedHarness = new HarnessService(root, async () => model, createPi);
    const restarted = new HarnessExecutionService(restartedHarness, () => ({ executor: new DeterministicExecutor() }), {}, root);
    await restarted.convergeStaleExecutions(harnessRunId);
    await expect(restarted.listExecutions(harnessRunId)).resolves.toMatchObject([
      { executionId: first.execution.executionId, status: "completed" },
      { executionId: second.execution.executionId, status: "interrupted", finishedAt: expect.any(String) },
    ]);
  });

  test("升级时为已中断 Execution 补齐遗留 active 节点，不改写其终态", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, execution.executionId)).gates.length === 1);

    // 模拟旧版本只写顶层 run.status，却漏掉旧 ACP 节点收敛的历史档案。
    const oldRuntime = await executions.snapshotExecution(harnessRunId, execution.executionId);
    const journalPath = join(root, harnessRunId, "executions", execution.executionId, "journal.jsonl");
    await Bun.write(journalPath, `${await Bun.file(journalPath).text()}${JSON.stringify({ type: "run.status", at: new Date().toISOString(), runId: execution.executionId, nodeId: null, agentSessionId: null, diagnostic: "旧版本中断", status: "interrupted" })}\n`);
    expect(oldRuntime.status).toBe("running");

    const restartedHarness = new HarnessService(root, async () => model, createPi);
    const restarted = new HarnessExecutionService(restartedHarness, () => ({ executor: new DeterministicExecutor() }), {}, root);
    await restarted.convergeStaleExecutions(harnessRunId);
    const detail = await restarted.snapshotExecution(harnessRunId, execution.executionId);
    expect(detail.status).toBe("interrupted");
    expect(detail.phases.flatMap((phase) => phase.agents)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "w1", status: "completed" }),
    ]));
    expect(detail.phases.flatMap((phase) => phase.agents).every((node) => node.status !== "running" && node.status !== "blocked")).toBe(true);
  });

  test("Execution 档案嵌套在 Harness 档案内并携带 harness 来源绑定", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, SIMPLE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].finishedAt !== null);
    const manifest = JSON.parse(await Bun.file(join(root, harnessRunId, "executions", execution.executionId, "manifest.json")).text()) as { harness?: { harnessRunId: string; revision: number; sourceHash: string } };
    expect(manifest.harness).toMatchObject({ harnessRunId, revision: 1, sourceHash: execution.sourceHash });
    const source = await Bun.file(join(root, harnessRunId, "executions", execution.executionId, "source.ts")).text();
    expect(source).toBe(SIMPLE_SOURCE);
  });

  test("旧档案遗留 blocked 节点 + 终态 Run：显式 resume 先收敛节点再创建新 attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-execution-"));
    directories.push(root);
    const harness = new HarnessService(root, async () => model, createPi);
    const created = await harness.create(root);
    const harnessRunId = created.harnessRunId;
    // 第一份 Engine：Worker 请求人工确认进入 blocked 后永不返回（真实故障中它以
    // end_turn 结束回合且不上报 complete/continue）。
    let control: import("../../src/control/control-server").ControlServer | null = null;
    let runtimeRef: import("../../src/runtime/run-runtime").RunRuntime | null = null;
    const executions = new HarnessExecutionService(harness, () => ({
      executor: {
        execute: async (node) => {
          const runId = runtimeRef!.snapshot().id;
          control!.register({ runId, nodeId: node.id, agentSessionId: node.agentSessionId!, capability: "cap-1" });
          await control!.recordSession({ runId, nodeId: node.id, agentSessionId: node.agentSessionId!, delivery: "acp", acp: { launcherId: "test", sessionId: "s", capabilities: {} } });
          void control!.block({ runId, nodeId: node.id, agentSessionId: node.agentSessionId!, capability: "cap-1", blockRequestId: crypto.randomUUID(), needHelp: "需要确认" }).then(() => null, () => null);
          return new Promise<never>(() => {});
        },
      },
    }), { wireControl: (runtime) => { runtimeRef = runtime; control = runtime.createControlServer(); } }, root);
    await harness.proposeWorkflowRevision(harnessRunId, SIMPLE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, execution.executionId)).phases[0]?.agents[0]?.status === "blocked");

    // 模拟旧版本缺陷留下的损坏档案：只写 Run 终态，漏掉 blocked 节点的收敛。
    const journalPath = join(root, harnessRunId, "executions", execution.executionId, "journal.jsonl");
    await Bun.write(journalPath, `${await Bun.file(journalPath).text()}${JSON.stringify({ type: "run.status", at: new Date().toISOString(), runId: execution.executionId, nodeId: null, agentSessionId: null, diagnostic: "Error: ACP Worker turn 已结束（end_turn），但未收到 wave-flow complete。", status: "interrupted" })}\n`);
    await harness.recordExecutionFinished(harnessRunId, execution.executionId, "interrupted", "Error: ACP Worker turn 已结束（end_turn），但未收到 wave-flow complete。", null);

    // 全新 Engine（不做启动收敛），直接显式 resume：必须先收敛僵尸 blocked 节点，
    // 再由 replay 创建新 attempt 重跑，而不是 2ms 内以旧诊断再次 finished。
    let executed = 0;
    const harness2 = new HarnessService(root, async () => model, createPi);
    const executions2 = new HarnessExecutionService(harness2, () => ({ executor: { execute: async () => ({ n: ++executed }) } }), {}, root);
    await executions2.resume(harnessRunId, execution.executionId);
    await waitFor(async () => (await executions2.listExecutions(harnessRunId))[0].status === "completed");
    const detail = await executions2.snapshotExecution(harnessRunId, execution.executionId);
    expect(detail).toMatchObject({ status: "completed", currentExecutionAttemptId: 2 });
    expect(detail.phases[0].agents).toEqual([expect.objectContaining({ id: "w1", status: "completed", result: { n: 1 } })]);
    expect(executed).toBe(1);
    const reopened = await RunJournal.open(execution.executionId, join(root, harnessRunId, "executions"));
    const staleConverged = reopened.events.findIndex((event) => event.type === "agent.status" && event.status === "interrupted" && event.diagnostic?.includes("不可认领"));
    const restarted = reopened.events.findIndex((event) => event.type === "agent.restarted");
    expect(staleConverged).toBeGreaterThanOrEqual(0);
    expect(restarted).toBeGreaterThan(staleConverged);
    expect(reopened.events.some((event) => event.type === "execution-attempt.started" && event.executionAttemptId === 2)).toBe(true);
    const outer = await HarnessJournal.open(harnessRunId, root);
    expect(outer.events.some((event) => event.type === "workflow.execution_resumed" && event.executionId === execution.executionId)).toBe(true);
    const finished = outer.events.filter((event) => event.type === "workflow.execution_finished" && event.executionId === execution.executionId);
    expect(finished.map((event) => (event as { readonly status: string }).status)).toEqual(["interrupted", "completed"]);
  });
});
