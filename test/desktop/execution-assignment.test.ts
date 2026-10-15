import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopExecutionEngine } from "../../src/desktop/desktop-execution-engine";
import type { HarnessSession } from "../../src/harness/session";
import type { ExecutionConfigSnapshot, WorkerAssignment } from "../../src/harness/types";
import { CliRuntimeRegistry } from "../../src/runtimes/registry";
import { verifyExecutable } from "../../src/runtimes/identity";
import type { CliRuntimeRecord } from "../../src/runtimes/types";
import type { ExecutionPlanResponse } from "../../src/desktop/types";
import { HarnessService } from "../../src/harness/service";
import { DeterministicHarnessSession } from "../../src/harness/deterministic-session";
const fixtureServices = new Map<string, HarnessService>();
const fixtureOptions = new Map<string, ConstructorParameters<typeof DesktopExecutionEngine>[0]>();

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const SOURCE = `const meta = { name: "assign-demo", description: "分配演示", phases: [{ title: "工作" }] };
async function run(args) {
  phase("工作");
  const a = await agent("甲", { id: "w1", cli: "codex" });
  const b = await agent("乙", { id: "w2", cli: "kimi" });
  return { a, b };
}`;

async function runtimeRecord(root: string, name: string, cli: "codex" | "kimi", harnessTools: boolean): Promise<CliRuntimeRecord> {
  const executablePath = join(root, name); await writeFile(executablePath, `#!/bin/sh\necho ${name}\n`, { mode: 0o700 }); await chmod(executablePath, 0o700);
  const executable = await verifyExecutable(executablePath);
  return { runtimeId: crypto.randomUUID(), cli, executablePath: executable.executablePath, executableIdentity: executable.identity, version: `${name} 1.0`, discoveredFrom: "manual", discoveredShell: null, verifiedAdapter: { adapterId: cli === "kimi" ? "kimi-acp" : "codex-acp", adapterVersion: "1.0", acpProtocolVersion: 1, harnessTools }, verifiedAt: new Date().toISOString(), status: "verified", diagnostic: null };
}

async function fixture(session?: HarnessSession): Promise<{ engine: DesktopExecutionEngine; harnessRunId: string; kimi: CliRuntimeRecord; codex: CliRuntimeRecord }> {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-assignment-")); roots.push(root);
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-assignment-project-")); roots.push(cwd);
  const registry = new CliRuntimeRegistry(root);
  const kimi = await registry.saveVerified(await runtimeRecord(root, "kimi", "kimi", true));
  const codex = await registry.saveVerified(await runtimeRecord(root, "codex", "codex", false));
  await registry.select(kimi.runtimeId);
  const engine = new DesktopExecutionEngine({ storeRoot: join(root, "runs"), harnessRoot: join(root, "harness-runs"), deterministicForTest: true, ...(session ? { createHarnessSession: async () => session } : {}) });
  const project = await engine.handleDesktopAction("projects.create", { cwd }) as { project: { projectId: string } };
  const harness = await engine.handleDesktopAction("harnesses.create", { projectId: project.project.projectId }) as { harness: { harnessRunId: string } };
  const journal = await import("../../src/harness/journal");
  const sourceHash = (await import("node:crypto")).createHash("sha256").update(SOURCE).digest("hex");
  const existing = await journal.HarnessJournal.open(harness.harness.harnessRunId, join(root,"harness-runs"));
  await existing.journal.append({ type:"workflow.revision_proposed",at:new Date().toISOString(),harnessRunId:harness.harness.harnessRunId,revision:{revision:1,source:SOURCE,sourceHash,createdAt:new Date().toISOString(),acceptedAt:null} });
  // Fixture 通过已耐久档案重建新 Engine；生产删除手工源码 action，不能用它建测试状态。
  engine.shutdown();
  const loaded = new DesktopExecutionEngine({storeRoot:join(root,"runs"),harnessRoot:join(root,"harness-runs"),deterministicForTest:true,...(session ? {createHarnessSession:async()=>session}: {})});
  fixtureServices.set(harness.harness.harnessRunId, new HarnessService(join(root,"harness-runs"),async()=>new DeterministicHarnessSession()));
  fixtureOptions.set(harness.harness.harnessRunId, {storeRoot:join(root,"runs"),harnessRoot:join(root,"harness-runs"),deterministicForTest:true});
  await loaded.handleDesktopAction("harnesses.acceptRevision", { harnessRunId: harness.harness.harnessRunId, revision: 1 });
  return { engine: loaded, harnessRunId: harness.harness.harnessRunId, kimi, codex };
}

