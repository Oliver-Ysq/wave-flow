import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectControlSocket } from "../../src/runtime/control-socket";
import { WorkerControlChannel } from "../../src/runtime/worker-control-channel";

const pipes: WorkerControlChannel[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill(); for (const pipe of pipes.splice(0)) pipe.close(); });

/** Worker 完成上报必须通过随机私有 socket 直接进入当前 Engine 的 Control，而不是 HTTP。 */
test("Worker 私有 Control 通道 将 complete 直接交给 ControlServer", async () => {
  const received: unknown[] = [];
  const control = { async complete(value: unknown) { received.push(value); }, async block() { throw new Error("不应调用 block"); }, async continue() { throw new Error("不应调用 continue"); } };
  const pipe = new WorkerControlChannel(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const client = await connectControlSocket({ socketPath: pipe.endpoints.socketPath, idPrefix: "test" });
  expect(await client.request({ action: "complete", summary: "done", result: { ok: true } })).toEqual({ ok: true });
  expect(received).toEqual([{ runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability", summary: "done", result: { ok: true } }]);
  client.close();
});

/** MCP stdio 服务必须真实把工具调用转成私有通道请求，不能回退到 HTTP。 */
test("Worker MCP 的 complete 工具通过私有 socket 交给 ControlServer", async () => {
  const received: unknown[] = [];
  const control = { async complete(value: unknown) { received.push(value); }, async block() { throw new Error("不应调用 block"); }, async continue() { throw new Error("不应调用 continue"); } };
  const pipe = new WorkerControlChannel(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry, "__worker-mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WF_WORKER_CONTROL_SOCKET: pipe.endpoints.socketPath } }); children.push(child);
  const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffered = "";
  const next = async (): Promise<Record<string, unknown>> => { while (true) { const index = buffered.indexOf("\n"); if (index >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); return JSON.parse(line); } const value = await reader.read(); if (value.done) throw new Error("Worker MCP 在响应前关闭。 "); buffered += decoder.decode(value.value, { stream: true }); } };
  const send = (value: unknown) => child.stdin.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  expect((await next()).id).toBe(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "wave_flow_complete", arguments: { summary: "done", result: { ok: true } } } });
  const response = await next();
  expect(response.id).toBe(2);
  expect((response.result as { content: { text: string }[] }).content[0].text).toBe('{"ok":true}');
  expect(received).toEqual([{ runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability", summary: "done", result: { ok: true } }]);
  // 客户端stdin仍打开也必须退出，不能依赖ACP adapter会回收它；按真实退出等待。
  expect(await child.exited).toBe(0);
}, 20_000);

/**
 * 完成条件必须进入工具签名：工具定义每次请求都会重发，不随对话历史被压缩折叠，
 * 因此把节点 resultSchema 内联进 wave_flow_complete 的 inputSchema 是结构性抗压缩手段。
 */
test("Worker MCP 把节点 resultSchema 内联进完成工具的 inputSchema", async () => {
  const control = { async complete() {}, async block() { throw new Error("不应调用 block"); }, async continue() { throw new Error("不应调用 continue"); } };
  const pipe = new WorkerControlChannel(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const schema = { type: "object", properties: { ok: { type: "boolean" }, note: { type: "string" } }, required: ["ok"], additionalProperties: false };
  const child = Bun.spawn([process.execPath, entry, "__worker-mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WF_WORKER_CONTROL_SOCKET: pipe.endpoints.socketPath, WF_WORKER_RESULT_SCHEMA: JSON.stringify(schema) } }); children.push(child);
  const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffered = "";
  const next = async (): Promise<Record<string, unknown>> => { while (true) { const index = buffered.indexOf("\n"); if (index >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); return JSON.parse(line); } const value = await reader.read(); if (value.done) throw new Error("Worker MCP 在响应前关闭。 "); buffered += decoder.decode(value.value, { stream: true }); } };
  const send = (value: unknown) => child.stdin.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  expect((await next()).id).toBe(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listed = await next();
  const tools = (listed.result as { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] }).tools;
  const complete = tools.find(tool => tool.name === "wave_flow_complete");
  expect(complete).toBeDefined();
  expect(complete!.inputSchema.properties.result).toEqual(schema);
}, 20_000);

/** 节点没有声明结果 Schema 时，完成工具仍按对象形状通告，不得凭空构造 Schema。 */
test("Worker MCP 在没有节点 Schema 时只通告对象形状", async () => {
  const control = { async complete() {}, async block() { throw new Error("不应调用 block"); }, async continue() { throw new Error("不应调用 continue"); } };
  const pipe = new WorkerControlChannel(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry, "__worker-mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WF_WORKER_CONTROL_SOCKET: pipe.endpoints.socketPath } }); children.push(child);
  const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffered = "";
  const next = async (): Promise<Record<string, unknown>> => { while (true) { const index = buffered.indexOf("\n"); if (index >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); return JSON.parse(line); } const value = await reader.read(); if (value.done) throw new Error("Worker MCP 在响应前关闭。 "); buffered += decoder.decode(value.value, { stream: true }); } };
  const send = (value: unknown) => child.stdin.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  expect((await next()).id).toBe(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listed = await next();
  const tools = (listed.result as { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] }).tools;
  const complete = tools.find(tool => tool.name === "wave_flow_complete");
  expect(complete!.inputSchema.properties.result).toEqual({ type: "object" });
}, 20_000);

for (const pending of [false, true]) test(`Engine关闭私有管道时Worker MCP自行退出，不依赖ACP关闭stdin，pendingBlock=${pending}`, async () => {
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { entered = resolve; });
  const control = { async complete() {}, async block() { entered(); return new Promise(() => {}); }, async continue() {} };
  const pipe = new WorkerControlChannel(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry, "__worker-mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WF_WORKER_CONTROL_SOCKET: pipe.endpoints.socketPath } }); children.push(child);
  const reader = child.stdout.getReader();
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } })}\n`);
  expect((await reader.read()).done).toBe(false);
  if (pending) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "wave_flow_block", arguments: { needHelp: "测试等待" } } })}\n`);
    await blocked;
  }
  pipe.close();
  expect(await child.exited).toBe(0);
}, 20_000);

/** block/continue 是 HITL 的另两个入口，必须与 complete 一样经私有 socket 且携带绑定身份。 */
test("Worker 私有 Control 通道 将 block 与 continue 原样交给 ControlServer", async () => {
  const received: unknown[] = [];
  const control = { async complete() { throw new Error("不应调用 complete"); }, async block(value: unknown) { received.push(["block", value]); return { blockRequestId: (value as { blockRequestId: string }).blockRequestId, answer: { ok: true } }; }, async continue(value: unknown) { received.push(["continue", value]); return { ok: true }; } };
  const pipe = new WorkerControlChannel(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const client = await connectControlSocket({ socketPath: pipe.endpoints.socketPath, idPrefix: "test" });
  const blockRequestId = crypto.randomUUID();
  expect(await client.request({ action: "block", blockRequestId, needHelp: "需要确认", answerSchema: { type: "object" } })).toEqual({ blockRequestId, answer: { ok: true } });
  expect(await client.request({ action: "continue", blockRequestId })).toEqual({ ok: true });
  expect(received).toEqual([
    ["block", { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability", blockRequestId, needHelp: "需要确认", answerSchema: { type: "object" } }],
    ["continue", { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability", blockRequestId }],
  ]);
  client.close();
});

/** 畸形帧与 Control 拒绝都必须以错误响应回传，绝不能静默丢弃或改变其他请求。 */
test("Worker 私有 Control 通道 对畸形帧和 Control 错误回传 ok:false", async () => {
  const control = { async complete() { throw new Error("Control 拒绝完成"); }, async block() { throw new Error("不应调用 block"); }, async continue() { throw new Error("不应调用 continue"); } };
  const pipe = new WorkerControlChannel(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const client = await connectControlSocket({ socketPath: pipe.endpoints.socketPath, idPrefix: "test" });
  await expect(client.request({ action: "unknown" })).rejects.toThrow("请求无效");
  await expect(client.request({ action: "complete", summary: "done", result: { ok: true } })).rejects.toThrow("Control 拒绝完成");
  client.close();
});

/**
 * Codex code-mode 约 31 秒后不再同步返回长工具调用结果（转为后台 cell，模型未必取回），
 * 因此 wave_flow_block 必须有界等待：预算内未答返回 waiting，重连同 id 才返回 answered。
 */
test("wave_flow_block 有界等待：未答返回 waiting，同一 blockRequestId 重连后拿到答案", async () => {
  const requests: unknown[] = [];
  let releaseAnswer!: (value: unknown) => void;
  const control = {
    async complete() { throw new Error("不应调用 complete"); },
    async block(value: unknown) {
      requests.push(value);
      // 第一次调用等到预算到期仍无答案；第二次（重连）调用由测试交付答案。
      if (requests.length === 1) return new Promise(() => {});
      return new Promise((resolve) => { releaseAnswer = resolve; });
    },
    async continue() { throw new Error("不应调用 continue"); },
  };
  const pipe = new WorkerControlChannel(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry, "__worker-mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WF_WORKER_CONTROL_SOCKET: pipe.endpoints.socketPath, WF_WORKER_BLOCK_WAIT_BUDGET_MS: "150" } }); children.push(child);
  const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffered = "";
  const next = async (): Promise<Record<string, unknown>> => { while (true) { const index = buffered.indexOf("\n"); if (index >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); return JSON.parse(line); } const value = await reader.read(); if (value.done) throw new Error("Worker MCP 在响应前关闭。 "); buffered += decoder.decode(value.value, { stream: true }); } };
  const send = (value: unknown) => child.stdin.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  expect((await next()).id).toBe(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const needHelp = "需要整数 x";
  const answerSchema = { type: "object", properties: { x: { type: "integer" } }, required: ["x"] };
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "wave_flow_block", arguments: { needHelp, answerSchema } } });
  const waiting = await next();
  const waitingPayload = JSON.parse((waiting.result as { content: { text: string }[] }).content[0].text);
  expect(waitingPayload.status).toBe("waiting");
  expect(typeof waitingPayload.blockRequestId).toBe("string");
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "wave_flow_block", arguments: { needHelp, answerSchema, blockRequestId: waitingPayload.blockRequestId } } });
  for (let i = 0; i < 100 && requests.length < 2; i++) await Bun.sleep(20);
  expect(requests).toHaveLength(2);
  releaseAnswer({ blockRequestId: waitingPayload.blockRequestId, answer: { x: 7 } });
  const answered = await next();
  const answeredPayload = JSON.parse((answered.result as { content: { text: string }[] }).content[0].text);
  expect(answeredPayload).toEqual({ status: "answered", blockRequestId: waitingPayload.blockRequestId, answer: { x: 7 } });
  // 两次调用都把同一 blockRequestId 交给 Control；是否新建 block 由 Control 仲裁。
  expect((requests as { blockRequestId: string }[]).map((request) => request.blockRequestId)).toEqual([waitingPayload.blockRequestId, waitingPayload.blockRequestId]);
}, 20_000);

/**
 * 回归：控制通道不能占用 Bun 线程池。
 *
 * 曾经的 FIFO 实现每开一个会话就有一条阻塞读长期占用一个池线程（池大小 = CPU 核数），
 * 会话关闭也不释放；累积到池大小后，Journal/生命周期日志/节点结果等所有异步文件写入
 * 都会排队永不完成，表现为节点永久 running 且无日志。这里把通道数开到池大小，
 * 并要求异步写入仍能完成。
 */
test("通道数达到线程池大小后，异步文件写入仍能完成", async () => {
  const control = { async complete() {}, async block() { return {}; }, async continue() {} };
  const poolSize = Math.max(4, navigator.hardwareConcurrency ?? 4);
  const scratch = mkdtempSync(join(tmpdir(), "wf-channel-regression-"));
  try {
    const opened: WorkerControlChannel[] = [];
    for (let index = 0; index < poolSize; index += 1) {
      opened.push(new WorkerControlChannel(control as never, { runId: "run", nodeId: `node-${index}`, agentSessionId: `session-${index}`, capability: "capability" }, undefined, scratch));
    }
    const target = join(scratch, "probe.log");
    // 并发通道下写入必然完成；按真实完成等待，不用 3 秒墙钟判定。
    await appendFile(target, "probe\n");
    for (const channel of opened) channel.close();
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 20_000);

/**
 * 已声明但无法解析的 resultSchema 必须让 sidecar 启动即失败。
 * 静默降级会让模型拿到与 Control 实际校验不同的契约，产出必然被拒，比启动失败更难排查。
 */
test("Worker MCP 在 resultSchema 非法时启动即失败并给出可读原因", async () => {
  const control = { async complete() {}, async block() { throw new Error("不应调用 block"); }, async continue() { throw new Error("不应调用 continue"); } };
  const pipe = new WorkerControlChannel(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry, "__worker-mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WF_WORKER_CONTROL_SOCKET: pipe.endpoints.socketPath, WF_WORKER_RESULT_SCHEMA: "not-json" } }); children.push(child);
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited).not.toBe(0);
  expect(stderr).toContain("WF_WORKER_RESULT_SCHEMA");
}, 20_000);
