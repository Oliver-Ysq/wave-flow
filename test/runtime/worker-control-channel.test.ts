import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
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
  const client = await connectControlSocket({ socketPath: pipe.endpoints.socketPath, idPrefix: "test", capability: "capability" });
  expect(await client.request({ action: "complete", summary: "done", result: { ok: true } })).toEqual({ ok: true });
  expect(received).toEqual([{ runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability", summary: "done", result: { ok: true } }]);
  client.close();
});

test("同 UID 攻击者仅知道 socket 路径时不能冒用其他 Worker", async () => {
  const received: unknown[] = [];
  const control = { async complete(value: unknown) { received.push(value); }, async block() { throw new Error("不应调用 block"); }, async continue() { throw new Error("不应调用 continue"); } };
  const pipe = new WorkerControlChannel(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const client = await connectControlSocket({ socketPath: pipe.endpoints.socketPath, idPrefix: "attacker" });
  await expect(client.request({ action: "complete", summary: "forged", result: { ok: true } })).rejects.toThrow();
  const wrong = await connectControlSocket({ socketPath: pipe.endpoints.socketPath, idPrefix: "attacker-wrong", capability: "wrong" });
  await expect(wrong.request({ action: "complete", summary: "forged", result: { ok: true } })).rejects.toThrow("capability 不匹配");
  expect(received).toHaveLength(0);
  wrong.close();
  client.close();
});

/** MCP stdio 服务必须真实把工具调用转成私有通道请求，不能回退到 HTTP。 */
test("Worker MCP 的 complete 工具通过私有 socket 交给 ControlServer", async () => {
  const received: unknown[] = [];
  const control = { async complete(value: unknown) { received.push(value); }, async block() { throw new Error("不应调用 block"); }, async continue() { throw new Error("不应调用 continue"); } };
  const pipe = new WorkerControlChannel(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry, "__worker-mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WF_WORKER_CONTROL_SOCKET: pipe.endpoints.socketPath, WF_WORKER_CONTROL_CAPABILITY: "capability" } }); children.push(child);
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
  const child = Bun.spawn([process.execPath, entry, "__worker-mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WF_WORKER_CONTROL_SOCKET: pipe.endpoints.socketPath, WF_WORKER_CONTROL_CAPABILITY: "capability", WF_WORKER_RESULT_SCHEMA: JSON.stringify(schema) } }); children.push(child);
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
  const child = Bun.spawn([process.execPath, entry, "__worker-mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WF_WORKER_CONTROL_SOCKET: pipe.endpoints.socketPath, WF_WORKER_CONTROL_CAPABILITY: "capability" } }); children.push(child);
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
  const control = { async complete() {}, async block() { entered(); return { answerSchema: { type: "object", properties: { ok: { type: "boolean" } } }, answer: null }; }, async continue() {} };
  const pipe = new WorkerControlChannel(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry, "__worker-mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WF_WORKER_CONTROL_SOCKET: pipe.endpoints.socketPath, WF_WORKER_CONTROL_CAPABILITY: "capability" } }); children.push(child);
  const reader = child.stdout.getReader();
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } })}\n`);
  expect((await reader.read()).done).toBe(false);
  if (pending) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "wave_flow_block", arguments: { needHelp: "测试等待", answerSchema: { type: "object", properties: { ok: { type: "boolean" } } } } } })}\n`);
    await blocked;
  }
  pipe.close();
  expect(await child.exited).toBe(0);
}, 20_000);

/** block/continue 是 HITL 的另两个入口，必须与 complete 一样经私有 socket 且携带绑定身份。 */
test("Worker 私有 Control 通道 将 block 与 continue 原样交给 ControlServer", async () => {
  const received: unknown[] = [];
  const control = { async complete() { throw new Error("不应调用 complete"); }, async block(value: unknown) { received.push(["block", value]); return { blockRequestId: (value as { blockRequestId: string }).blockRequestId, answer: { ok: true } }; }, async continue(value: unknown) { received.push(["continue", value]); return { ok: true }; }, async closeBlock(value: unknown) { received.push(["close-block", value]); } };
  const pipe = new WorkerControlChannel(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const client = await connectControlSocket({ socketPath: pipe.endpoints.socketPath, idPrefix: "test", capability: "capability" });
  const blockRequestId = crypto.randomUUID();
  expect(await client.request({ action: "block", blockRequestId, needHelp: "需要确认", answerSchema: { type: "object" } })).toEqual({ blockRequestId, answer: { ok: true } });
  expect(await client.request({ action: "continue", blockRequestId })).toEqual({ ok: true });
  expect(await client.request({ action: "close-block", blockRequestId })).toEqual({ ok: true });
  expect(received).toEqual([
    ["block", { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability", blockRequestId, needHelp: "需要确认", answerSchema: { type: "object" } }],
    ["continue", { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability", blockRequestId }],
    ["close-block", blockRequestId],
  ]);
  client.close();
});

/** 畸形帧与 Control 拒绝都必须以错误响应回传，绝不能静默丢弃或改变其他请求。 */
test("Worker 私有 Control 通道 对畸形帧和 Control 错误回传 ok:false", async () => {
  const control = { async complete() { throw new Error("Control 拒绝完成"); }, async block() { throw new Error("不应调用 block"); }, async continue() { throw new Error("不应调用 continue"); } };
  const pipe = new WorkerControlChannel(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const client = await connectControlSocket({ socketPath: pipe.endpoints.socketPath, idPrefix: "test", capability: "capability" });
  await expect(client.request({ action: "unknown" })).rejects.toThrow("请求无效");
  await expect(client.request({ action: "complete", summary: "done", result: { ok: true } })).rejects.toThrow("Control 拒绝完成");
  client.close();
});

/** block 先建立事实，再由宿主 Elicitation 作答并自动 continue。 */
test("wave_flow_block 经 Elicitation 返回答案并自动 continue", async () => {
  const requests: unknown[] = [];
  let blockCalls = 0;
  const control = {
    async complete() { throw new Error("不应调用 complete"); },
    async block(value: unknown) {
      requests.push(value);
      blockCalls += 1;
      const request = value as { answerSchema: unknown };
      return { answerSchema: request.answerSchema, answer: blockCalls === 1 ? null : { x: 7 }, userNote: blockCalls === 1 ? null : "保留现有交互", delivery: blockCalls === 1 ? "pending" : "answered" };
    },
    async continue(value: unknown) { requests.push(value); return { ok: true }; },
  };
  const pipe = new WorkerControlChannel(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry, "__worker-mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WF_WORKER_CONTROL_SOCKET: pipe.endpoints.socketPath, WF_WORKER_CONTROL_CAPABILITY: "capability" } }); children.push(child);
  const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffered = "";
  const next = async (): Promise<Record<string, unknown>> => { while (true) { const index = buffered.indexOf("\n"); if (index >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); return JSON.parse(line); } const value = await reader.read(); if (value.done) throw new Error("Worker MCP 在响应前关闭。 "); buffered += decoder.decode(value.value, { stream: true }); } };
  const send = (value: unknown) => child.stdin.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: { elicitation: { form: {} } }, clientInfo: { name: "test", version: "1" } } });
  expect((await next()).id).toBe(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const needHelp = "需要整数 x";
  const answerSchema = { type: "object", properties: { x: { type: "integer" } }, required: ["x"] };
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "wave_flow_block", arguments: { needHelp, answerSchema } } });
  const elicitation = await next();
  expect(elicitation.method).toBe("elicitation/create");
  const params = elicitation.params as { mode: string; message: string; requestedSchema: unknown; _meta: { waveFlow: { blockRequestId: string } } };
  expect(params.mode).toBe("form");
  expect(params.message).toBe(needHelp);
  expect(params.requestedSchema).toEqual(answerSchema);
  const blockRequestId = params._meta.waveFlow.blockRequestId;
  expect(blockRequestId).toMatch(/^[0-9a-f-]{36}$/);
  send({ jsonrpc: "2.0", id: elicitation.id, result: { action: "accept", content: { x: 7 } } });
  const answered = await next();
  const answeredPayload = JSON.parse((answered.result as { content: { text: string }[] }).content[0].text);
  expect(answeredPayload).toEqual({ status: "answered", blockRequestId, answer: { x: 7 }, userNote: "保留现有交互" });
  expect(requests.map(request => (request as { blockRequestId: string }).blockRequestId)).toEqual([blockRequestId, blockRequestId, blockRequestId]);
}, 20_000);

test("ACP cancel 先经 Control 关闭再返回 closed", async () => {
  let closed = 0;
  const control = {
    async complete() { throw new Error("不应调用 complete"); },
    async block(value: unknown) { return { answerSchema: (value as { answerSchema: unknown }).answerSchema, answer: null, delivery: "pending" }; },
    async continue() { throw new Error("不应 continue"); },
    async closeBlock() { closed += 1; },
  };
  const pipe = new WorkerControlChannel(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry, "__worker-mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WF_WORKER_CONTROL_SOCKET: pipe.endpoints.socketPath, WF_WORKER_CONTROL_CAPABILITY: "capability" } }); children.push(child);
  const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffered = "";
  const next = async (): Promise<Record<string, unknown>> => { while (true) { const index = buffered.indexOf("\n"); if (index >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); return JSON.parse(line); } const value = await reader.read(); if (value.done) throw new Error("Worker MCP 在响应前关闭。 "); buffered += decoder.decode(value.value, { stream: true }); } };
  const send = (value: unknown) => child.stdin.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: { elicitation: { form: {} } }, clientInfo: { name: "test", version: "1" } } });
  expect((await next()).id).toBe(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "wave_flow_block", arguments: { needHelp: "需要确认", answerSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } } } });
  const elicitation = await next();
  send({ jsonrpc: "2.0", id: elicitation.id, result: { action: "cancel" } });
  const response = await next();
  const payload = JSON.parse((response.result as { content: { text: string }[] }).content[0].text) as { status: string; blockRequestId: string };
  expect(payload.status).toBe("closed");
  expect(closed).toBe(1);
}, 20_000);

