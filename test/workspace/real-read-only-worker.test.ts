import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { CliRuntimeRegistry } from "../../src/runtimes/registry";
import { RuntimeAcpWorkerExecutor } from "../../src/runtime/runtime-acp-worker-executor";
import { AcpWorkerExecutor } from "../../src/runtime/acp-worker-executor";
import { WorkerControlChannel } from "../../src/runtime/worker-control-channel";
import { RunRuntime } from "../../src/runtime/run-runtime";
import { RunJournal } from "../../src/journal/run-journal";
import { agent, phase } from "../../src/workflow/author-api";
import type { WorkflowModule } from "../../src/shared/workflow-types";
import type { JsonObject } from "../../src/shared/json";

// 真实模型仅用户显式验收时开启；现场保留，不自动清除文件证据。
test.skipIf(process.env.WF_REAL_READ_ONLY_WORKER_ACCEPTANCE !== "1")("真实只读Worker跨目录读并经Control完成，不改变文件", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-real-read-only-"))), cwd = join(root, "project");
  await mkdir(cwd); const inside = join(cwd, "inside.txt"), outside = join(root, "outside.txt");
  await writeFile(inside, "INSIDE_42\n"); await writeFile(outside, "OUTSIDE_73\n");
  await writeFile(join(root, "workflow.ts"), "read-only-acceptance");
  const requestedCli = process.env.WF_REAL_READ_ONLY_WORKER_CLI;
  const cli = requestedCli === "claude" || requestedCli === "kimi" ? requestedCli : "codex";
  const registry = new CliRuntimeRegistry(); await registry.resolveWorker(cli);
  const pipes: WorkerControlChannel[] = [];
  let runtime!: RunRuntime;
  const executor = new RuntimeAcpWorkerExecutor(registry, (identity, scratch) => {
    const pipe = new WorkerControlChannel(runtime.createControlServer(), identity, undefined, scratch); pipes.push(pipe);
    return { name: "wave-flow-worker-control", command: process.execPath, args: [join(import.meta.dir, "../../src/desktop/engine-main.ts"), "__worker-mcp"], env: [{ name: "WF_WORKER_CONTROL_SOCKET", value: pipe.endpoints.socketPath }, { name: "WF_WORKER_CONTROL_CAPABILITY", value: identity.capability }], close: () => pipe.close() } as acp.McpServer;
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

/** 客户端超时只注入一次 tools/call 取消；真实 CLI、ACP Adapter、Executor 与 Journal 均走生产实现。 */
test.skipIf(process.env.WF_REAL_MCP_TIMEOUT_ACCEPTANCE !== "1")("真实CLI客户端MCP工具超时后保持blocked，用户重开原block并完成", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-real-mcp-timeout-"))), cwd = join(root, "project");
  await mkdir(cwd);
  await writeFile(join(root, "workflow.ts"), "mcp-timeout-acceptance");
  const proxy = join(root, "mcp-timeout-proxy.ts");
  await writeFile(proxy, timeoutProxySource);
  const cli = process.env.WF_REAL_MCP_TIMEOUT_CLI === "claude" ? "claude" : "codex";
  const registry = new CliRuntimeRegistry(); await registry.resolveWorker(cli);
  const pipes: WorkerControlChannel[] = [];
  let runtime!: RunRuntime;
  const executor = new RuntimeAcpWorkerExecutor(registry, (identity, scratch) => {
    const pipe = new WorkerControlChannel(runtime.createControlServer(), identity, undefined, scratch); pipes.push(pipe);
    return {
      name: "wave-flow-worker-control", command: process.execPath,
      args: [proxy, process.execPath, join(import.meta.dir, "../../src/desktop/engine-main.ts"), "__worker-mcp"],
      env: [{ name: "WF_WORKER_CONTROL_SOCKET", value: pipe.endpoints.socketPath }, { name: "WF_WORKER_CONTROL_CAPABILITY", value: identity.capability }, { name: "WF_MCP_INJECT_TIMEOUT", value: "1" }],
      close: () => pipe.close(),
    } as acp.McpServer;
  }, undefined, null, join(root, "scratch"));
  const workflow: WorkflowModule<JsonObject, unknown> = {
    meta: { name: "mcp-timeout-acceptance", description: "客户端 MCP 工具超时恢复验收", phases: [{ title: "ask" }] },
    default: async () => { phase("ask"); return agent("不要修改文件或联网。必须调用 wave_flow_block，needHelp 写“请确认继续”，answerSchema 只含必填 boolean 字段 ok。若本次等待被关闭，不要新建 block；宿主会用原请求恢复。收到 answered 后调用 wave_flow_complete，结果返回{ok:true}。", { id: "asker", cli, sandbox: "read-only", schema: { type: "object", properties: { ok: { type: "boolean", const: true } }, required: ["ok"], additionalProperties: false } }); },
  };
  runtime = await RunRuntime.create({ workflow, input: {}, workflowSource: "mcp-timeout-acceptance", workflowPath: join(root, "workflow.ts"), workflowProjectCwd: cwd, clientRequestId: crypto.randomUUID(), executor, storeRoot: join(root, "runs") });
  const control = runtime.createControlServer(); runtime.createControlServer = () => control; executor.bindControl(control);
  console.log(JSON.stringify({ root, runId: runtime.snapshot().id, cli }));
  const running = runtime.run(workflow);
  let runFailure: unknown = null;
  void running.catch(error => { runFailure = error; });
  const waitFor = async (predicate: () => boolean, label: string) => {
    for (let index = 0; index < 1_200; index += 1) {
      if (runFailure) throw runFailure;
      if (predicate()) return;
      await Bun.sleep(50);
    }
    throw new Error(`真实 MCP 超时验收等待${label}超时。`);
  };
  try {
    await waitFor(() => runtime.snapshot().phases[0]?.agents[0]?.block?.delivery === "closed", "客户端关闭表单");
    const blocked = runtime.snapshot().phases[0]!.agents[0]!;
    expect(blocked.status).toBe("blocked");
    expect(runtime.snapshot().status).toBe("running");
    const blockRequestId = blocked.block!.blockRequestId;
    const agentSessionId = blocked.agentSessionId;
    await runtime.reopenBlock(blockRequestId);
    await waitFor(() => runtime.snapshot().phases[0]?.agents[0]?.block?.delivery === "pending", "原表单重开");
    await control.answer({ blockRequestId, answer: { ok: true } });
    expect(await running).toEqual({ ok: true });
    expect(runtime.snapshot().status).toBe("completed");
    expect(runtime.snapshot().phases[0]!.agents[0]!.agentSessionId).toBe(agentSessionId);
    const events = (await RunJournal.open(runtime.snapshot().id, join(root, "runs"))).events;
    expect(events.filter(event => event.type === "block.created")).toHaveLength(1);
    expect(events.filter(event => event.type === "block.closed")).toHaveLength(1);
    expect(events.filter(event => event.type === "block.reopened")).toHaveLength(1);
    expect(events.filter(event => event.type === "block.answered")).toHaveLength(1);
    expect(events.filter(event => event.type === "agent.continued")).toHaveLength(1);
    expect(events.filter(event => event.type === "agent.session")).toHaveLength(1);
    expect(events.filter(event => event.type === "agent.restarted")).toHaveLength(0);
  } finally {
    if (["running", "pausing", "paused", "recovering"].includes(runtime.snapshot().status)) await runtime.stop().catch(() => undefined);
    await running.catch(() => undefined);
    pipes.forEach(pipe => pipe.close());
  }
}, 240_000);

/** 仅在临时 Adapter 副本注入 10 秒工具超时，记录真实 Codex 自己的超时响应。 */
test.skipIf(process.env.WF_REAL_CODEX_TIMEOUT_ACCEPTANCE !== "1")("真实Codex 10秒MCP工具超时关闭Elicitation并可在原会话重开", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-real-codex-timeout-"))), cwd = join(root, "project");
  await mkdir(cwd);
  await writeFile(join(root, "workflow.ts"), "codex-timeout-acceptance");
  const proxy = join(root, "mcp-trace-proxy.ts"), trace = join(root, "mcp-frames.jsonl"), adapter = join(root, "codex-acp-10s.js");
  await writeFile(proxy, timeoutProxySource);
  const adapterSource = await Bun.file(Bun.resolveSync("@agentclientprotocol/codex-acp", import.meta.dir)).text();
  const marker = '"env": Object.fromEntries(mcpServer.env.map((env) => [env.name, env.value]))';
  if (!adapterSource.includes(marker)) throw new Error("Codex Adapter MCP 配置锚点已变化。");
  await writeFile(adapter, adapterSource.replace(marker, `${marker},\n      "tool_timeout_sec": 10`));
  const registry = new CliRuntimeRegistry(); await registry.resolveWorker("codex");
  const pipes: WorkerControlChannel[] = [];
  let runtime!: RunRuntime;
  const createControlMcp = (identity: { readonly runId: string; readonly nodeId: string; readonly agentSessionId: string; readonly capability: string }, scratch?: string) => {
    const pipe = new WorkerControlChannel(runtime.createControlServer(), identity, undefined, scratch); pipes.push(pipe);
    return {
      name: "wave-flow-worker-control", command: process.execPath,
      args: [proxy, process.execPath, join(import.meta.dir, "../../src/desktop/engine-main.ts"), "__worker-mcp"],
      env: [{ name: "WF_WORKER_CONTROL_SOCKET", value: pipe.endpoints.socketPath }, { name: "WF_WORKER_CONTROL_CAPABILITY", value: identity.capability }, { name: "WF_MCP_TRACE", value: trace }],
      close: () => pipe.close(),
    } as acp.McpServer;
  };
  const executor = new RuntimeAcpWorkerExecutor(registry, createControlMcp, (launcher, provenance) => new AcpWorkerExecutor({ ...launcher, args: [adapter] }, undefined, provenance, createControlMcp));
  const workflow: WorkflowModule<JsonObject, unknown> = {
    meta: { name: "codex-timeout-acceptance", description: "Codex 真实 MCP 工具超时验收", phases: [{ title: "ask" }] },
    default: async () => { phase("ask"); return agent("不要修改文件或联网。必须调用 wave_flow_block，needHelp 写“请确认继续”，answerSchema 只含必填 boolean 字段 ok。若本次等待被关闭，不要新建 block；宿主会用原请求恢复。收到 answered 后调用 wave_flow_complete，结果返回{ok:true}。", { id: "asker", cli: "codex", sandbox: "read-only", schema: { type: "object", properties: { ok: { type: "boolean", const: true } }, required: ["ok"], additionalProperties: false } }); },
  };
  runtime = await RunRuntime.create({ workflow, input: {}, workflowSource: "codex-timeout-acceptance", workflowPath: join(root, "workflow.ts"), workflowProjectCwd: cwd, clientRequestId: crypto.randomUUID(), executor, storeRoot: join(root, "runs") });
  const control = runtime.createControlServer(); runtime.createControlServer = () => control; executor.bindControl(control);
  console.log(JSON.stringify({ root, runId: runtime.snapshot().id, trace }));
  const running = runtime.run(workflow);
  let runFailure: unknown = null;
  void running.catch(error => { runFailure = error; });
  const waitFor = async (predicate: () => boolean, label: string) => {
    for (let index = 0; index < 1_200; index += 1) {
      if (runFailure) throw runFailure;
      if (predicate()) return;
      await Bun.sleep(50);
    }
    throw new Error(`真实 Codex 超时验收等待${label}超时。`);
  };
  try {
    await waitFor(() => runtime.snapshot().phases[0]?.agents[0]?.block?.delivery === "closed", "Codex 自己关闭表单");
    const frames = (await Bun.file(trace).text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { direction: string; method?: string; action?: string });
    console.log(JSON.stringify({ timeoutFrames: frames.filter(frame => frame.method === "notifications/cancelled" || frame.action !== undefined) }));
    expect(frames.some(frame => frame.direction === "client->server" && frame.action === "decline")).toBe(true);
    const blocked = runtime.snapshot().phases[0]!.agents[0]!;
    const blockRequestId = blocked.block!.blockRequestId, agentSessionId = blocked.agentSessionId;
    await runtime.reopenBlock(blockRequestId);
    await waitFor(() => runtime.snapshot().phases[0]?.agents[0]?.block?.delivery === "pending", "原表单重开");
    await control.answer({ blockRequestId, answer: { ok: true } });
    expect(await running).toEqual({ ok: true });
    expect(runtime.snapshot().phases[0]!.agents[0]!.agentSessionId).toBe(agentSessionId);
    const events = (await RunJournal.open(runtime.snapshot().id, join(root, "runs"))).events;
    expect(events.filter(event => event.type === "block.created")).toHaveLength(1);
    expect(events.filter(event => event.type === "block.closed")).toHaveLength(1);
    expect(events.filter(event => event.type === "block.reopened")).toHaveLength(1);
    expect(events.filter(event => event.type === "agent.restarted")).toHaveLength(0);
  } catch (error) {
    console.error(await Bun.file(trace).text().catch(() => "尚无 MCP 帧"));
    throw error;
  } finally {
    if (["running", "pausing", "paused", "recovering"].includes(runtime.snapshot().status)) await runtime.stop().catch(() => undefined);
    await running.catch(() => undefined);
    pipes.forEach(pipe => pipe.close());
  }
}, 240_000);

/** 只给测试 Worker 注入 10 秒工具超时，记录 Claude Code 自己产生的 MCP 帧。 */
test.skipIf(process.env.WF_REAL_CLAUDE_TIMEOUT_ACCEPTANCE !== "1")("真实Claude 10秒MCP工具超时发送取消并可在原会话重开", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-real-claude-timeout-"))), cwd = join(root, "project");
  await mkdir(cwd);
  await writeFile(join(root, "workflow.ts"), "claude-timeout-acceptance");
  const proxy = join(root, "mcp-trace-proxy.ts"), trace = join(root, "mcp-frames.jsonl");
  await writeFile(proxy, timeoutProxySource);
  const registry = new CliRuntimeRegistry(); await registry.resolveWorker("claude");
  const pipes: WorkerControlChannel[] = [];
  let runtime!: RunRuntime;
  const createControlMcp = (identity: { readonly runId: string; readonly nodeId: string; readonly agentSessionId: string; readonly capability: string }, scratch?: string) => {
    const pipe = new WorkerControlChannel(runtime.createControlServer(), identity, undefined, scratch); pipes.push(pipe);
    return {
      name: "wave-flow-worker-control", command: process.execPath,
      args: [proxy, process.execPath, join(import.meta.dir, "../../src/desktop/engine-main.ts"), "__worker-mcp"],
      env: [{ name: "WF_WORKER_CONTROL_SOCKET", value: pipe.endpoints.socketPath }, { name: "WF_WORKER_CONTROL_CAPABILITY", value: identity.capability }, { name: "WF_MCP_TRACE", value: trace }],
      close: () => pipe.close(),
    } as acp.McpServer;
  };
  const executor = new RuntimeAcpWorkerExecutor(registry, createControlMcp, (launcher, provenance) => new AcpWorkerExecutor({ ...launcher, env: { ...launcher.env, MCP_TOOL_TIMEOUT: "10000" } }, undefined, provenance, createControlMcp));
  const workflow: WorkflowModule<JsonObject, unknown> = {
    meta: { name: "claude-timeout-acceptance", description: "Claude 真实 MCP 工具超时验收", phases: [{ title: "ask" }] },
    default: async () => { phase("ask"); return agent("不要修改文件或联网。必须调用 wave_flow_block，needHelp 写“请确认继续”，answerSchema 只含必填 boolean 字段 ok。若本次等待被关闭，不要新建 block；宿主会用原请求恢复。收到 answered 后调用 wave_flow_complete，结果返回{ok:true}。", { id: "asker", cli: "claude", sandbox: "read-only", schema: { type: "object", properties: { ok: { type: "boolean", const: true } }, required: ["ok"], additionalProperties: false } }); },
  };
  runtime = await RunRuntime.create({ workflow, input: {}, workflowSource: "claude-timeout-acceptance", workflowPath: join(root, "workflow.ts"), workflowProjectCwd: cwd, clientRequestId: crypto.randomUUID(), executor, storeRoot: join(root, "runs") });
  const control = runtime.createControlServer(); runtime.createControlServer = () => control; executor.bindControl(control);
  console.log(JSON.stringify({ root, runId: runtime.snapshot().id, trace }));
  const running = runtime.run(workflow);
  let runFailure: unknown = null;
  void running.catch(error => { runFailure = error; });
  const waitFor = async (predicate: () => boolean, label: string) => {
    for (let index = 0; index < 1_200; index += 1) {
      if (runFailure) throw runFailure;
      if (predicate()) return;
      await Bun.sleep(50);
    }
    throw new Error(`真实 Claude 超时验收等待${label}超时。`);
  };
  try {
    await waitFor(() => runtime.snapshot().phases[0]?.agents[0]?.block?.delivery === "closed", "Claude 自己关闭表单");
    const frames = (await Bun.file(trace).text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { direction: string; method?: string; action?: string; error?: unknown });
    console.log(JSON.stringify({ timeoutFrames: frames.filter(frame => frame.method === "notifications/cancelled" || frame.action !== undefined || frame.error !== undefined) }));
    expect(frames.some(frame => frame.direction === "client->server" && frame.action === "cancel")).toBe(true);
    expect(frames.some(frame => frame.direction === "client->server" && frame.method === "notifications/cancelled")).toBe(true);
    const blocked = runtime.snapshot().phases[0]!.agents[0]!;
    const blockRequestId = blocked.block!.blockRequestId, agentSessionId = blocked.agentSessionId;
    await runtime.reopenBlock(blockRequestId);
    await waitFor(() => runtime.snapshot().phases[0]?.agents[0]?.block?.delivery === "pending", "原表单重开");
    await control.answer({ blockRequestId, answer: { ok: true } });
    expect(await running).toEqual({ ok: true });
    expect(runtime.snapshot().phases[0]!.agents[0]!.agentSessionId).toBe(agentSessionId);
    const events = (await RunJournal.open(runtime.snapshot().id, join(root, "runs"))).events;
    expect(events.filter(event => event.type === "block.created")).toHaveLength(1);
    expect(events.filter(event => event.type === "block.closed")).toHaveLength(1);
    expect(events.filter(event => event.type === "block.reopened")).toHaveLength(1);
    expect(events.filter(event => event.type === "agent.restarted")).toHaveLength(0);
  } catch (error) {
    console.error(await Bun.file(trace).text().catch(() => "尚无 MCP 帧"));
    throw error;
  } finally {
    if (["running", "pausing", "paused", "recovering"].includes(runtime.snapshot().status)) await runtime.stop().catch(() => undefined);
    await running.catch(() => undefined);
    pipes.forEach(pipe => pipe.close());
  }
}, 240_000);

