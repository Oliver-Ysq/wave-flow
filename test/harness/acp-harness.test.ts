import { expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import { AcpHarnessSession } from "../../src/harness/acp-harness";
import type { AcpSessionClient } from "../../src/adapters/acp-session";
import type { HarnessStreamEvent } from "../../src/harness/types";

test("ACP Harness 创建独立 session、注入私有 MCP 并只耐久 assistant 文本", async () => {
  let servers: acp.McpServer[] = []; let prompt = ""; let listener: ((event: { update: acp.SessionUpdate }) => void) | null = null;
  const client = {
    subscribe(value: typeof listener) { listener = value; return () => {}; },
    async initialize() {},
    async createSession(_cwd: string, _signal: AbortSignal, value: acp.McpServer[]) { servers = value; return { launcherId: "codex-acp", sessionId: "harness-session", capabilities: {} }; },
    async prompt(value: string) { prompt = value; listener?.({ update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "思考" } } }); listener?.({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "完整回答" } } }); return { stopReason: "end_turn" }; },
    async cancel() {}, close() {},
  } as unknown as AcpSessionClient;
  const session = new AcpHarnessSession({ id: "codex-acp", command: "fake", args: [] }, "/workspace", "系统约束", [{ id: "u", role: "user", text: "旧消息", createdAt: new Date().toISOString() }], { name: "wave-flow-harness", command: "/wave-flow-desktop-engine", args: ["__harness-mcp"], env: [] }, client);
  const events: HarnessStreamEvent[] = []; session.subscribe(event => events.push(event));
  await expect(session.prompt("新消息")).resolves.toBe("完整回答");
  expect(servers).toEqual([{ name: "wave-flow-harness", command: "/wave-flow-desktop-engine", args: ["__harness-mcp"], env: [] }]);
  expect(prompt).toContain("旧消息"); expect(prompt).toContain("新消息");
  expect(events).toEqual([{ type: "reasoning_delta", delta: "思考" }, { type: "assistant_delta", delta: "完整回答" }]);
  await session.prompt("第二轮");
  expect(prompt).toBe("第二轮");
});

test("cancel 正常 resolve 的 ACP CLI 不得把 partial 文本当完整回答", async () => {
  let listener: ((event: { update: acp.SessionUpdate }) => void) | null = null;
  const client = {
    subscribe(value: typeof listener) { listener = value; return () => {}; },
    async initialize() {},
    async createSession() { return { launcherId: "kimi-acp", sessionId: "harness-session", capabilities: {} }; },
    // Kimi 等 CLI 的 cancel 以 stopReason "cancelled" 正常结束 prompt，而非 reject。
    async prompt() { listener?.({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "未写完的" } } }); return { stopReason: "cancelled" }; },
    async cancel() {}, close() {},
  } as unknown as AcpSessionClient;
  const session = new AcpHarnessSession({ id: "kimi-acp", command: "fake", args: [] }, "/workspace", "系统约束", [], { name: "wave-flow-harness", command: "/wave-flow-desktop-engine", args: ["__harness-mcp"], env: [] }, client);
  await expect(session.prompt("写一篇长文")).rejects.toThrow("取消");
});

test("ACP tool_call / tool_call_update 归一化为结构化流事件，think 类调用被过滤", async () => {
  let listener: ((event: { update: acp.SessionUpdate }) => void) | null = null;
  const client = {
    subscribe(value: typeof listener) { listener = value; return () => {}; },
    async initialize() {},
    async createSession() { return { launcherId: "codex-acp", sessionId: "harness-session", capabilities: {} }; },
    async prompt() {
      listener?.({ update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "读取配置文件", name: "read_file", kind: "read", status: "in_progress", locations: [{ path: "/workspace/app.ts", line: 12 }], content: [], rawInput: { path: "/workspace/app.ts" }, rawOutput: null } });
      listener?.({ update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "文件内容" } }] } });
      listener?.({ update: { sessionUpdate: "tool_call", toolCallId: "call-2", title: "内部规划", name: null, kind: "think", status: "in_progress", locations: [], content: [], rawInput: null, rawOutput: null } });
      listener?.({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "完成" } } });
      return { stopReason: "end_turn" };
    },
    async cancel() {}, close() {},
  } as unknown as AcpSessionClient;
  const session = new AcpHarnessSession({ id: "codex-acp", command: "fake", args: [] }, "/workspace", "系统约束", [], { name: "wave-flow-harness", command: "/wave-flow-desktop-engine", args: ["__harness-mcp"], env: [] }, client);
  const events: HarnessStreamEvent[] = []; session.subscribe(event => events.push(event));
  await session.prompt("读取文件");
  expect(events).toEqual([
    { type: "acp_tool_call", call: { callId: "call-1", title: "读取配置文件", name: "read_file", toolKind: "file-read", status: "in_progress", locations: [{ path: "/workspace/app.ts", line: 12 }], contentText: null, rawInput: { path: "/workspace/app.ts" }, rawOutput: null } },
    { type: "acp_tool_update", callId: "call-1", patch: { status: "completed", contentText: "文件内容" } },
    { type: "assistant_delta", delta: "完成" },
  ]);
});