function configOf(kimi: CliRuntimeRecord, codex: CliRuntimeRecord, overrides: Partial<ExecutionConfigSnapshot> = {}): ExecutionConfigSnapshot {
  const assignment = (agentId: string, runtime: CliRuntimeRecord): WorkerAssignment => ({ agentId, cli: runtime.cli, model: "cli-default", source: "harness-cli", runtimeId: runtime.runtimeId, adapterId: runtime.verifiedAdapter.adapterId, adapterVersion: runtime.verifiedAdapter.adapterVersion });
  return { version: 1, createdAt: new Date().toISOString(), fallbackRuntimeId: kimi.runtimeId, ruleText: null, ruleDegraded: false, defaultAssignment: assignment("*", kimi), assignments: [assignment("w1", kimi), assignment("w2", kimi)], ...overrides };
}

describe("Engine executions.plan / randomize / create 校验", () => {
  test("自动编排Task的旧版/放弃版本在直接IPC均拒绝，不创建Execution",async()=>{
    const {engine:harnessEngine,harnessRunId,kimi,codex}=await fixture();
    const options=fixtureOptions.get(harnessRunId) as Exclude<ConstructorParameters<typeof DesktopExecutionEngine>[0],boolean|undefined>;
    const root=await mkdtemp(join(tmpdir(),"wave-flow-task-ipc-"));roots.push(root);
    const registry=new CliRuntimeRegistry(root);await registry.saveVerified(kimi);await registry.saveVerified(codex);await registry.select(kimi.runtimeId);
    const optionsTask={...options,harnessRoot:join(root,"tasks"),createHarnessSession:async(_id:string,_cwd:string,_prior:readonly import("../../src/harness/types").HarnessMessage[],actions:import("../../src/harness/action-tools").HarnessActionCallbacks)=>({isRunning:false,subscribe:()=>()=>{},abort:()=>{},prompt:async()=>{await actions.proposeWorkflowRevision(SOURCE,"目标","只读范围");return "方案已提交";}})};
    const engine=new DesktopExecutionEngine(optionsTask);
    try{
      const project=await engine.handleDesktopAction("projects.create",{cwd:root}) as {project:{projectId:string}};
      const args={projectId:project.project.projectId,clientRequestId:crypto.randomUUID(),text:"创建任务"};
      await expect(engine.handleDesktopAction("harnesses.startConversation",{projectId:args.projectId,text:args.text})).rejects.toThrow("UUID");
      const created=await engine.handleDesktopAction("harnesses.startConversation",args) as {harness:{harnessRunId:string}};
      const id=created.harness.harnessRunId;
      for(let n=0;n<100;n++){const snapshot=await engine.handleDesktopAction("harnesses.get",{harnessRunId:id}) as {harness:{status:string}};if(snapshot.harness.status==="idle")break;await Bun.sleep(5);}
      await engine.handleDesktopAction("harnesses.acceptRevision",{harnessRunId:id,revision:1});
      await engine.handleDesktopAction("harnesses.send",{harnessRunId:id,text:"修改"});
      for(let n=0;n<100;n++){const snapshot=await engine.handleDesktopAction("harnesses.get",{harnessRunId:id}) as {harness:{status:string}};if(snapshot.harness.status==="idle")break;await Bun.sleep(5);}
      await expect(engine.handleDesktopAction("executions.plan",{harnessRunId:id,revision:1})).rejects.toThrow("取代");
      await expect(engine.handleDesktopAction("executions.create",{harnessRunId:id,revision:1,config:configOf(kimi,codex)})).rejects.toThrow();
      const snapshot=await engine.handleDesktopAction("harnesses.get",{harnessRunId:id}) as {harness:import("../../src/harness/types").HarnessSnapshot};
      const card=snapshot.harness.workflowRevisions.at(-1)!.cardId!;
      await engine.handleDesktopAction("harnesses.abandonCard",{harnessRunId:id,cardId:card});
      await expect(engine.handleDesktopAction("executions.create",{harnessRunId:id,revision:2,config:configOf(kimi,codex)})).rejects.toThrow();
      const list=await engine.handleDesktopAction("executions.list",{harnessRunId:id}) as {executions:unknown[]};expect(list.executions).toHaveLength(0);
      await expect(engine.handleDesktopAction("harnesses.proposeRevision",{harnessRunId:id,source:SOURCE})).rejects.toThrow("未知");
      await engine.handleDesktopAction("harnesses.send",{harnessRunId:id,text:"重新准备首份"});
      for(let n=0;n<100;n++){const snapshot=await engine.handleDesktopAction("harnesses.get",{harnessRunId:id}) as {harness:{status:string}};if(snapshot.harness.status==="idle")break;await Bun.sleep(5);}
      await engine.handleDesktopAction("harnesses.acceptRevision",{harnessRunId:id,revision:3});
      const createdExecution=await engine.handleDesktopAction("executions.create",{harnessRunId:id,revision:3,config:configOf(kimi,codex)}) as {execution:{executionId:string}};
      for(let n=0;n<100;n++){const snapshot=await engine.handleDesktopAction("executions.get",{harnessRunId:id,executionId:createdExecution.execution.executionId}) as {snapshot:{status:string}};if(snapshot.snapshot.status==="completed")break;await Bun.sleep(5);}
      await expect(engine.handleDesktopAction("executions.plan",{harnessRunId:id,revision:3})).rejects.toThrow("多轮");
      await expect(engine.handleDesktopAction("executions.create",{harnessRunId:id,revision:3,config:configOf(kimi,codex)})).rejects.toThrow("多轮");
      expect((await engine.handleDesktopAction("executions.list",{harnessRunId:id}) as {executions:unknown[]}).executions).toHaveLength(1);
    }finally{engine.shutdown();harnessEngine.shutdown();}
  });
  test("plan 枚举字面量 Worker、已验证池与主控 Runtime，并标注动态 id 数量", async () => {
    const { engine, harnessRunId, kimi, codex } = await fixture();
    try {
      const plan = await engine.handleDesktopAction("executions.plan", { harnessRunId, revision: 1 }) as ExecutionPlanResponse;
      expect(plan.workers.map((worker) => worker.id)).toEqual(["w1", "w2"]);
      expect(plan.phaseTitles).toEqual(["工作"]);
      expect(plan.workers.map((worker) => worker.phaseTitle)).toEqual(["工作", "工作"]);
      expect(plan.previewAgents.map((agent) => [agent.name, agent.phaseTitle])).toEqual([["w1", "工作"], ["w2", "工作"]]);
      expect(plan.dynamicCount).toBe(0);
      expect(plan.pool.map((runtime) => runtime.runtimeId).sort()).toEqual([kimi.runtimeId, codex.runtimeId].sort());
      expect(plan.harnessRuntime?.runtimeId).toBe(kimi.runtimeId);
      // 草稿或不存在 revision 拒绝规划。
      await expect(engine.handleDesktopAction("executions.plan", { harnessRunId, revision: 99 })).rejects.toMatchObject({ status: 400 });
    } finally { engine.shutdown(); }
  });

  test("预览用完整校验 meta，不受引号或长源码干扰，且不创建 Execution", async () => {
    const { engine, harnessRunId } = await fixture();
    try {
      const source = `const meta = { name: 'preview-literals', description: '${"x".repeat(2200)}', phases: [{ title: '分析' }, { title: '验证' }] };
async function run(args) {
  phase('验证');
  await agent('只读验证', { id: 'verify', cli: 'kimi' });
  return {};
}`;
      const author = fixtureServices.get(harnessRunId)!;
      await expect(engine.handleDesktopAction("harnesses.proposeRevision", { harnessRunId, source })).rejects.toThrow("未知 Desktop action");
      await author.proposeWorkflowRevision(harnessRunId, source);
      engine.shutdown();
      const reopened = new DesktopExecutionEngine(fixtureOptions.get(harnessRunId));
      try {
        await expect(reopened.handleDesktopAction("executions.plan", { harnessRunId, revision: 2 })).rejects.toMatchObject({status:400});
        await reopened.handleDesktopAction("harnesses.acceptRevision", {harnessRunId, revision:2});
        const plan = await reopened.handleDesktopAction("executions.plan", {harnessRunId, revision:2}) as ExecutionPlanResponse;
        expect(plan.phaseTitles).toEqual(["分析", "验证"]);
        expect(plan.workers).toMatchObject([{id:"verify",phaseTitle:"验证"}]);
        expect(plan.previewAgents).toMatchObject([{name:"verify",phaseTitle:"验证",cli:"kimi"}]);
        expect(await reopened.handleDesktopAction("executions.list", {harnessRunId})).toMatchObject({executions:[]});
      } finally { reopened.shutdown(); }
    } finally { engine.shutdown(); }
  });

  test("randomize 覆盖全部枚举 Worker 且来源为 random，兜底落主控 Runtime", async () => {
    const { engine, harnessRunId, kimi } = await fixture();
    try {
      const result = await engine.handleDesktopAction("executions.randomize", { harnessRunId, revision: 1 }) as { assignments: WorkerAssignment[]; defaultAssignment: WorkerAssignment };
      expect(result.assignments.map((item) => item.agentId).sort()).toEqual(["w1", "w2"]);
      expect(result.assignments.every((item) => item.source === "random" && item.model === "cli-default")).toBe(true);
      expect(result.defaultAssignment.runtimeId).toBe(kimi.runtimeId);
    } finally { engine.shutdown(); }
  });

  test("无 config 或伪造 config 的 Harness Execution 一律拒绝创建", async () => {
    const { engine, harnessRunId, kimi, codex } = await fixture();
    try {
      await expect(engine.handleDesktopAction("executions.create", { harnessRunId, revision: 1 })).rejects.toMatchObject({ status: 400 });
      // 未知 runtimeId
      await expect(engine.handleDesktopAction("executions.create", { harnessRunId, revision: 1, config: configOf(kimi, codex, { assignments: [{ agentId: "w1", cli: "kimi", model: "cli-default", source: "random", runtimeId: crypto.randomUUID(), adapterId: "kimi-acp", adapterVersion: "1.0" }] }) })).rejects.toMatchObject({ status: 400 });
      // cli 与 Runtime 记录不一致
      await expect(engine.handleDesktopAction("executions.create", { harnessRunId, revision: 1, config: configOf(kimi, codex, { assignments: [{ agentId: "w1", cli: "codex", model: "cli-default", source: "random", runtimeId: kimi.runtimeId, adapterId: "kimi-acp", adapterVersion: "1.0" }] }) })).rejects.toMatchObject({ status: 400 });
      // 未枚举的 Worker id
      await expect(engine.handleDesktopAction("executions.create", { harnessRunId, revision: 1, config: configOf(kimi, codex, { assignments: [{ agentId: "ghost", cli: "kimi", model: "cli-default", source: "random", runtimeId: kimi.runtimeId, adapterId: "kimi-acp", adapterVersion: "1.0" }] }) })).rejects.toMatchObject({ status: 400 });
      // 模型覆盖本期不允许
      await expect(engine.handleDesktopAction("executions.create", { harnessRunId, revision: 1, config: configOf(kimi, codex, { assignments: [{ agentId: "w1", cli: "kimi", model: "k2" as never, source: "random", runtimeId: kimi.runtimeId, adapterId: "kimi-acp", adapterVersion: "1.0" }] }) })).rejects.toMatchObject({ status: 400 });
      // 回退目标必须是当前主控 Runtime
      await expect(engine.handleDesktopAction("executions.create", { harnessRunId, revision: 1, config: configOf(kimi, codex, { fallbackRuntimeId: codex.runtimeId }) })).rejects.toMatchObject({ status: 400 });
      const listed = await engine.handleDesktopAction("executions.list", { harnessRunId }) as { executions: unknown[] };
      expect(listed.executions).toHaveLength(0);
    } finally { engine.shutdown(); }
  });

  test("合法 config 创建 Execution：快照冻结进登记，节点按指派改写 cli", async () => {
    const { engine, harnessRunId, kimi, codex } = await fixture();
    try {
      const config = configOf(kimi, codex, { assignments: [
        { agentId: "w1", cli: codex.cli, model: "cli-default", source: "rule", runtimeId: codex.runtimeId, adapterId: "codex-acp", adapterVersion: "1.0" },
        { agentId: "w2", cli: kimi.cli, model: "cli-default", source: "rule", runtimeId: kimi.runtimeId, adapterId: "kimi-acp", adapterVersion: "1.0" },
      ], ruleText: "甲用 codex，乙用 kimi" });
      const created = await engine.handleDesktopAction("executions.create", { harnessRunId, revision: 1, config }) as { execution: { executionId: string; config: ExecutionConfigSnapshot }; snapshot: { status: string; phases: { agents: { id: string; cli: string; request: { assignedRuntimeId?: string } }[] }[] } };
      expect(created.execution.config.fallbackRuntimeId).toBe(kimi.runtimeId);
      // 节点由后台任务调度；等执行到达终态后再核对生效请求。
      let detail = created;
      for (let attempt = 0; attempt < 200 && detail.snapshot.status === "running"; attempt += 1) {
        await Bun.sleep(10);
        detail = await engine.handleDesktopAction("executions.get", { harnessRunId, executionId: created.execution.executionId }) as typeof detail;
      }
      const agents = detail.snapshot.phases[0].agents;
      expect(agents.find((node) => node.id === "w1")).toMatchObject({ cli: "codex", request: { assignedRuntimeId: codex.runtimeId } });
      expect(agents.find((node) => node.id === "w2")).toMatchObject({ cli: "kimi", request: { assignedRuntimeId: kimi.runtimeId } });
      // 登记事实重读后仍携带同一冻结快照。
      const listed = await engine.handleDesktopAction("executions.list", { harnessRunId }) as { executions: { config?: ExecutionConfigSnapshot }[] };
      expect(listed.executions[0].config?.ruleText).toBe("甲用 codex，乙用 kimi");
    } finally { engine.shutdown(); }
  });
});

