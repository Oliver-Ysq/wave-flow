import { withDeadline } from "../fixtures/deadline";
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
      { name: "WF_WORKER_CONTROL_SOCKET", value: pipe.endpoints.socketPath }, { name: "WF_WORKER_CONTROL_CAPABILITY", value: identity.capability },
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
    expect(await withDeadline(host.run(workflow), 150_000, "上下文能力验收")).toEqual({ ok: true });
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
  const cli = process.env.WF_REAL_COMPACTION_CLI === "claude" ? "claude" : "codex";
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
  const registry = new CliRuntimeRegistry();
  const runtime = await registry.resolveWorker(cli);
  const base = resolveWorkerLauncher(runtime);
  // 极小的上下文窗口与压缩阈值：真实 CLI 必然在本轮内触发一次压缩。
  // Codex 走 CODEX_CONFIG 的会话配置覆盖；Claude Code 走它自己的两个环境变量。
  // Claude 窗口有 100k 下限，阈值必须高于会话基线（系统提示 + 工具 + 任务），否则
  // 压缩后立刻回填会触发 "Autocompact is thrashing" 并拒绝继续；10% ≈ 10k 是实测可用的值。
  const codexConfig = JSON.stringify({ model_context_window: 32000, model_auto_compact_token_limit: 16000 });
  const cliEnv: Record<string, string> = cli === "claude"
    ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "10" }
    : { CODEX_CONFIG: codexConfig };

  const updates: string[] = [];
  const sessionNewPrompts: unknown[] = [];
  let promptCount = 0;
  let initializeCapabilities: unknown;
  const tapped: AcpTransportFactory = async (value, signal) => {
    const base2 = await bunAcpTransport(value, signal);
    const writer = base2.stream.writable.getWriter();
    const writable = new WritableStream<unknown>({
      write(message) {
        const raw = message as { method?: string; params?: { clientCapabilities?: unknown; systemPrompt?: unknown } };
        if (raw.method === "initialize") initializeCapabilities = raw.params?.clientCapabilities;
        if (raw.method === "session/new" && raw.params?.systemPrompt !== undefined) sessionNewPrompts.push(raw.params.systemPrompt);
        if (raw.method === "session/prompt") promptCount += 1;
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
      { name: "WF_WORKER_CONTROL_SOCKET", value: pipe.endpoints.socketPath }, { name: "WF_WORKER_CONTROL_CAPABILITY", value: identity.capability },
      ...(identity.resultSchema ? [{ name: "WF_WORKER_RESULT_SCHEMA", value: JSON.stringify(identity.resultSchema) }] : []),
    ], close: () => pipe.close() } as acp.McpServer;
  };
  const executor = new RuntimeAcpWorkerExecutor(
    registry,
    createControlMcp,
    (value, provenance) => new AcpWorkerExecutor(
      // 压缩相关的 CLI 配置由 adapter 转发给真实 CLI：本用例用极小窗口与阈值逼出真实压缩。
      { ...value, env: { ...value.env, ...cliEnv } },
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
  // 真实 gateway 偶发长时间无响应；Bun 的测试超时在部分等待形态下不会及时打断，
  // 这里再加一条显式的硬截止，失败要快且可诊断，不能把验收挂成十几分钟。
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const hardDeadline = new Promise<never>((_, reject) => {
    hardTimer = setTimeout(() => reject(new Error("压缩验收超过 360s 未完成")), 360_000);
  });
  try {
    await Promise.race([host.run(workflow), hardDeadline]);
    console.log(JSON.stringify({ updates: [...new Set(updates)], status: host.snapshot().status }));
    // 客户端广告了压缩契约。
    expect(initializeCapabilities).toMatchObject({ session: { compaction: {} } });
    // 真实 CLI 发生了上下文压缩，并发出结构化压缩事实。
    expect(updates).toContain("compaction_update");
    // 压缩事实落成耐久诊断，可归因。
    const events = (await RunJournal.open(host.snapshot().id, join(root, "runs"))).events;
    const compactionFacts = events.filter((event) => event.type === "log.written" && event.diagnostic !== null && event.diagnostic.includes("上下文压缩"));
    expect(compactionFacts.length).toBeGreaterThan(0);
    // 完成协议走会话系统提示：真实 session/new 必须带上 append 文本，而不是只内联在用户消息里。
    const systemPrompt = sessionNewPrompts.at(-1) as { mode?: string; content?: { type?: string; text?: string }[] } | undefined;
    expect(systemPrompt?.mode).toBe("append");
    const systemText = (systemPrompt?.content ?? []).map((block) => block.text ?? "").join("\n");
    expect(systemText).toContain("受管节点完成协议");
    expect(systemText).toContain("wave-flow-worker-control");
    // 压缩之后仍然完成：完成事实必须晚于最后一次压缩诊断，证明协议在压缩后依然可用。
    expect(host.snapshot().status).toBe("completed");
    const completed = events.find((event) => event.type === "agent.completed");
    expect(completed).toBeDefined();
    if (completed) expect(Date.parse(completed.at)).toBeGreaterThanOrEqual(Date.parse(compactionFacts.at(-1)!.at));
    // 本次完成来自模型自己的首轮，而不是宿主提醒兜底：线上只有一条 session/prompt。
    // 这条断言区分“协议在压缩后仍被模型看到”与“宿主事后提醒救了场”。
    expect(promptCount).toBe(1);
  } finally { if (hardTimer) clearTimeout(hardTimer); pipes.forEach(pipe => pipe.close()); }
}, 480_000);

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
      { name: "WF_WORKER_CONTROL_SOCKET", value: pipe.endpoints.socketPath }, { name: "WF_WORKER_CONTROL_CAPABILITY", value: identity.capability },
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
    const result = await withDeadline(host.run(workflow), 360_000, "多节点验收");
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
}, 480_000);

