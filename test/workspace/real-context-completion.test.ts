import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { AcpSessionClient, bunAcpTransport, type AcpTransportFactory } from "../../src/adapters/acp-session";
import { CliRuntimeRegistry } from "../../src/runtimes/registry";
import { resolveWorkerLauncher, runtimeProvenance } from "../../src/runtimes/worker-launcher-resolver";
import { AcpWorkerExecutor } from "../../src/runtime/acp-worker-executor";
import { RuntimeAcpWorkerExecutor } from "../../src/runtime/runtime-acp-worker-executor";
import { WorkerControlChannel } from "../../src/runtime/worker-control-channel";
import { RunRuntime } from "../../src/runtime/run-runtime";
import { RunJournal } from "../../src/journal/run-journal";
import { agent, phase } from "../../src/workflow/author-api";
import type { WorkflowModule } from "../../src/shared/workflow-types";
import type { JsonObject } from "../../src/shared/json";

/**
 * 真机验收：抗压缩三项改动必须真的上了线。
 *
 * 1. 客户端广告 session.compaction，真实适配器才会发结构化压缩事实；
 * 2. 真实 CLI 上报的上下文占用事实被宿主收到并消费；
 * 3. 节点 resultSchema 穿��真实适配器拉起的 MCP 子进程，进入完成工具签名。
 *
 * 取证只观察协议种类、能力声明与环境变量，不记录 prompt、工具参数或凭据。
 */
test.skipIf(process.env.WF_REAL_CONTEXT_ACCEPTANCE !== "1")("真实CLI：广告压缩能力、收到占用事实、结果Schema进入完成工具", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-real-context-"))), cwd = join(root, "project");
  await mkdir(cwd);
  const inside = join(cwd, "inside.txt");
  await writeFile(inside, "INSIDE_42\n");
  await writeFile(join(root, "workflow.ts"), "context-acceptance");
  const cli = process.env.WF_REAL_CONTEXT_CLI === "claude" ? "claude" : "codex";
  const schema = { type: "object", properties: { ok: { type: "boolean", const: true } }, required: ["ok"], additionalProperties: false };
  const registry = new CliRuntimeRegistry();
  const runtime = await registry.resolveWorker(cli);
  const launcher = resolveWorkerLauncher(runtime);

  // ACP 线上取证：只记录方法名、session update 种类与 initialize 的能力声明。
  const updates: string[] = [];
  let initializeCapabilities: unknown;
  const tapped: AcpTransportFactory = async (value, signal) => {
    const base = await bunAcpTransport(value, signal);
    // Bun 的 WritableStream 没有 pipeThrough，这里手工包一层观察写入方向。
    const writer = base.stream.writable.getWriter();
    const writable = new WritableStream<unknown>({
      write(message) {
        const raw = message as { method?: string; params?: { clientCapabilities?: unknown } };
        if (raw.method === "initialize") initializeCapabilities = raw.params?.clientCapabilities;
        return writer.write(message as never);
      },
      close() { return writer.close(); },
      abort(reason?: unknown) { return writer.abort(reason); },
    });
    return { ...base, stream: {
      ...base.stream,
      readable: base.stream.readable.pipeThrough(new TransformStream({
        transform(message, controller) {
          const raw = message as unknown as { method?: string; params?: { update?: { sessionUpdate?: string } } };
          if (raw.params?.update?.sessionUpdate) updates.push(raw.params.update.sessionUpdate);
          controller.enqueue(message);
        },
      })),
      writable,
    } };
  };

  const pipes: WorkerControlChannel[] = [];
  let host!: RunRuntime;
  const tapEntry = join(import.meta.dir, "../support/mcp-env-tap.ts");
  const sidecarEntry = join(import.meta.dir, "../../src/desktop/engine-main.ts");
  const envLog = join(root, "mcp-env.json");
  const framesLog = join(root, "mcp-frames.ndjson");
  const createControlMcp = (identity: { runId: string; nodeId: string; agentSessionId: string; capability: string; resultSchema?: Record<string, unknown> }, scratch?: string): acp.McpServer => {
    const pipe = new WorkerControlChannel(host.createControlServer(), identity, undefined, scratch);
    pipes.push(pipe);
    return { name: "wave-flow-worker-control", command: process.execPath, args: [tapEntry, sidecarEntry, envLog, framesLog], env: [
      { name: "WF_WORKER_CONTROL_SOCKET", value: pipe.endpoints.socketPath },
      ...(identity.resultSchema ? [{ name: "WF_WORKER_RESULT_SCHEMA", value: JSON.stringify(identity.resultSchema) }] : []),
    ], close: () => pipe.close() } as acp.McpServer;
  };
  // 不走 owned 路径：需要一个可观测的底层 transport 来读取真实协议帧。
  const executor = new RuntimeAcpWorkerExecutor(
    registry,
    createControlMcp,
    (value, provenance) => new AcpWorkerExecutor(value, (item) => new AcpSessionClient(item, tapped, "allow", { compaction: true }), provenance, createControlMcp),
    null,
  );
  const workflow: WorkflowModule<JsonObject, unknown> = {
    meta: { name: "context-acceptance", description: "抗压缩真机验收", phases: [{ title: "read" }] },
    default: async () => { phase("read"); return agent(`仅读取${inside}，确认内容是INSIDE_42加换行。不要修改任何文件、安装依赖或联网。结果返回{ok:true}。`, { id: "reader", cli, sandbox: "read-only", schema }); },
  };
  host = await RunRuntime.create({ workflow, input: {}, workflowSource: "context-acceptance", workflowPath: join(root, "workflow.ts"), workflowProjectCwd: cwd, clientRequestId: crypto.randomUUID(), executor, storeRoot: join(root, "runs") });
  const control = host.createControlServer(); host.createControlServer = () => control; executor.bindControl(control);
  console.log(JSON.stringify({ root, runId: host.snapshot().id }));
  try {
    expect(await host.run(workflow)).toEqual({ ok: true });
    expect(host.snapshot().status).toBe("completed");
    // 客户端广告了压缩契约：真实适配器据此才会发 compaction_update。
    expect(initializeCapabilities).toMatchObject({ session: { compaction: {} } });
    // 真实 CLI 上报了上下文占用事实，宿主消费它而不改变节点状态。
    expect(updates).toContain("usage_update");
    // 节点 resultSchema 穿过了真实适配器拉起的 MCP 子进程。
    const env = JSON.parse(await Bun.file(envLog).text()) as Record<string, string>;
    expect(env.WF_WORKER_RESULT_SCHEMA).toBe(JSON.stringify(schema));
    // 真实线上工具声明里，完成工具的 result 属性就是节点 Schema：模型看到的是签名，不是散文。
    const lines = (await Bun.file(framesLog).text()).split("\n").filter((line) => line.trim());
    const listed = lines.map((line) => JSON.parse(line) as { result?: { tools?: { name: string; inputSchema?: { properties?: Record<string, unknown> } }[] } })
      .find((message) => message.result?.tools);
    expect(listed).toBeDefined();
    const complete = listed!.result!.tools!.find((tool) => tool.name === "wave_flow_complete");
    expect(complete?.inputSchema?.properties?.result).toEqual(schema);
  } finally { pipes.forEach(pipe => pipe.close()); }
}, 180_000);

