import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopExecutionEngine } from "../../src/desktop/desktop-execution-engine";

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
test("项目目录只读验证IPC拒绝文件且不登记；创建同样复核目录",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wave-flow-project-path-ipc-"));roots.push(root);
 const engine=new DesktopExecutionEngine({leadRoot:join(root,"state","lead-runs"),storeRoot:join(root,"state","runs"),deterministicForTest:true});
 try{
  const path=join(root,"ordinary-file");await writeFile(path,"not a directory");
  await expect(engine.handleDesktopAction("projects.validatePath",{cwd:path})).rejects.toThrow("文件夹");
  await expect(engine.handleDesktopAction("projects.create",{cwd:path})).rejects.toThrow("文件夹");
  await expect(engine.handleDesktopAction("projects.validatePath",{cwd:"relative"})).rejects.toThrow("绝对路径");
  expect(await engine.handleDesktopAction("projects.list",{})).toEqual({projects:[]});
  const valid=await engine.handleDesktopAction("projects.validatePath",{cwd:root}) as {cwd:string};
  expect(valid.cwd).toMatch(/wave-flow-project-path-ipc-/);
  expect(await engine.handleDesktopAction("projects.list",{})).toEqual({projects:[]});
  expect(await engine.handleDesktopAction("runs.list",{})).toEqual([]);
 }finally{engine.shutdown();}
});
test("本地预检IPC只读取Project指定文件，不创建Task/Run或返回源码",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wave-flow-preflight-ipc-"));roots.push(root);
 const engine=new DesktopExecutionEngine({leadRoot:join(root,"state","lead-runs"),storeRoot:join(root,"state","runs"),deterministicForTest:true,singleWorkflowForAcceptance:true});
 try{
   const result=await engine.handleDesktopAction("projects.create",{cwd:root}) as {project:{projectId:string}};
   const file=join(root,"workflow.ts");
   await writeFile(file,`export const meta={name:"ipc",description:"检查",phases:[{title:"检查"}],inputSchema:{type:"object",properties:{},additionalProperties:false}};export default async function run(args:unknown){throw Error("不允许预检执行");}`);
   const preview=await engine.handleDesktopAction("workflows.preflightLocal",{projectId:result.project.projectId,path:file});
   expect(preview).toMatchObject({meta:{name:"ipc"},inputSchema:{type:"object"}});expect(preview).not.toHaveProperty("source");
   expect(await engine.handleDesktopAction("leads.list",{})).toMatchObject({leads:[]});
   expect(await engine.handleDesktopAction("runs.list",{})).toEqual([]);
   await expect(engine.handleDesktopAction("workflows.preflightLocal",{projectId:"不存在",path:file})).rejects.toThrow("未知项目");
 }finally{engine.shutdown();}
});

test("显式关闭新Task契约的兼容实例拒绝本地预检IPC",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wave-flow-preflight-disabled-"));roots.push(root);
 const engine=new DesktopExecutionEngine({leadRoot:join(root,"lead-runs"),storeRoot:join(root,"runs"),deterministicForTest:true,singleWorkflowForAcceptance:false});
 try{await expect(engine.handleDesktopAction("workflows.preflightLocal",{projectId:"p",path:"a.ts"})).rejects.toThrow("专用验收");}
 finally{engine.shutdown();}
});