const timeoutProxySource = `import { appendFileSync } from "node:fs";
let toolCallId = null;
let injected = false;
const trace = process.env.WF_MCP_TRACE;
const record = (direction, message) => {
  if (trace) appendFileSync(trace, JSON.stringify({ direction, method: message.method, id: message.id, requestId: message.params?.requestId, reason: message.params?.reason, action: message.result?.action, error: message.error }) + "\\n");
};
const [command, ...args] = process.argv.slice(2);
const child = Bun.spawn([command, ...args], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: process.env });
const sendToChild = value => child.stdin.write(JSON.stringify(value) + "\\n");
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
  record("client->server", message);
  if (message.method === "tools/call" && message.params?.name === "wave_flow_block") toolCallId = message.id;
  child.stdin.write(line + "\\n");
}).then(() => child.stdin.end());
const outbound = pumpLines(child.stdout, line => {
  const message = JSON.parse(line);
  record("server->client", message);
  process.stdout.write(line + "\\n");
  if (process.env.WF_MCP_INJECT_TIMEOUT === "1" && !injected && toolCallId !== null && message.method === "elicitation/create") {
    injected = true;
    sendToChild({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: toolCallId, reason: "真机验收：模拟客户端 MCP 工具超时" } });
  }
});
const [code] = await Promise.all([child.exited, inbound, outbound]);
process.exit(code);
`;