/**
 * 验收替身：拦掉前 N 次 `wave_flow_complete`，对模型伪造成"上报成功"。
 *
 * 模型会以为已完成并结束回合，但 Control 从未收到 complete——这正是"漏报"的真实形态。
 * 宿主随后必须在同一 session 发提醒回合；该用例验收的是那条兜底路径，而不是模型自觉。
 */
const swallowCompleteProxySource = `import { appendFileSync } from "node:fs";
const trace = process.env.WF_MCP_TRACE;
let swallowed = 0;
const limit = Number(process.env.WF_MCP_SWALLOW_COMPLETES ?? "1");
const record = (entry) => { if (trace) appendFileSync(trace, JSON.stringify(entry) + "\\n"); };
const [command, ...args] = process.argv.slice(2);
const child = Bun.spawn([command, ...args], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: process.env });
async function pumpLines(source, onLine) {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of source) {
    buffered += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffered.indexOf("\\n")) >= 0) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (line) onLine(line);
    }
  }
}
const inbound = pumpLines(process.stdin, line => {
  const message = JSON.parse(line);
  if (message.method === "tools/call" && message.params?.name === "wave_flow_complete" && swallowed < limit) {
    swallowed += 1;
    record({ swallowed: swallowed, id: message.id });
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "上报成功" }], isError: false } }) + "\\n");
    return;
  }
  child.stdin.write(line + "\\n");
}).then(() => child.stdin.end());
const outbound = pumpLines(child.stdout, line => process.stdout.write(line + "\\n"));
const [code] = await Promise.all([child.exited, inbound, outbound]);
process.exit(code);
`;