test("本地确认不需要分配快照，相同UUID不重复执行，配置覆盖零执行",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wave-flow-local-confirm-"));roots.push(root);
 const engine=new DesktopExecutionEngine({leadRoot:join(root,"state","lead-runs"),storeRoot:join(root,"state","runs"),deterministicForTest:true,singleWorkflowForAcceptance:true});
 try{
  const {project}=await engine.handleDesktopAction("projects.create",{cwd:root}) as {project:{projectId:string}};
  const path=join(root,"a.ts");await writeFile(path,`export const meta={name:"local",description:"确认",phases:[{title:"检查"}],inputSchema:{type:"object",properties:{},additionalProperties:false}};export default async function run(args:unknown){return {ok:true};}`);
  const preview=await engine.handleDesktopAction("workflows.preflightLocal",{projectId:project.projectId,path}) as {sourceHash:string};
  const {lead}=await engine.handleDesktopAction("workflows.createLocalTask",{projectId:project.projectId,path,sourceHash:preview.sourceHash,input:{},clientRequestId:crypto.randomUUID()}) as {lead:{leadRunId:string}};
  const request={leadRunId:lead.leadRunId,revision:1,clientRequestId:crypto.randomUUID()};
  await expect(engine.handleDesktopAction("executions.confirm",{...request,config:{}})).rejects.toThrow("必须包含逐节点 CLI 选择");
  const created=await engine.handleDesktopAction("executions.confirm",request) as {execution:{executionId:string;kind:string;config?:unknown}};
  expect(created.execution.kind).toBe("local-run");expect(created.execution.config).toBeUndefined();
  const retry=await engine.handleDesktopAction("executions.confirm",request) as typeof created;
  expect(retry.execution.executionId).toBe(created.execution.executionId);
 }finally{engine.shutdown();}
});
test("本地同链修订绑定现场确认，新Execution保留旧结果；重复UUID零重派发",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wave-flow-local-revision-"));roots.push(root);
 const engine=new DesktopExecutionEngine({leadRoot:join(root,"state","lead-runs"),storeRoot:join(root,"state","runs"),deterministicForTest:true,singleWorkflowForAcceptance:true});
 const source=(value:number)=>`export const meta={name:"local",description:"核验",phases:[{title:"检查"}],inputSchema:{type:"object",properties:{},additionalProperties:false}};export default async function run(args:unknown){return {value:${value}};}`;
 const wait=async(id:string,executionId:string)=>{for(let n=0;n<200;n++){const {lead}=await engine.handleDesktopAction("leads.get",{leadRunId:id}) as {lead:import("../../src/lead/types").LeadSnapshot};if(lead.impactSummaries?.some(item=>item.executionId===executionId&&item.status==="completed"))return lead;await Bun.sleep(5);}throw Error("总结未完成");};
 try{
  const {project}=await engine.handleDesktopAction("projects.create",{cwd:root}) as {project:{projectId:string}},path=join(root,"a.ts");await writeFile(path,source(1));
  let preview=await engine.handleDesktopAction("workflows.preflightLocal",{projectId:project.projectId,path}) as {sourceHash:string};
  const {lead}=await engine.handleDesktopAction("workflows.createLocalTask",{projectId:project.projectId,path,sourceHash:preview.sourceHash,input:{},clientRequestId:crypto.randomUUID()}) as {lead:{leadRunId:string}},id=lead.leadRunId;
  const first=await engine.handleDesktopAction("executions.confirm",{leadRunId:id,revision:1,clientRequestId:crypto.randomUUID()}) as import("../../src/desktop/types").ExecutionResponse;
  const old=await wait(id,first.execution.executionId);
  await writeFile(path,source(2));preview=await engine.handleDesktopAction("workflows.preflightLocal",{projectId:project.projectId,path}) as {sourceHash:string};
  await engine.handleDesktopAction("workflows.reviseLocalTask",{leadRunId:id,baseRevision:1,sourceHash:preview.sourceHash,input:{},clientRequestId:crypto.randomUUID()});
  const plan=await engine.handleDesktopAction("executions.plan",{leadRunId:id,revision:2}) as import("../../src/desktop/types").ExecutionPlanResponse;
  const request={leadRunId:id,revision:2,clientRequestId:crypto.randomUUID(),sceneEvidenceHash:plan.sceneEvidenceHash};
  await expect(engine.handleDesktopAction("executions.confirm",{...request,sceneEvidenceHash:"a".repeat(64)})).rejects.toThrow("现场证据已变化");
  const second=await engine.handleDesktopAction("executions.confirm",request) as typeof first;
  expect((await engine.handleDesktopAction("executions.confirm",request) as typeof first).execution.executionId).toBe(second.execution.executionId);
  const next=await wait(id,second.execution.executionId);expect(next.executions).toHaveLength(2);expect(next.executions[0]).toEqual(old.executions[0]);expect(next.executions[1].summary).toEqual({value:2});
  await expect(engine.handleDesktopAction("executions.resume",{leadRunId:id,executionId:first.execution.executionId})).rejects.toThrow("旧执行只能查看历史");
  await expect(engine.handleDesktopAction("executions.confirm",{...request,sceneEvidenceHash:"b".repeat(64)})).rejects.toThrow("相同确认请求");
 }finally{engine.shutdown();}
});

/**
 * 不预设用户装了某个 CLI：源码写死 `cli` 时，规划阶段就要核对本机是否有已验证候选。
 * 否则用户只会在节点启动后拿到一条 interrupted，看不出真正缺的是本机应用。
 */