describe("Engine executions.parseRule 主控普通回合解析", () => {
  test("合法 ```json 回复解析为指派；噪声回复显式 degraded", async () => {
    const session: HarnessSession = {
      isRunning: false,
      subscribe: () => () => {},
      abort: () => {},
      prompt: async () => "好的，分配如下：\n```json\n{ \"assignments\": [{ \"agentId\": \"w1\", \"cli\": \"codex\" }] }\n```",
    };
    const { engine, harnessRunId, codex } = await fixture(session);
    try {
      const parsed = await engine.handleDesktopAction("executions.parseRule", { harnessRunId, revision: 1, ruleText: "甲用 codex" }) as { degraded: boolean; assignments: WorkerAssignment[] | null };
      expect(parsed.degraded).toBe(false);
      expect(parsed.assignments).toEqual([{ agentId: "w1", cli: "codex", model: "cli-default", source: "rule", runtimeId: codex.runtimeId, adapterId: "codex-acp", adapterVersion: "1.0" }]);
    } finally { engine.shutdown(); }

    // 确定性回声会话不产出 ```json 围栏：必须 degraded，绝不静默猜测。
    const noisy = await fixture();
    try {
      const degraded = await noisy.engine.handleDesktopAction("executions.parseRule", { harnessRunId: noisy.harnessRunId, revision: 1, ruleText: "随便" }) as { degraded: boolean; assignments: unknown };
      expect(degraded.degraded).toBe(true);
      expect(degraded.assignments).toBeNull();
    } finally { noisy.engine.shutdown(); }
  });

  test("规则引用未枚举 id 或池外 CLI 时 degraded", async () => {
    const session: HarnessSession = {
      isRunning: false,
      subscribe: () => () => {},
      abort: () => {},
      prompt: async () => "```json\n{ \"assignments\": [{ \"agentId\": \"ghost\", \"cli\": \"codex\" }] }\n```",
    };
    const { engine, harnessRunId } = await fixture(session);
    try {
      const parsed = await engine.handleDesktopAction("executions.parseRule", { harnessRunId, revision: 1, ruleText: "ghost 用 codex" }) as { degraded: boolean; diagnostic: string | null };
      expect(parsed.degraded).toBe(true);
      expect(parsed.diagnostic).toContain("未枚举");
    } finally { engine.shutdown(); }
  });

  test("主控回合运行中 parseRule 返回 409", async () => {
    const session: HarnessSession = {
      isRunning: true,
      subscribe: () => () => {},
      abort: () => {},
      prompt: () => new Promise<string>(() => {}),
    };
    const { engine, harnessRunId } = await fixture(session);
    try {
      await engine.handleDesktopAction("harnesses.send", { harnessRunId, text: "占用回合" });
      await expect(engine.handleDesktopAction("executions.parseRule", { harnessRunId, revision: 1, ruleText: "甲用 codex" })).rejects.toMatchObject({ status: 409 });
    } finally { engine.shutdown(); }
  });
});
