import { afterEach, expect, test } from "bun:test";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { WorkerControlPipe } from "../../src/runtime/worker-control-pipe";

const pipes: WorkerControlPipe[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill(); for (const pipe of pipes.splice(0)) pipe.close(); });

/** Worker 完成上报必须通过随机 FIFO 直接进入当前 Engine 的 Control，而不是 HTTP。 */
test("Worker 私有 Control FIFO 将 complete 直接交给 ControlServer", async () => {
  const received: unknown[] = [];
  const control = { async complete(value: unknown) { received.push(value); }, async block() { throw new Error("不应调用 block"); }, async continue() { throw new Error("不应调用 continue"); } };
  const pipe = new WorkerControlPipe(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const reader = createInterface({ input: createReadStream(pipe.endpoints.responseFifo, { flags: "r+", encoding: "utf8" }), crlfDelay: Infinity });
  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    reader.once("line", line => { try { resolve(JSON.parse(line)); } catch (error) { reject(error); } });
  });
  const writer = createWriteStream(pipe.endpoints.requestFifo, { flags: "r+" });
  await new Promise<void>((resolve, reject) => writer.write(`${JSON.stringify({ requestId: "request", action: "complete", summary: "done", result: { ok: true } })}\n`, error => error ? reject(error) : resolve()));
  expect(await response).toEqual({ requestId: "request", ok: true, result: { ok: true } });
  expect(received).toEqual([{ runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability", summary: "done", result: { ok: true } }]);
  writer.destroy(); reader.close();
});

/** MCP stdio 服务必须真实把工具调用转成私有 FIFO 请求，不能回退到 HTTP。 */
test("Worker MCP 的 complete 工具通过私有 FIFO 交给 ControlServer", async () => {
  const received: unknown[] = [];
  const control = { async complete(value: unknown) { received.push(value); }, async block() { throw new Error("不应调用 block"); }, async continue() { throw new Error("不应调用 continue"); } };
  const pipe = new WorkerControlPipe(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry, "__worker-mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WF_WORKER_MCP_REQUEST_FIFO: pipe.endpoints.requestFifo, WF_WORKER_MCP_RESPONSE_FIFO: pipe.endpoints.responseFifo } }); children.push(child);
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
  // 客户端stdin仍打开也必须退出，不能依赖ACP adapter会回收它。
  expect(await Promise.race([child.exited, Bun.sleep(2_000).then(() => "pending")])).toBe(0);
});

for (const pending of [false, true]) test(`Engine关闭私有管道时Worker MCP自行退出，不依赖ACP关闭stdin，pendingBlock=${pending}`, async () => {
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { entered = resolve; });
  const control = { async complete() {}, async block() { entered(); return new Promise(() => {}); }, async continue() {} };
  const pipe = new WorkerControlPipe(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry, "__worker-mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WF_WORKER_MCP_REQUEST_FIFO: pipe.endpoints.requestFifo, WF_WORKER_MCP_RESPONSE_FIFO: pipe.endpoints.responseFifo } }); children.push(child);
  const reader = child.stdout.getReader();
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } })}\n`);
  expect((await reader.read()).done).toBe(false);
  if (pending) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "wave_flow_block", arguments: { needHelp: "测试等待" } } })}\n`);
    await blocked;
  }
  pipe.close();
  expect(await Promise.race([child.exited, Bun.sleep(2_000).then(() => "pending")])).toBe(0);
});

/** block/continue 是 HITL 的另两个入口，必须与 complete 一样经私有 FIFO 且携带绑定身份。 */
test("Worker 私有 Control FIFO 将 block 与 continue 原样交给 ControlServer", async () => {
  const received: unknown[] = [];
  const control = { async complete() { throw new Error("不应调用 complete"); }, async block(value: unknown) { received.push(["block", value]); return { blockRequestId: (value as { blockRequestId: string }).blockRequestId, answer: { ok: true } }; }, async continue(value: unknown) { received.push(["continue", value]); return { ok: true }; } };
  const pipe = new WorkerControlPipe(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const reader = createInterface({ input: createReadStream(pipe.endpoints.responseFifo, { flags: "r+", encoding: "utf8" }), crlfDelay: Infinity });
  const responses: Record<string, unknown>[] = [];
  reader.on("line", (line) => { responses.push(JSON.parse(line)); });
  const writer = createWriteStream(pipe.endpoints.requestFifo, { flags: "r+" });
  const write = (value: unknown) => new Promise<void>((resolve, reject) => writer.write(`${JSON.stringify(value)}\n`, (error) => (error ? reject(error) : resolve())));
  const blockRequestId = crypto.randomUUID();
  await write({ requestId: "block-1", action: "block", blockRequestId, needHelp: "需要确认", answerSchema: { type: "object" } });
  await write({ requestId: "continue-1", action: "continue", blockRequestId });
  await Bun.sleep(50);
  expect(responses).toEqual([
    { requestId: "block-1", ok: true, result: { blockRequestId, answer: { ok: true } } },
    { requestId: "continue-1", ok: true, result: { ok: true } },
  ]);
  expect(received).toEqual([
    ["block", { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability", blockRequestId, needHelp: "需要确认", answerSchema: { type: "object" } }],
    ["continue", { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability", blockRequestId }],
  ]);
  writer.destroy(); reader.close();
});

/** 畸形帧与 Control 拒绝都必须以错误响应回传，绝不能静默丢弃或改变其他请求。 */
test("Worker 私有 Control FIFO 对畸形帧和 Control 错误回传 ok:false", async () => {
  const control = { async complete() { throw new Error("Control 拒绝完成"); }, async block() { throw new Error("不应调用 block"); }, async continue() { throw new Error("不应调用 continue"); } };
  const pipe = new WorkerControlPipe(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const reader = createInterface({ input: createReadStream(pipe.endpoints.responseFifo, { flags: "r+", encoding: "utf8" }), crlfDelay: Infinity });
  const responses: Record<string, unknown>[] = [];
  reader.on("line", (line) => { responses.push(JSON.parse(line)); });
  const writer = createWriteStream(pipe.endpoints.requestFifo, { flags: "r+" });
  const write = (text: string) => new Promise<void>((resolve, reject) => writer.write(text, (error) => (error ? reject(error) : resolve())));
  await write("not-json\n");
  await write(`${JSON.stringify({ requestId: "bad-frame", action: "unknown" })}\n`);
  await write(`${JSON.stringify({ requestId: "rejected", action: "complete", summary: "done", result: { ok: true } })}\n`);
  await Bun.sleep(50);
  const byId = new Map(responses.map((item) => [item.requestId, item]));
  expect(byId.get("")).toMatchObject({ ok: false, error: expect.stringContaining("合法 JSON") });
  expect(byId.get("bad-frame")).toMatchObject({ ok: false, error: expect.stringContaining("请求无效") });
  expect(byId.get("rejected")).toMatchObject({ ok: false, error: "Control 拒绝完成" });
  writer.destroy(); reader.close();
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
  const pipe = new WorkerControlPipe(control as never, { runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability" }); pipes.push(pipe);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry, "__worker-mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WF_WORKER_MCP_REQUEST_FIFO: pipe.endpoints.requestFifo, WF_WORKER_MCP_RESPONSE_FIFO: pipe.endpoints.responseFifo, WF_WORKER_BLOCK_WAIT_BUDGET_MS: "150" } }); children.push(child);
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
});
