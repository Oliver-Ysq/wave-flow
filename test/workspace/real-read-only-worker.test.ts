import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { CliRuntimeRegistry } from "../../src/runtimes/registry";
import { RuntimeAcpWorkerExecutor } from "../../src/runtime/runtime-acp-worker-executor";
import { WorkerControlChannel } from "../../src/runtime/worker-control-channel";
import { RunRuntime } from "../../src/runtime/run-runtime";
import { agent, phase } from "../../src/workflow/author-api";
import type { WorkflowModule } from "../../src/shared/workflow-types";
import type { JsonObject } from "../../src/shared/json";

// 真实模型仅用户显式验收时开启；现场保留，不自动清除文件证据。
test.skipIf(process.env.WF_REAL_READ_ONLY_WORKER_ACCEPTANCE !== "1")("真实只读Worker跨目录读并经Control完成，不改变文件", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-real-read-only-"))), cwd = join(root, "project");
  await mkdir(cwd); const inside = join(cwd, "inside.txt"), outside = join(root, "outside.txt");
  await writeFile(inside, "INSIDE_42\n"); await writeFile(outside, "OUTSIDE_73\n");
  await writeFile(join(root, "workflow.ts"), "read-only-acceptance");
  const cli = process.env.WF_REAL_READ_ONLY_WORKER_CLI === "kimi" ? "kimi" : "codex";
  const registry = new CliRuntimeRegistry(); await registry.resolveWorker(cli);
  const pipes: WorkerControlChannel[] = [];
  let runtime!: RunRuntime;
  const executor = new RuntimeAcpWorkerExecutor(registry, (identity, scratch) => {
    const pipe = new WorkerControlChannel(runtime.createControlServer(), identity, undefined, scratch); pipes.push(pipe);
    return { name: "wave-flow-worker-control", command: process.execPath, args: [join(import.meta.dir, "../../src/desktop/engine-main.ts"), "__worker-mcp"], env: [{ name: "WF_WORKER_CONTROL_SOCKET", value: pipe.endpoints.socketPath }], close: () => pipe.close() } as acp.McpServer;
  }, undefined, null, join(root, "scratch"));
  const workflow: WorkflowModule<JsonObject, unknown> = {
    meta: { name: "read-only-acceptance", description: "只读隔离验收", phases: [{ title: "read" }] },
    default: async () => { phase("read"); return agent(`仅读取${inside}和${outside}，验证分别为INSIDE_42及OUTSIDE_73加换行。不要修改任何文件、安装依赖或联网。结果返回{ok:true}。`, { id: "reader", cli, sandbox: "read-only", schema: { type: "object", properties: { ok: { type: "boolean", const: true } }, required: ["ok"], additionalProperties: false } }); },
  };
  runtime = await RunRuntime.create({ workflow, input: {}, workflowSource: "read-only-acceptance", workflowPath: join(root, "workflow.ts"), workflowProjectCwd: cwd, clientRequestId: crypto.randomUUID(), executor, storeRoot: join(root, "runs") });
  const control = runtime.createControlServer(); runtime.createControlServer = () => control; executor.bindControl(control);
  console.log(JSON.stringify({ root, runId: runtime.snapshot().id }));
  try {
    expect(await runtime.run(workflow)).toEqual({ ok: true });
    expect(runtime.snapshot().status).toBe("completed");
    expect(await Bun.file(inside).text()).toBe("INSIDE_42\n"); expect(await Bun.file(outside).text()).toBe("OUTSIDE_73\n");
  } finally { pipes.forEach(pipe => pipe.close()); }
}, 120_000);