for (const answerAtClose of [false, true]) test(`客户端 tools/call 超时取消只关闭原表单且不自动重开，answerAtClose=${answerAtClose}`, async () => {
  let closed = 0;
  let continued = 0;
  let answered = false;
  let blockCalls = 0;
  const blockRequestIds: string[] = [];
  let markHandled!: () => void;
  const handled = new Promise<void>((resolve) => { markHandled = resolve; });
  const control = {
    async complete() { throw new Error("不应调用 complete"); },
    async block(value: unknown) {
      blockCalls += 1;
      const request = value as { blockRequestId: string; answerSchema: unknown };
      blockRequestIds.push(request.blockRequestId);
      if (blockCalls === 2 && !answerAtClose) markHandled();
      return { answerSchema: request.answerSchema, answer: answered ? { ok: true } : null, delivery: answered ? "answered" : "pending" };
    },
    async continue() { continued += 1; markHandled(); },
    async closeBlock() { closed += 1; answered = answerAtClose; },
  };
  const pipe = new WorkerControlChannel(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry, "__worker-mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WF_WORKER_CONTROL_SOCKET: pipe.endpoints.socketPath, WF_WORKER_CONTROL_CAPABILITY: "capability" } }); children.push(child);
  const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffered = "";
  const next = async (): Promise<Record<string, unknown>> => { while (true) { const index = buffered.indexOf("\n"); if (index >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); return JSON.parse(line); } const value = await reader.read(); if (value.done) throw new Error("Worker MCP 在响应前关闭。 "); buffered += decoder.decode(value.value, { stream: true }); } };
  const send = (value: unknown) => child.stdin.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: { elicitation: { form: {} } }, clientInfo: { name: "test", version: "1" } } });
  expect((await next()).id).toBe(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "wave_flow_block", arguments: { needHelp: "需要确认", answerSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } } } });
  const elicitation = await next();
  const cancellation = { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2, reason: "客户端 MCP 工具超时" } };
  send(cancellation);
  send(cancellation);
  const elicitationCancellation = await next();
  expect(elicitationCancellation).toMatchObject({ method: "notifications/cancelled", params: { requestId: elicitation.id } });
  await handled;
  send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
  expect((await next()).id).toBe(3);
  expect(closed).toBe(1);
  expect(blockCalls).toBe(2);
  expect(blockRequestIds.every(id => id === blockRequestIds[0])).toBe(true);
  expect(continued).toBe(answerAtClose ? 1 : 0);
}, 20_000);