test("源码要求的 Worker CLI 没有本机已验证候选时，规划阶段明确报缺而不是等节点失败", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-required-cli-")); roots.push(root);
  // 非确定性执行器才会触发真实 Registry 核对；这里仍不启动任何模型会话。
  const engine = new DesktopExecutionEngine({ leadRoot: join(root, "state", "lead-runs"), storeRoot: join(root, "state", "runs"), stateRoot: join(root, "state"), skillsRoot: join(root, "state", "skills"), deterministicForTest: false });
  try {
    const { project } = await engine.handleDesktopAction("projects.create", { cwd: root }) as { project: { projectId: string } };
    const path = join(root, "needs-codex.ts");
    await writeFile(path, `import { agent, phase } from "wave-flow";
export const meta = { name: "needs-codex", description: "需要本机 codex", phases: [{ title: "检查" }], inputSchema: { type: "object", properties: {}, additionalProperties: false } };
export default async function run(_args: unknown) { phase("检查"); return agent("只读检查", { id: "checker", cli: "codex", sandbox: "read-only" }); }`);
    const preview = await engine.handleDesktopAction("workflows.preflightLocal", { projectId: project.projectId, path }) as { sourceHash: string };
    const { lead } = await engine.handleDesktopAction("workflows.createLocalTask", { projectId: project.projectId, path, sourceHash: preview.sourceHash, input: {}, clientRequestId: crypto.randomUUID() }) as { lead: { leadRunId: string } };
    const error = await engine.handleDesktopAction("executions.plan", { leadRunId: lead.leadRunId, revision: 1 }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("需要本机已验证的 codex Worker");
    expect((error as Error).message).toContain("设置页");
    // 规划被拒时不得留下任何 Execution 登记。
    expect((await engine.handleDesktopAction("executions.list", { leadRunId: lead.leadRunId }) as { executions: unknown[] }).executions).toHaveLength(0);
  } finally { engine.shutdown(); }
});

/**
 * 逐节点 CLI：预置与可移植模块不写 cli，方案页必须为每个省略 cli 的字面量节点各自选择，
 * 而不是用一次全局选择敷衍；选择随配置冻结，并进入 Journal 生效请求。
 */
test("逐节点 CLI 选择：计划列出每个省略节点，确认必须逐个选好", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-per-node-cli-")); roots.push(root);
  const state = join(root, "state");
  const { CliRuntimeRegistry } = await import("../../src/runtimes/registry");
  const { verifyExecutable } = await import("../../src/runtimes/identity");
  // 两个已验证候选：saveVerified 不做启动验证，plan/confirm 只读 list()，因此用同一个系统可执行文件登记两种 CLI。
  const registry = new CliRuntimeRegistry(state);
  // 必须是当前用户拥有的常规可执行文件；内容不重要，plan/confirm 只读 Registry 元数据。
  const fakeCli = join(root, "fake-cli");
  await writeFile(fakeCli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await (await import("node:fs/promises")).chmod(fakeCli, 0o700);
  const identity = await verifyExecutable(fakeCli);
  const record = (cli: "codex" | "claude", adapterId: "codex-acp" | "claude-acp") => ({
    runtimeId: crypto.randomUUID(), cli, executablePath: identity.executablePath, executableIdentity: identity.identity,
    version: `${cli} test`, discoveredFrom: "manual" as const, discoveredShell: null,
    verifiedAdapter: { adapterId, adapterVersion: "test", acpProtocolVersion: 1, leadTools: true },
    verifiedAt: new Date().toISOString(), status: "verified" as const, diagnostic: null,
  });
  await registry.saveVerified(record("codex", "codex-acp"));
  await registry.saveVerified(record("claude", "claude-acp"));
  const engine = new DesktopExecutionEngine({ leadRoot: join(state, "lead-runs"), storeRoot: join(root, "runs"), stateRoot: state, skillsRoot: join(state, "skills"), deterministicForTest: true });
  try {
    const { project } = await engine.handleDesktopAction("projects.create", { cwd: root }) as { project: { projectId: string } };
    const path = join(root, "portable.ts");
    await writeFile(path, `import { agent, phase } from "wave-flow";
export const meta = { name: "portable", description: "两个可移植节点", phases: [{ title: "检查" }], inputSchema: { type: "object", properties: {}, additionalProperties: false } };
export default async function run(_args: unknown) { phase("检查"); const a = await agent("甲", { id: "a", sandbox: "read-only" }); const b = await agent("乙", { id: "b", sandbox: "read-only" }); return { a, b }; }`);
    const preview = await engine.handleDesktopAction("workflows.preflightLocal", { projectId: project.projectId, path }) as { sourceHash: string };
    const { lead } = await engine.handleDesktopAction("workflows.createLocalTask", { projectId: project.projectId, path, sourceHash: preview.sourceHash, input: {}, clientRequestId: crypto.randomUUID() }) as { lead: { leadRunId: string } };
    const taskId = lead.leadRunId;
    const requested = await engine.handleDesktopAction("executions.plan", { leadRunId: taskId, revision: 1 }) as import("../../src/desktop/types").ExecutionPlanResponse;
    expect(requested.cliChoices).toMatchObject({ available: ["codex", "claude"], suggested: null, dynamicCount: 0, nodes: [{ nodeId: "a" }, { nodeId: "b" }] });

    const withoutSelection = await engine.handleDesktopAction("executions.confirm", { leadRunId: taskId, revision: 1, clientRequestId: crypto.randomUUID() }).catch((reason: unknown) => reason);
    expect(String(withoutSelection)).toContain("以下节点未声明 CLI");
    expect(String(withoutSelection)).toContain("a、b");
    expect((await engine.handleDesktopAction("executions.list", { leadRunId: taskId }) as { executions: unknown[] }).executions).toHaveLength(0);

    // 只选一个节点也不够：另一个节点仍然必须自己选。
    const partial = await engine.handleDesktopAction("executions.confirm", { leadRunId: taskId, revision: 1, clientRequestId: crypto.randomUUID(), config: { version: 1, assignmentMode: "script", createdAt: new Date().toISOString(), nodeClis: { a: "codex" } } }).catch((reason: unknown) => reason);
    expect(String(partial)).toContain("b");

    const created = await engine.handleDesktopAction("executions.confirm", { leadRunId: taskId, revision: 1, clientRequestId: crypto.randomUUID(), config: { version: 1, assignmentMode: "script", createdAt: new Date().toISOString(), nodeClis: { a: "codex", b: "claude" } } }) as { execution: { executionId: string; config?: { nodeClis?: Record<string, string> } } };
    expect(created.execution.config).toMatchObject({ nodeClis: { a: "codex", b: "claude" } });
    let detail = await engine.handleDesktopAction("executions.get", { leadRunId: taskId, executionId: created.execution.executionId }) as { execution: { status: string; finishedAt: string | null } };
    for (let index = 0; index < 500 && detail.execution.finishedAt === null; index += 1) { await Bun.sleep(10); detail = await engine.handleDesktopAction("executions.get", { leadRunId: taskId, executionId: created.execution.executionId }) as typeof detail; }
    expect(detail.execution.status).toBe("completed");
  } finally { engine.shutdown(); }
});