test.skipIf(process.env.WF_REAL_REMINDER_ACCEPTANCE !== "1")("真实CLI：压缩后漏报由提醒回合补交，不重做业务", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-real-reminder-"))), cwd = join(root, "project");
  await mkdir(cwd);
  await writeFile(join(cwd, "inside.txt"), "INSIDE_42\n");
  await writeFile(join(root, "workflow.ts"), "reminder-acceptance");
  const cli = process.env.WF_REAL_REMINDER_CLI === "claude" ? "claude" : "codex";
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
  const registry = new CliRuntimeRegistry();
  await registry.resolveWorker(cli);
  const codexConfig = JSON.stringify({ model_context_window: 32000, model_auto_compact_token_limit: 16000 });
  const compactionEnv: Record<string, string> = cli === "claude"
    ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "10" }
    : { CODEX_CONFIG: codexConfig };

  const prompts: string[] = [];
  const updates: string[] = [];
  const tapped: AcpTransportFactory = async (value, signal) => {
    const base2 = await bunAcpTransport(value, signal);
    const writer = base2.stream.writable.getWriter();
    const writable = new WritableStream<unknown>({
      write(message) {
        const raw = message as { method?: string; params?: { prompt?: { type?: string; text?: string }[] } };
        if (raw.method === "session/prompt") prompts.push((raw.params?.prompt ?? []).map(block => block.type === "text" ? block.text ?? "" : "").join("\n"));
        return writer.write(message as never);
      },
      close() { return writer.close(); },
      abort(reason?: unknown) { return writer.abort(reason); },
    });
    return { ...base2, stream: {
      ...base2.stream,
      readable: base2.stream.readable.pipeThrough(new TransformStream({
        transform(message, controller) {
          const raw = message as unknown as { params?: { update?: { sessionUpdate?: string } } };
          if (raw.params?.update?.sessionUpdate) updates.push(raw.params.update.sessionUpdate);
          controller.enqueue(message);
        },
      })),
      writable,
    } };
  };

  const pipes: WorkerControlChannel[] = [];
  let host!: RunRuntime;
  const proxy = join(root, "swallow-complete-proxy.ts");
  await writeFile(proxy, swallowCompleteProxySource);
  const createControlMcp = (identity: { readonly runId: string; readonly nodeId: string; readonly agentSessionId: string; readonly capability: string; readonly resultSchema?: Record<string, unknown> }) => {
    const pipe = new WorkerControlChannel(host.createControlServer(), identity, undefined, undefined);
    pipes.push(pipe);
    return {
      name: "wave-flow-worker-control", command: process.execPath,
      args: [proxy, process.execPath, join(import.meta.dir, "../../src/desktop/engine-main.ts"), "__worker-mcp"],
      env: [
        { name: "WF_WORKER_CONTROL_SOCKET", value: pipe.endpoints.socketPath },
        { name: "WF_WORKER_CONTROL_CAPABILITY", value: identity.capability },
        { name: "WF_MCP_SWALLOW_COMPLETES", value: "2" },
      ],
      close: () => pipe.close(),
    } as acp.McpServer;
  };
  const executor = new RuntimeAcpWorkerExecutor(
    registry,
    createControlMcp,
    (value, provenance) => new AcpWorkerExecutor(
      { ...value, env: { ...value.env, ...compactionEnv } },
      (item) => new AcpSessionClient(item, tapped, "allow", { compaction: true }),
      provenance,
      createControlMcp,
    ),
    null,
  );
  const workflow: WorkflowModule<JsonObject, unknown> = {
    meta: { name: "reminder-acceptance", description: "压缩后漏报提醒验收", phases: [{ title: "work" }] },
    default: async () => { phase("work"); return agent(`读取${join(cwd, "inside.txt")}确认内容是INSIDE_42加换行；然后在当前目录创建 notes.md，写入 300 行编号文本（每行形如"第 N 行：占位内容占位内容占位内容"）。不要安装依赖或联网。完成后按完成协议上报结果。`, { id: "writer", cli, sandbox: "workspace-write", schema }); },
  };
  host = await RunRuntime.create({ workflow, input: {}, workflowSource: "reminder-acceptance", workflowPath: join(root, "workflow.ts"), workflowProjectCwd: cwd, clientRequestId: crypto.randomUUID(), executor, storeRoot: join(root, "runs") });
  const control = host.createControlServer(); host.createControlServer = () => control; executor.bindControl(control);
  console.log(JSON.stringify({ root, runId: host.snapshot().id, cli }));
  try {
    expect(await withDeadline(host.run(workflow), 420_000, "提醒兜底验收")).toEqual({ ok: true });
    expect(host.snapshot().status).toBe("completed");
    // 真实压缩发生过，提醒回合发生在压缩之后。
    expect(updates).toContain("compaction_update");
    // 第一次上报被替身吞掉：模型结束回合，宿主在同一 session 发提醒补交。
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect(prompts.slice(1).some(text => text.includes("尚未收到 complete"))).toBe(true);
    // 仍只有一个会话，且没有靠重跑业务来"假装完成"。
    const events = (await RunJournal.open(host.snapshot().id, join(root, "runs"))).events;
    expect(events.filter(event => event.type === "agent.session")).toHaveLength(1);
    expect(events.filter(event => event.type === "agent.restarted")).toHaveLength(0);
    expect(events.filter(event => event.type === "agent.completed")).toHaveLength(1);
    expect(await Bun.file(join(cwd, "notes.md")).text()).toContain("第 300 行");
  } finally { pipes.forEach(pipe => pipe.close()); }
}, 480_000);