test("普通 Elicitation 协议错误保持错误，不伪装成客户端关闭", async () => {
  let closed = 0;
  let blockCalls = 0;
  const control = {
    async complete() { throw new Error("不应调用 complete"); },
    async block(value: unknown) { blockCalls += 1; return { answerSchema: (value as { answerSchema: unknown }).answerSchema, answer: null, delivery: "pending" }; },
    async continue() { throw new Error("不应 continue"); },
    async closeBlock() { closed += 1; },
  };
  const pipe = new WorkerControlChannel(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry, "__worker-mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WF_WORKER_CONTROL_SOCKET: pipe.endpoints.socketPath, WF_WORKER_CONTROL_CAPABILITY: "capability" } }); children.push(child);
  const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffered = "";
  const next = async (): Promise<Record<string, unknown>> => { while (true) { const index = buffered.indexOf("\n"); if (index >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); return JSON.parse(line); } const value = await reader.read(); if (value.done) throw new Error("Worker MCP 在响应前关闭。 "); buffered += decoder.decode(value.value, { stream: true }); } };
  const send = (value: unknown) => child.stdin.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: { elicitation: { form: {} } }, clientInfo: { name: "test", version: "1" } } });
  expect((await next()).id).toBe(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "wave_flow_block", arguments: { needHelp: "需要确认", answerSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } } } });
  const elicitation = await next();
  send({ jsonrpc: "2.0", id: elicitation.id, error: { code: -32603, message: "客户端内部协议错误" } });
  const response = await next();
  expect(response.id).toBe(2);
  expect(JSON.stringify(response.error)).toContain("客户端内部协议错误");
  expect(closed).toBe(0);
  expect(blockCalls).toBe(1);
}, 20_000);

