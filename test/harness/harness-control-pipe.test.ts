import { afterEach, expect, test } from "bun:test";
import { HarnessControlPipe } from "../../src/harness/harness-control-pipe";

const pipes: HarnessControlPipe[] = []; const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill(); for (const pipe of pipes.splice(0)) pipe.close(); });

/** Harness MCP 的 tools/list 必须经私有 FIFO 回到 Engine，而不是 HTTP callback。 */
test("Harness MCP 通过私有 FIFO 读取受限工具列表", async () => {
  const requests: unknown[] = [];
  const pipe = new HarnessControlPipe(async request => { requests.push(request); return { tools: [{ name: "read_project_file" }] }; }); pipes.push(pipe);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry, "__harness-mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WF_HARNESS_MCP_REQUEST_FIFO: pipe.endpoints.requestFifo, WF_HARNESS_MCP_RESPONSE_FIFO: pipe.endpoints.responseFifo } }); children.push(child);
  const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffered = "";
  const next = async (): Promise<Record<string, unknown>> => { while (true) { const index = buffered.indexOf("\n"); if (index >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); return JSON.parse(line); } const value = await reader.read(); if (value.done) throw new Error("Harness MCP 在响应前关闭。 "); buffered += decoder.decode(value.value, { stream: true }); } };
  const send = (value: unknown) => child.stdin.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } }); expect((await next()).id).toBe(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  expect(await next()).toMatchObject({ id: 2, result: { tools: [{ name: "read_project_file" }] } });
  expect(requests).toEqual([expect.objectContaining({ operation: "list", value: {} })]);
});