/**
 * 真机验收：真实压缩必须真的发出 compaction_update。
 *
 * 通过 CODEX_CONFIG 把本次会话的上下文窗口与自动压缩阈值调到很小，
 * 让真实 Codex 在一个普通任务里真的发生上下文压缩；没有压缩就没有证据。
 */
test.skipIf(process.env.WF_REAL_COMPACTION_ACCEPTANCE !== "1")("真实CLI：压缩发生并发出结构化压缩事实", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-real-compaction-"))), cwd = join(root, "project");
  await mkdir(cwd);
  const inside = join(cwd, "inside.txt");
  await writeFile(inside, "INSIDE_42\n");
  await writeFile(join(root, "workflow.ts"), "compaction-acceptance");
  const cli = "codex";
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
  const registry = new CliRuntimeRegistry();
  const runtime = await registry.resolveWorker(cli);
  const base = resolveWorkerLauncher(runtime);
  // 极小的上下文窗口与压缩阈值：真实 CLI 必然在本轮内触发一次压缩。
  const codexConfig = JSON.stringify({ model_context_window: 32000, model_auto_compact_token_limit: 16000 });

  const updates: string[] = [];
  let initializeCapabilities: unknown;
  const tapped: AcpTransportFactory = async (value, signal) => {
    const base2 = await bunAcpTransport(value, signal);
    const writer = base2.stream.writable.getWriter();
    const writable = new WritableStream<unknown>({
      write(message) {
        const raw = message as { method?: string; params?: { clientCapabilities?: unknown } };
        if (raw.method === "initialize") initializeCapabilities = raw.params?.clientCapabilities;
        return writer.write(message as never);
      },
      close() { return writer.close(); },
      abort(reason?: unknown) { return writer.abort(reason); },
    });
    return { ...base2, stream: {
      ...base2.stream,
      readable: base2.stream.readable.pipeThrough(new TransformStream({
        transform(message, controller) {
          const raw = message as unknown as { params?: { update?: { sessionUpdate?: string; used?: number; size?: number; compactionId?: string; status?: string } } };
          const update = raw.params?.update;
          if (update?.sessionUpdate) {
            updates.push(update.sessionUpdate);
            // 逐条落盘：即使真机超时，已发生的证据也留在日志里。
            console.log(JSON.stringify({ update: update.sessionUpdate, used: update.used, size: update.size, compactionId: update.compactionId, status: update.status }));
          }
          controller.enqueue(message);
        },
      })),
      writable,
    } };
  };

  const pipes: WorkerControlChannel[] = [];
  let host!: RunRuntime;
  const createControlMcp = (identity: { runId: string; nodeId: string; agentSessionId: string; capability: string; resultSchema?: Record<string, unknown> }, scratch?: string): acp.McpServer => {
    const pipe = new WorkerControlChannel(host.createControlServer(), identity, undefined, scratch);
    pipes.push(pipe);
    return { name: "wave-flow-worker-control", command: process.execPath, args: [join(import.meta.dir, "../../src/desktop/engine-main.ts"), "__worker-mcp"], env: [
      { name: "WF_WORKER_CONTROL_SOCKET", value: pipe.endpoints.socketPath },
      ...(identity.resultSchema ? [{ name: "WF_WORKER_RESULT_SCHEMA", value: JSON.stringify(identity.resultSchema) }] : []),
    ], close: () => pipe.close() } as acp.McpServer;
  };
  const executor = new RuntimeAcpWorkerExecutor(
    registry,
    createControlMcp,
    (value, provenance) => new AcpWorkerExecutor(
      // CODEX_CONFIG 由 codex-acp 翻译成 app-server 的会话配置覆盖：本次会话用极小窗口与压缩阈值。
      { ...value, env: { ...value.env, CODEX_CONFIG: codexConfig } },
      (item) => new AcpSessionClient(item, tapped, "allow", { compaction: true }),
      provenance,
      createControlMcp,
    ),
    null,
  );
  // 任务本身产生足够多的输出，把真实会话推过自动压缩阈值。
  const workflow: WorkflowModule<JsonObject, unknown> = {
    meta: { name: "compaction-acceptance", description: "真实压缩验收", phases: [{ title: "work" }] },
    default: async () => { phase("work"); return agent(`读取${inside}确认内容是INSIDE_42加换行；然后在当前目录创建 notes.md，写入 300 行编号文本（每行形如"第 N 行：占位内容占位内容占位内容"）。不要安装依赖或联网。最后调用完成工具上报结果。`, { id: "writer", cli, sandbox: "workspace-write", schema }); },
  };
  host = await RunRuntime.create({ workflow, input: {}, workflowSource: "compaction-acceptance", workflowPath: join(root, "workflow.ts"), workflowProjectCwd: cwd, clientRequestId: crypto.randomUUID(), executor, storeRoot: join(root, "runs") });
  const control = host.createControlServer(); host.createControlServer = () => control; executor.bindControl(control);
  console.log(JSON.stringify({ root, runId: host.snapshot().id }));
  try {
    await host.run(workflow);
    console.log(JSON.stringify({ updates: [...new Set(updates)], status: host.snapshot().status }));
    // 客户端广告了压缩契约。
    expect(initializeCapabilities).toMatchObject({ session: { compaction: {} } });
    // 真实 CLI 发生了上下文压缩，并发出结构化压缩事实。
    expect(updates).toContain("compaction_update");
    // 压缩事实落成耐久诊断，可归因。
    const events = (await RunJournal.open(host.snapshot().id, join(root, "runs"))).events;
    expect(events.some((event) => event.type === "log.written" && event.diagnostic !== null && event.diagnostic.includes("上下文压缩"))).toBe(true);
  } finally { pipes.forEach(pipe => pipe.close()); }
}, 300_000);