test("客户端连接死亡不写 block.closed", async () => {
  let closed = 0;
  const control = {
    async complete() { throw new Error("不应调用 complete"); },
    async block(value: unknown) { return { answerSchema: (value as { answerSchema: unknown }).answerSchema, answer: null, delivery: "pending" }; },
    async continue() { throw new Error("不应 continue"); },
    async closeBlock() { closed += 1; },
  };
  const pipe = new WorkerControlChannel(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry, "__worker-mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WF_WORKER_CONTROL_SOCKET: pipe.endpoints.socketPath, WF_WORKER_CONTROL_CAPABILITY: "capability" } }); children.push(child);
  const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffered = "";
  const next = async (): Promise<Record<string, unknown>> => { while (true) { const index = buffered.indexOf("\n"); if (index >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); return JSON.parse(line); } const value = await reader.read(); if (value.done) throw new Error("Worker MCP 在响应前关闭。 "); buffered += decoder.decode(value.value, { stream: true }); } };
  const send = (value: unknown) => child.stdin.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: { elicitation: { form: {} } }, clientInfo: { name: "test", version: "1" } } });
  expect((await next()).id).toBe(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "wave_flow_block", arguments: { needHelp: "需要确认", answerSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } } } });
  expect((await next()).method).toBe("elicitation/create");
  await child.stdin.end();
  expect(await child.exited).toBe(0);
  expect(closed).toBe(0);
}, 20_000);

