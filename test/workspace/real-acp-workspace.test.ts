import { expect, spyOn, test } from "bun:test";
import { AcpSessionClient } from "../../src/adapters/acp-session";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type * as acp from "@agentclientprotocol/sdk";
import { CliRuntimeRegistry } from "../../src/runtimes/registry";
import { ProductionWorkspaceExecutor } from "../../src/workspace/production-workspace-executor";
import { WorkspaceManager } from "../../src/workspace/workspace-manager";
import { RunRuntime } from "../../src/runtime/run-runtime";
import { WorkerControlPipe } from "../../src/runtime/worker-control-pipe";
import { GitRepository } from "../../src/workspace/git-repository";
import { agent, parallel, phase } from "../../src/workflow/author-api";
import type { WorkflowModule } from "../../src/shared/workflow-types";
import type { JsonObject } from "../../src/shared/json";
import { DesktopExecutionEngine } from "../../src/desktop/desktop-execution-engine";
import { DesignConfirmationCache } from "../../src-tauri/web/src/workflow-design-config";

// 真实模型/登录验收仅显式开启，普通bun test不访问模型；保留隔离现场用于审计，不自动删除成果。
test.skipIf(process.env.WF_REAL_WORKSPACE_ACCEPTANCE !== "1")("真实ACP双写与显式集成保存多父成果，主工作区不变", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-real-workspace-")));
  const cwd = join(root, "repo"); await mkdir(cwd);
  const git = async (...args: string[]) => { const child = Bun.spawn(["/usr/bin/git", "-c", "user.name=Acceptance", "-c", "user.email=acceptance@example.invalid", ...args], { cwd, stdout: "pipe", stderr: "pipe" }); const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); if (code) throw new Error(err); return out.trim(); };
  await git("init", "-b", "main"); await writeFile(join(cwd, "a.txt"), "base\n"); await writeFile(join(cwd, "b.txt"), "base\n"); await git("add", "--", "a.txt", "b.txt"); await git("commit", "-m", "acceptance base");
  const base = (await (await GitRepository.open(cwd)).inspect()).head;
  const engine = crypto.randomUUID(), a = crypto.randomUUID(), b = crypto.randomUUID(), integratedId = crypto.randomUUID();
  const registry = new CliRuntimeRegistry();
  const cli = process.env.WF_REAL_WORKSPACE_CLI === "kimi" ? "kimi" : "codex";
  await registry.resolveWorker(cli);
  const pipes: WorkerControlPipe[] = [];
  let runtime!: RunRuntime;
  const executor = new ProductionWorkspaceExecutor({ version: 2, authorization: { authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), repository: cwd, baseCommit: base, excludeExistingDirty: false, nodes: [{ nodeId: "a" }, { nodeId: "b" }, { nodeId: "integrate" }] }, bindings: [{ nodeId: "a", workspaceId: a }, { nodeId: "b", workspaceId: b }, { nodeId: "integrate", workspaceId: integratedId, integrationSources: { nodeIds: ["a", "b"] } }] }, join(root, "workspaces"), engine, registry, (identity, scratch) => {
    const pipe = new WorkerControlPipe(runtime.createControlServer(), identity, undefined, scratch); pipes.push(pipe);
    return { name: "wave-flow-worker-control", command: process.execPath, args: [join(import.meta.dir, "../../src/desktop/engine-main.ts"), "__worker-mcp"], env: [{ name: "WF_WORKER_MCP_REQUEST_FIFO", value: pipe.endpoints.requestFifo }, { name: "WF_WORKER_MCP_RESPONSE_FIFO", value: pipe.endpoints.responseFifo }], close: () => pipe.close() } as acp.McpServer;
  }, null);
  const schema = { type: "object", properties: { ok: { type: "boolean", const: true } }, required: ["ok"], additionalProperties: false };
  const workflow: WorkflowModule<JsonObject, unknown> = { meta: { name: "workspace-acceptance", description: "真实双写验收", phases: [{ title: "write" }, { title: "integrate" }] }, default: async () => {
    phase("write"); const outputs = await parallel([() => agent('只修改当前cwd的a.txt为"worker-a\\n"。不要读其他目录，不执行git commit/push，不联网，不安装依赖。最终结果为{ok:true}。', { id: "a", cli, sandbox: "workspace-write", schema }), () => agent('只修改当前cwd的b.txt为"worker-b\\n"。不要读其他目录，不执行git commit/push，不联网，不安装依赖。最终结果为{ok:true}。', { id: "b", cli, sandbox: "workspace-write", schema })]);
    if (outputs.some(value => value === null)) throw new Error("来源Worker未交付");
    phase("integrate"); return agent('Engine上下文已给出两个来源commit，已由宿主验证它们都是当前base的独立子分支。直接且只运行一次 git -c core.hooksPath=/dev/null merge --no-commit --no-ff <两个来源commit>，不要先实验、克隆、创建临时文件、reset、commit或push。随后只读取验证a.txt精确为worker-a加换行、b.txt精确为worker-b加换行；通过后立即返回{ok:true}。不要联网或安装。', { id: "integrate", cli, sandbox: "workspace-write", schema });
  } };
  const sourcePath = join(root, "workflow.ts"); await writeFile(sourcePath, "acceptance");
  runtime = await RunRuntime.create({ workflow, input: {}, workflowSource: "acceptance", workflowPath: sourcePath, workflowProjectCwd: cwd, clientRequestId: crypto.randomUUID(), executor, storeRoot: join(root, "runs") });
  const control = runtime.createControlServer();
  // 同一个Control必须复用，不能每个MCP重建独立会话Registry。
  runtime.createControlServer = () => control;
  console.log(`真实Workspace验收现场: ${root}; run=${runtime.snapshot().id}; cli=${cli}`);
  const originalCreate = AcpSessionClient.prototype.createSession;
  const diagnosticSpy = spyOn(AcpSessionClient.prototype, "createSession").mockImplementation(async function(this: AcpSessionClient, ...args: Parameters<typeof originalCreate>) {
    try { return await originalCreate.apply(this, args); }
    catch (error) { const data = (error as { data?: unknown }).data; if (data !== undefined) console.log("ACP session/new error data:", JSON.stringify(data)); throw error; }
  });
  try {
    await executor.bindRuntime(runtime, control);
    let output: unknown;
    try { output = await runtime.run(workflow); }
    catch (error) { console.log(JSON.stringify(runtime.snapshot().phases.flatMap(phase => phase.agents).map(node => ({ id: node.id, status: node.status, diagnostic: node.diagnostic })))); throw error; }
    expect(output).toEqual({ ok: true });
    const manager = await WorkspaceManager.open(join(root, "workspaces"), engine);
    const first = await manager.inspect(a), second = await manager.inspect(b), integrated = await manager.inspect(integratedId);
    expect(first.cwd).not.toBe(second.cwd); expect(first.results[0].ready).toBe(true); expect(second.results[0].ready).toBe(true);
    expect(await Bun.file(join(first.cwd, "a.txt")).text()).toBe("worker-a\n"); expect(await Bun.file(join(second.cwd, "b.txt")).text()).toBe("worker-b\n");
    expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("base\n"); expect(await Bun.file(join(cwd, "b.txt")).text()).toBe("base\n"); expect(await git("rev-parse", "HEAD")).toBe(base);
    expect(integrated.results[0].ready).toBe(true);
    expect(await Bun.file(join(integrated.cwd, "a.txt")).text()).toBe("worker-a\n"); expect(await Bun.file(join(integrated.cwd, "b.txt")).text()).toBe("worker-b\n");
    expect(await git("show", "-s", "--format=%P", integrated.results[0].commit)).toBe(`${base} ${first.results[0].commit} ${second.results[0].commit}`);
    // 真实验收启动授权也必须覆盖squash；不对旧记录凭空扩权。
    expect(executor.config.version).toBe(2);
    const delivery = await manager.finalizeSource(runtime.snapshot().id, executor.config);
    expect(delivery.commit).toBe(integrated.results[0].commit);
    expect(await git("rev-parse", `${delivery.commit}^{tree}`)).toBe(await git("rev-parse", `${integrated.results[0].commit}^{tree}`));
    expect(delivery.commit).toBe(integrated.results[0].commit);
    expect(await manager.finalizeSource(runtime.snapshot().id, executor.config)).toEqual(delivery);
    expect(await git("rev-parse", "HEAD")).toBe(base);
    console.log(JSON.stringify({ deliveryBranch: delivery.branch, deliveryCommit: delivery.commit, sourceCommit: delivery.sourceCommit, paths: delivery.paths }));
    console.log(JSON.stringify({ root, runId: runtime.snapshot().id, status: runtime.snapshot().status, commits: [first.results[0].commit, second.results[0].commit], integrationCommit: integrated.results[0].commit }));
  } finally { diagnosticSpy.mockRestore(); pipes.forEach(pipe => pipe.close()); executor.close(); }
}, 240_000);