/**
 * 真机验收：一次运行里的多个 agent() 节点必须拿到**各自不同**的完成工具入参形状。
 *
 * 这是"输出格式从 prompt 约定变成工具类型签名"的核心主张：单节点冒烟只能证明
 * "一个节点的 Schema 进了工具声明"，必须多节点同跑才能证明"每个节点编译出自己那份"。
 * 工作流还带两个 Phase 与一条真实的上游依赖（报告节点用统计节点的结果）。
 */
test.skipIf(process.env.WF_REAL_MULTI_NODE_ACCEPTANCE !== "1")("真实CLI：同一次运行里不同节点拿到不同的完成工具入参", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-real-multi-"))), cwd = join(root, "project");
  await mkdir(cwd);
  const inside = join(cwd, "inside.txt");
  await writeFile(inside, "INSIDE_42\n");
  await writeFile(join(root, "workflow.ts"), "multi-node-acceptance");
  const cli = process.env.WF_REAL_CONTEXT_CLI === "claude" ? "claude" : "codex";
  const statsSchema = { type: "object", properties: { groups: { type: "number" } }, required: ["groups"], additionalProperties: false };
  const reportSchema = { type: "object", properties: { markdown: { type: "string" } }, required: ["markdown"], additionalProperties: false };
  const registry = new CliRuntimeRegistry();
  const runtime = await registry.resolveWorker(cli);
  const logs = join(root, "logs");
  await mkdir(logs);

  const pipes: WorkerControlChannel[] = [];
  let host!: RunRuntime;
  const createControlMcp = (identity: { runId: string; nodeId: string; agentSessionId: string; capability: string; resultSchema?: Record<string, unknown> }, scratch?: string): acp.McpServer => {
    const pipe = new WorkerControlChannel(host.createControlServer(), identity, undefined, scratch);
    pipes.push(pipe);
    // 每个节点一个 sidecar 进程、一份独立日志：据此逐节点核对工具声明。
    const stem = `${identity.nodeId.replace(/[^A-Za-z0-9._-]/g, "_")}-${identity.nodeId.length}`;
    return { name: "wave-flow-worker-control", command: process.execPath, args: [join(import.meta.dir, "../support/mcp-env-tap.ts"), join(import.meta.dir, "../../src/desktop/engine-main.ts"), join(logs, `${stem}.env.json`), join(logs, `${stem}.frames.ndjson`)], env: [
      { name: "WF_WORKER_CONTROL_SOCKET", value: pipe.endpoints.socketPath },
      ...(identity.resultSchema ? [{ name: "WF_WORKER_RESULT_SCHEMA", value: JSON.stringify(identity.resultSchema) }] : []),
    ], close: () => pipe.close() } as acp.McpServer;
  };
  const executor = new RuntimeAcpWorkerExecutor(
    registry,
    createControlMcp,
    (value, provenance) => new AcpWorkerExecutor(value, (item) => new AcpSessionClient(item, undefined, "allow", { compaction: true }), provenance, createControlMcp),
    null,
  );
  const workflow: WorkflowModule<JsonObject, unknown> = {
    meta: { name: "multi-node-acceptance", description: "多节点多签名真机验收", phases: [{ title: "统计" }, { title: "报告" }] },
    default: async () => {
      phase("统计");
      const stats = await agent(`读取${inside}，确认内容是INSIDE_42加换行，把它当作一组数据，返回该组数量。不要修改文件、安装依赖或联网。`, { id: "stats", cli, sandbox: "read-only", schema: statsSchema });
      const plain = await agent(`读取${inside}，确认内容是INSIDE_42加换行，返回一个说明对象。不要修改文件、安装依赖或联网。`, { id: "plain", cli, sandbox: "read-only" });
      phase("报告");
      const report = await agent(`上游统计结果是 ${JSON.stringify(stats)}。据此写一句中文报告，说明读到了什么。不要修改文件、安装依赖或联网。`, { id: "report", cli, sandbox: "read-only", schema: reportSchema });
      return { report, plain };
    },
  };
  host = await RunRuntime.create({ workflow, input: {}, workflowSource: "multi-node-acceptance", workflowPath: join(root, "workflow.ts"), workflowProjectCwd: cwd, clientRequestId: crypto.randomUUID(), executor, storeRoot: join(root, "runs") });
  const control = host.createControlServer(); host.createControlServer = () => control; executor.bindControl(control);
  console.log(JSON.stringify({ root, runId: host.snapshot().id }));
  try {
    const result = await host.run(workflow);
    expect(host.snapshot().status).toBe("completed");
    // 每个节点各自编译出的完成工具声明。
    const declared = new Map<string, unknown>();
    for (const file of await readdir(logs)) {
      if (!file.endsWith(".frames.ndjson")) continue;
      const lines = (await Bun.file(join(logs, file)).text()).split("\n").filter((line) => line.trim());
      const listed = lines.map((line) => JSON.parse(line) as { result?: { tools?: { name: string; inputSchema?: { properties?: Record<string, unknown> } }[] } })
        .find((message) => message.result?.tools);
      const complete = listed?.result?.tools?.find((tool) => tool.name === "wave_flow_complete");
      declared.set(file.replace(/\.frames\.ndjson$/, ""), complete?.inputSchema?.properties?.result);
    }
    console.log(JSON.stringify({ declared: [...declared.entries()] }));
    // 声明形状按节点 id 分开：stats 与 report 必须不同，plain 退回对象形状。
    const byNode = (id: string): unknown => declared.get(`${id}-${id.length}`);
    expect(byNode("stats")).toEqual(statsSchema);
    expect(byNode("report")).toEqual(reportSchema);
    expect(byNode("plain")).toEqual({ type: "object" });
    expect(byNode("stats")).not.toEqual(byNode("report"));
    // 报告节点的结果必须符合它自己的签名。
    expect(result).toMatchObject({ report: { markdown: expect.any(String) } });
  } finally { pipes.forEach(pipe => pipe.close()); }
}, 300_000);
