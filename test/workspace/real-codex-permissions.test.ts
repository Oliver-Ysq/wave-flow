import { withDeadline } from "../fixtures/deadline";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { RunJournal } from "../../src/journal/run-journal";
import { RunRuntime } from "../../src/runtime/run-runtime";
import { WorkerControlChannel } from "../../src/runtime/worker-control-channel";
import { CliRuntimeRegistry } from "../../src/runtimes/registry";
import type { JsonObject } from "../../src/shared/json";
import type { WorkflowModule } from "../../src/shared/workflow-types";
import { agent, phase } from "../../src/workflow/author-api";
import { ProductionWorkspaceExecutor } from "../../src/workspace/production-workspace-executor";
import { WorkspaceManager } from "../../src/workspace/workspace-manager";

// 真实模型仅显式验收时开启；保留临时现场，便于复核实际权限与 Journal。
test.skipIf(process.env.WF_REAL_CODEX_PERMISSION_ACCEPTANCE !== "1")("真实Codex写节点可写工作区与外部目录、访问本机网络并完成HITL", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-real-codex-permissions-")));
  const outsideRoot = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-real-codex-external-")));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["/usr/bin/git", "-c", "user.name=Acceptance", "-c", "user.email=acceptance@example.invalid", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(err);
    return out.trim();
  };
  await git("init", "-b", "main");
  await writeFile(join(cwd, "base.txt"), "base\n");
  await git("add", "base.txt");
  await git("commit", "-m", "acceptance base");
  const base = await git("rev-parse", "HEAD");
  const workspaceId = crypto.randomUUID(), engineId = crypto.randomUUID();
  const insideMarker = `INSIDE_${crypto.randomUUID()}`;
  const outsideMarker = `OUTSIDE_${crypto.randomUUID()}`;
  const networkMarker = `NETWORK_${crypto.randomUUID()}`;
  const outsideFile = join(outsideRoot, "outside.txt");
  let networkRequests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      networkRequests += 1;
      return new Response(`${networkMarker}\n`);
    },
  });
  const networkUrl = `http://127.0.0.1:${server.port}/marker`;
  const registry = new CliRuntimeRegistry();
  await registry.resolveWorker("codex");
  const pipes: WorkerControlChannel[] = [];
  let runtime!: RunRuntime;
  const executor = new ProductionWorkspaceExecutor({
    version: 3,
    authorization: {
      authorizationId: crypto.randomUUID(),
      approvedAt: new Date().toISOString(),
      repository: cwd,
      baseCommit: base,
      excludeExistingDirty: false,
      nodes: [{ nodeId: "inside-hitl" }, { nodeId: "outside-write" }, { nodeId: "network" }],
    },
    workspaceId,
  }, join(root, "workspaces"), engineId, registry, (identity, scratch) => {
    const pipe = new WorkerControlChannel(runtime.createControlServer(), identity, undefined, scratch);
    pipes.push(pipe);
    return {
      name: "wave-flow-worker-control",
      command: process.execPath,
      args: [join(import.meta.dir, "../../src/desktop/engine-main.ts"), "__worker-mcp"],
      env: [{ name: "WF_WORKER_CONTROL_SOCKET", value: pipe.endpoints.socketPath }, { name: "WF_WORKER_CONTROL_CAPABILITY", value: identity.capability }],
      close: () => pipe.close(),
    } as acp.McpServer;
  }, null);
  const schema = { type: "object", properties: { ok: { type: "boolean", const: true } }, required: ["ok"], additionalProperties: false } as const;
  const workflow: WorkflowModule<JsonObject, unknown> = {
    meta: { name: "codex-permission-acceptance", description: "Codex 权限与人工表单真机验收", phases: [{ title: "inside" }, { title: "outside" }, { title: "network" }] },
    default: async () => {
      phase("inside");
      await agent(`只将当前cwd的inside.txt写成${insideMarker}加换行并读取验证。然后必须调用wave_flow_block，needHelp写“请确认继续”，answerSchema只含必填boolean字段ok；收到answered后完成。不要commit/push、联网或修改其他文件。结果{ok:true}。`, { id: "inside-hitl", cli: "codex", sandbox: "workspace-write", schema });
      phase("outside");
      await agent(`只将${outsideFile}写成${outsideMarker}加换行并读取验证。这是已授权的独立临时目录。不要commit/push、联网或修改其他文件。结果{ok:true}。`, { id: "outside-write", cli: "codex", sandbox: "workspace-write", schema });
      phase("network");
      return agent(`只访问本机地址${networkUrl}，验证响应恰好为${networkMarker}加换行。不得访问其他URL或修改文件。结果{ok:true}。`, { id: "network", cli: "codex", sandbox: "workspace-write", schema });
    },
  };
  const workflowPath = join(root, "workflow.ts");
  await writeFile(workflowPath, "codex-permission-acceptance");
  runtime = await RunRuntime.create({ workflow, input: {}, workflowSource: "codex-permission-acceptance", workflowPath, workflowProjectCwd: cwd, clientRequestId: crypto.randomUUID(), executor, storeRoot: join(root, "runs") });
  const control = runtime.createControlServer();
  runtime.createControlServer = () => control;
  await executor.bindRuntime(runtime, control);
  console.log(JSON.stringify({ root, outsideRoot, runId: runtime.snapshot().id, networkUrl }));
  const running = runtime.run(workflow);
  let runFailure: unknown = null;
  void running.catch(error => { runFailure = error; });
  const waitFor = async (predicate: () => boolean, label: string) => {
    for (let index = 0; index < 2_400; index += 1) {
      if (runFailure) throw runFailure;
      if (predicate()) return;
      await Bun.sleep(50);
    }
    throw new Error(`真实 Codex 权限验收等待${label}超时。`);
  };
  try {
    await waitFor(() => runtime.snapshot().phases[0]?.agents[0]?.block?.delivery === "pending", "工作区写节点的人工表单");
    const blocked = runtime.snapshot().phases[0]!.agents[0]!;
    expect(blocked.status).toBe("blocked");
    await control.answer({ blockRequestId: blocked.block!.blockRequestId, answer: { ok: true } });
    expect(await withDeadline(running, 420_000, "Codex权限验收")).toEqual({ ok: true });
    expect(runtime.snapshot().status).toBe("completed");
    const manager = await WorkspaceManager.open(join(root, "workspaces"), engineId);
    const workspace = await manager.inspect(workspaceId);
    expect(await Bun.file(join(workspace.cwd, "inside.txt")).text()).toBe(`${insideMarker}\n`);
    expect(await Bun.file(outsideFile).text()).toBe(`${outsideMarker}\n`);
    expect(networkRequests).toBeGreaterThan(0);
    expect(await Bun.file(join(cwd, "base.txt")).text()).toBe("base\n");
    expect(await git("rev-parse", "HEAD")).toBe(base);
    expect(await git("-C", workspace.cwd, "rev-parse", "HEAD")).toBe(base);
    const events = (await RunJournal.open(runtime.snapshot().id, join(root, "runs"))).events;
    expect(events.filter(event => event.type === "agent.session")).toHaveLength(3);
    expect(events.filter(event => event.type === "agent.completed")).toHaveLength(3);
    expect(events.filter(event => event.type === "agent.restarted")).toHaveLength(0);
    expect(events.filter(event => event.type === "block.created")).toHaveLength(1);
    expect(events.filter(event => event.type === "block.answered")).toHaveLength(1);
    expect(events.filter(event => event.type === "agent.continued")).toHaveLength(1);
    console.log(JSON.stringify({ runId: runtime.snapshot().id, workspace: workspace.cwd, outsideFile, networkRequests, sessions: 3 }));
  } finally {
    if (["running", "pausing", "paused", "recovering"].includes(runtime.snapshot().status)) await runtime.stop().catch(() => undefined);
    await running.catch(() => undefined);
    server.stop(true);
    pipes.forEach(pipe => pipe.close());
    executor.close();
  }
}, 480_000);