/** 默认选择主控 CLI：用户不必从空白开始选；主控 CLI 不可用时才退回唯一候选。 */
test("逐节点 CLI 默认预填主控使用的 CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-lead-cli-default-")); roots.push(root);
  const state = join(root, "state");
  const { CliRuntimeRegistry } = await import("../../src/runtimes/registry");
  const { verifyExecutable } = await import("../../src/runtimes/identity");
  const registry = new CliRuntimeRegistry(state);
  const fakeCli = join(root, "fake-cli");
  await writeFile(fakeCli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await (await import("node:fs/promises")).chmod(fakeCli, 0o700);
  const identity = await verifyExecutable(fakeCli);
  const record = (cli: "codex" | "claude", adapterId: "codex-acp" | "claude-acp") => ({
    runtimeId: crypto.randomUUID(), cli, executablePath: identity.executablePath, executableIdentity: identity.identity,
    version: `${cli} test`, discoveredFrom: "manual" as const, discoveredShell: null,
    verifiedAdapter: { adapterId, adapterVersion: "test", acpProtocolVersion: 1, leadTools: true },
    verifiedAt: new Date().toISOString(), status: "verified" as const, diagnostic: null,
  });
  const claude = await registry.saveVerified(record("claude", "claude-acp"));
  await registry.saveVerified(record("codex", "codex-acp"));
  // 主控选的是 Claude：多候选时预填仍应指向它，而不是留空或按顺序取第一个。
  await registry.select(claude.runtimeId);
  const engine = new DesktopExecutionEngine({ leadRoot: join(state, "lead-runs"), storeRoot: join(root, "runs"), stateRoot: state, skillsRoot: join(state, "skills"), deterministicForTest: true });
  try {
    const { project } = await engine.handleDesktopAction("projects.create", { cwd: root }) as { project: { projectId: string } };
    const path = join(root, "portable.ts");
    await writeFile(path, `import { agent, phase } from "wave-flow";
export const meta = { name: "portable", description: "可移植节点", phases: [{ title: "检查" }], inputSchema: { type: "object", properties: {}, additionalProperties: false } };
export default async function run(_args: unknown) { phase("检查"); return agent("甲", { id: "a", sandbox: "read-only" }); }`);
    const preview = await engine.handleDesktopAction("workflows.preflightLocal", { projectId: project.projectId, path }) as { sourceHash: string };
    const { lead } = await engine.handleDesktopAction("workflows.createLocalTask", { projectId: project.projectId, path, sourceHash: preview.sourceHash, input: {}, clientRequestId: crypto.randomUUID() }) as { lead: { leadRunId: string } };
    const plan = await engine.handleDesktopAction("executions.plan", { leadRunId: lead.leadRunId, revision: 1 }) as import("../../src/desktop/types").ExecutionPlanResponse;
    expect(plan.cliChoices).toMatchObject({ available: ["claude", "codex"], suggested: "claude", nodes: [{ nodeId: "a" }] });
  } finally { engine.shutdown(); }
});