test.skipIf(process.env.WF_REAL_WORKSPACE_ACCEPTANCE !== "1")("真实Engine保存来源、读取diff并经明确确认squash合入", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-real-auto-delivery-"))), cwd = join(root, "repo"); await mkdir(cwd);
  const git = async (...args: string[]) => { const p = Bun.spawn(["/usr/bin/git", "-c", "user.name=Acceptance", "-c", "user.email=acceptance@example.invalid", ...args], { cwd, stdout: "pipe", stderr: "pipe" }); const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); if (code) throw Error(err); return out.trim(); };
  await git("init", "-b", "main"); await writeFile(join(cwd, "a.txt"), "base\n"); await git("add", "a.txt"); await git("commit", "-m", "acceptance base");
  const base = await git("rev-parse", "HEAD"), cli = process.env.WF_REAL_WORKSPACE_CLI === "kimi" ? "kimi" : "codex";
  const selected = await new CliRuntimeRegistry().resolveWorker(cli), registry = new CliRuntimeRegistry(root);
  const saved = await registry.saveVerified(selected); await registry.select(saved.runtimeId);
  const source = `const meta={name:"auto-delivery",description:"自动单条交付",phases:[{title:"write"}]};async function run(args){phase("write");return agent('只修改当前cwd的a.txt为done加换行。不要git commit、push、联网、安装。最终结果{ok:true}。',{id:"writer",cli:"${cli}",sandbox:"workspace-write",schema:{type:"object",properties:{ok:{type:"boolean",const:true}},required:["ok"],additionalProperties:false}});}`;
  const engine = new DesktopExecutionEngine({ storeRoot: join(root, "runs"), harnessRoot: join(root, "harness-runs"), createHarnessSession: async (_id, _cwd, _prior, actions) => ({ isRunning: false, subscribe: () => () => {}, abort: () => {}, close: () => {}, prompt: async text => { if (text.startsWith("请总结")) return "业务已完成；Git交付请以真实证据为准，不代表业务验收。"; await actions.proposeWorkflowRevision(source, "自动交付验收", "只写a.txt"); return "方案已提出"; } }) });
  try {
    const project = await engine.handleDesktopAction("projects.create", { cwd }) as import("../../src/desktop/types").HarnessProjectResponse;
    const started = await engine.handleDesktopAction("harnesses.startConversation", { projectId: project.project.projectId, clientRequestId: crypto.randomUUID(), text: "生成自动交付验收方案" }) as import("../../src/desktop/types").HarnessRunResponse;
    const taskId = started.harness.harnessRunId;
    for (let n = 0; n < 1000; n++) { const value = await engine.handleDesktopAction("harnesses.get", { harnessRunId: taskId }) as import("../../src/desktop/types").HarnessRunResponse; if (value.harness.status === "idle" && value.harness.workflowRevisions.length) break; await Bun.sleep(10); }
    const plan = await engine.handleDesktopAction("executions.plan", { harnessRunId: taskId, revision: 1 }) as import("../../src-tauri/web/src/types").ExecutionPlanResponse;
    const workspaces = { version: 2 as const, authorization: { authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), repository: cwd, baseCommit: base, excludeExistingDirty: false, nodes: [{ nodeId: "writer" }] }, bindings: [{ nodeId: "writer", workspaceId: crypto.randomUUID() }] };
    const request = new DesignConfirmationCache().get(`${taskId}:1`, {}, {}, plan, workspaces);
    const created = await engine.handleDesktopAction("executions.confirm", { harnessRunId: taskId, revision: 1, config: request.config, clientRequestId: request.id, input: {} }) as import("../../src/desktop/types").ExecutionResponse;
    console.log(JSON.stringify({ root, taskId, executionId: created.execution.executionId, cli }));
    let detail = created;
    const deadline = Date.now() + 150_000;
    while (detail.execution.finishedAt === null && Date.now() < deadline) { await Bun.sleep(100); detail = await engine.handleDesktopAction("executions.get", { harnessRunId: taskId, executionId: created.execution.executionId }) as import("../../src/desktop/types").ExecutionResponse; }
    expect(detail.execution.status, detail.execution.diagnostic ?? "").toBe("completed");
    expect(detail.sourceDiagnostic).toBeUndefined(); expect(detail.sourceEvidence).toBeDefined();
    const delivery = detail.sourceEvidence!;
    expect(await git("show", "-s", "--format=%P", delivery.commit)).toBe(base);
    expect(await git("rev-list", "--count", `${base}..${delivery.commit}`)).toBe("1");
    expect(await git("show", `${delivery.commit}:a.txt`)).toBe("done");
    expect(await git("rev-parse", "HEAD")).toBe(base); expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("base\n");
    const identity={harnessRunId:taskId,executionId:detail.execution.executionId};
    const review=await engine.handleDesktopAction("executions.review",identity) as import("../../src/workspace/git-repository").GitReview;
    expect(review.paths).toEqual(["a.txt"]);
    const merged=await engine.handleDesktopAction("executions.merge",{...identity,authorized:true,requestId:crypto.randomUUID(),sourceCommit:review.sourceCommit,targetBranch:"main",targetHead:base}) as import("../../src/workspace/git-repository").GitMergeResult;
    expect(await git("show","-s","--format=%P",merged.commit)).toBe(base);expect(await git("rev-list","--count",`${base}..main`)).toBe("1");expect(await Bun.file(join(cwd,"a.txt")).text()).toBe("done\n");
    console.log(JSON.stringify({ root, taskId, executionId: detail.execution.executionId, delivery }));
  } finally { engine.shutdown(); }
}, 180_000);