/**
 * 真机验收：`session/load` 续用原 ACP 会话，并在 load 时重发同一份系统提示。
 *
 * 只验证 adapter 的 load 能力与上下文连续性，不涉及 Engine 恢复编排：
 * 先在一个 provider 进程里建立会话并让模型记住一个数字，关闭进程后在新进程里 load，
 * 再问"那个数字加一"——答对说明会话上下文真的续上了。
 */
test.skipIf(process.env.WF_REAL_LOAD_ACCEPTANCE !== "1")("真实CLI：session/load 续用原会话并重发系统提示", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-real-load-"))), cwd = join(root, "project");
  await mkdir(cwd);
  const cli = process.env.WF_REAL_LOAD_CLI === "claude" ? "claude" : "codex";
  const registry = new CliRuntimeRegistry();
  const runtime = await registry.resolveWorker(cli);
  const launcher = resolveWorkerLauncher(runtime);
  const systemPrompt = { mode: "append" as const, text: "PROBE_SYSTEM: 本会话用于 session/load 真机验收，不要修改文件或联网。" };

  const loadPrompts: unknown[] = [];
  const tapped: AcpTransportFactory = async (value, signal) => {
    const base2 = await bunAcpTransport(value, signal);
    const writer = base2.stream.writable.getWriter();
    const writable = new WritableStream<unknown>({
      write(message) {
        const raw = message as { method?: string; params?: { systemPrompt?: unknown } };
        if (raw.method === "session/load" && raw.params?.systemPrompt !== undefined) loadPrompts.push(raw.params.systemPrompt);
        return writer.write(message as never);
      },
    });
    return { ...base2, stream: { ...base2.stream, writable } };
  };

  let firstText = "";
  const first = new AcpSessionClient(launcher, tapped, "allow", { compaction: true });
  const unsubscribeFirst = first.subscribe(event => {
    const update = event.update as { sessionUpdate?: string; content?: { type?: string; text?: string } };
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") firstText += update.content.text ?? "";
  });
  let sessionId = "";
  try {
    await first.initialize(AbortSignal.timeout(30_000));
    const binding = await first.createSession(cwd, AbortSignal.timeout(90_000), [], undefined, { systemPrompt });
    sessionId = binding.sessionId;
    expect((await first.prompt("请记住数字 41，稍后我会问。只回复 OK。", AbortSignal.timeout(120_000))).stopReason).toBe("end_turn");
    expect(firstText.length).toBeGreaterThan(0);
  } finally {
    unsubscribeFirst();
    first.close();
  }

  let answer = "";
  const second = new AcpSessionClient(launcher, tapped, "allow", { compaction: true });
  const unsubscribeSecond = second.subscribe(event => {
    const update = event.update as { sessionUpdate?: string; content?: { type?: string; text?: string } };
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") answer += update.content.text ?? "";
  });
  try {
    await second.initialize(AbortSignal.timeout(30_000));
    // 旧 provider 关闭后 Codex 释放 thread writer 有短暂延迟；真实恢复也用围栏等待旧写者消失。
    // 这里按同样的语义重试有界次数，不把“刚关掉就 load”的竞态当失败。
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        await second.loadSession(sessionId, cwd, AbortSignal.timeout(120_000), [], undefined, { systemPrompt });
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const busy = message.includes("in use by another Codex client") || message.includes("active writer");
        if (!busy || Date.now() > deadline) throw error;
        await Bun.sleep(500);
      }
    }
    expect((await second.prompt("刚才让你记住的数字加 1 是多少？只回复那个数字。", AbortSignal.timeout(120_000))).stopReason).toBe("end_turn");
  } finally {
    unsubscribeSecond();
    second.close();
  }
  // 上下文真的续上了：新进程里能答对只有上一进程知道的数字。
  expect(answer).toContain("42");
  // load 时重发了同一份 append 系统提示。
  const resent = loadPrompts.at(-1) as { mode?: string; content?: { text?: string }[] } | undefined;
  expect(resent?.mode).toBe("append");
  expect((resent?.content ?? []).map(block => block.text ?? "").join("")).toContain("PROBE_SYSTEM");
}, 300_000);