test("答案交付后 continue 失败返回协议错误，不伪装成 closed", async () => {
  let blockCalls = 0;
  const control = {
    async complete() { throw new Error("不应调用 complete"); },
    async block(value: unknown) { blockCalls += 1; return { answerSchema: (value as { answerSchema: unknown }).answerSchema, answer: blockCalls === 1 ? null : { ok: true }, delivery: blockCalls === 1 ? "pending" : "answered" }; },
    async continue() { throw new Error("continue 未确认"); },
  };
  const pipe = new WorkerControlChannel(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry, "__worker-mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WF_WORKER_CONTROL_SOCKET: pipe.endpoints.socketPath, WF_WORKER_CONTROL_CAPABILITY: "capability" } }); children.push(child);
  const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffered = "";
  const next = async (): Promise<Record<string, unknown>> => { while (true) { const index = buffered.indexOf("\n"); if (index >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); return JSON.parse(line); } const value = await reader.read(); if (value.done) throw new Error("Worker MCP 在响应前关闭。 "); buffered += decoder.decode(value.value, { stream: true }); } };
  const send = (value: unknown) => child.stdin.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: { elicitation: { form: {} } }, clientInfo: { name: "test", version: "1" } } });
  expect((await next()).id).toBe(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "wave_flow_block", arguments: { needHelp: "需要确认", answerSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } } } });
  const elicitation = await next();
  send({ jsonrpc: "2.0", id: elicitation.id, result: { action: "accept", content: { ok: true } } });
  const response = await next();
  expect(response.error).toBeDefined();
  expect(JSON.stringify(response.error)).toContain("continue 未确认");
  expect(JSON.stringify(response)).not.toContain('"status":"closed"');
}, 20_000);

test("业务超时通过真实 MCP 路径耐久关闭表单并返回 closed", async () => {
  let closed = 0;
  const control = {
    async complete() { throw new Error("不应调用 complete"); },
    async block(value: unknown) { return { answerSchema: (value as { answerSchema: unknown }).answerSchema, answer: null, delivery: "pending" }; },
    async continue() { throw new Error("不应 continue"); },
    async closeBlock() { closed += 1; },
  };
  const pipe = new WorkerControlChannel(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const directory = mkdtempSync(join(tmpdir(), "wf-elicit-timeout-"));
  try {
    const sourcePath = new URL("../../src/runtime/worker-mcp-server.ts", import.meta.url).pathname;
    const source = await Bun.file(sourcePath).text();
    const instrumented = source.replace("24 * 60 * 60 * 1000", "100")
      .replaceAll('"../', `"${join(process.cwd(), "src")}/`)
      .replaceAll('"./', `"${join(process.cwd(), "src/runtime")}/`)
      + "\nawait runWorkerMcpServer();\n";
    if (instrumented === source) throw new Error("超时探针没有生效");
    const entry = join(directory, "worker-mcp-timeout.ts");
    await writeFile(entry, instrumented, "utf8");
    const child = Bun.spawn([process.execPath, entry], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WF_WORKER_CONTROL_SOCKET: pipe.endpoints.socketPath, WF_WORKER_CONTROL_CAPABILITY: "capability" } }); children.push(child);
    const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffered = "";
    const next = async (): Promise<Record<string, unknown>> => { while (true) { const index = buffered.indexOf("\n"); if (index >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); return JSON.parse(line); } const value = await reader.read(); if (value.done) throw new Error("Worker MCP 在响应前关闭。 "); buffered += decoder.decode(value.value, { stream: true }); } };
    const send = (value: unknown) => child.stdin.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: { elicitation: { form: {} } }, clientInfo: { name: "test", version: "1" } } });
    expect((await next()).id).toBe(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "wave_flow_block", arguments: { needHelp: "需要确认", answerSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } } } });
    expect((await next()).method).toBe("elicitation/create");
    let response: Record<string, unknown>;
    do { response = await next(); } while (response.id !== 2);
    const payload = JSON.parse((response.result as { content: { text: string }[] }).content[0].text) as { status: string };
    expect(payload.status).toBe("closed");
    expect(closed).toBe(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
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
  const child = Bun.spawn([process.execPath, entry, "__worker-mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WF_WORKER_CONTROL_SOCKET: pipe.endpoints.socketPath, WF_WORKER_CONTROL_CAPABILITY: "capability", WF_WORKER_RESULT_SCHEMA: "not-json" } }); children.push(child);
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited).not.toBe(0);
  expect(stderr).toContain("WF_WORKER_RESULT_SCHEMA");
}, 20_000);
