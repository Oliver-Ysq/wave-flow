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
  const session = new AcpHarnessSession({ id: "codex-acp", command: "fake", args: [] }, "/workspace", "系统约束", [{ id: "u", role: "user", text: "旧消息", createdAt: new Date().toISOString() }], { name: "wave-flow-harness", command: "/wave-flow-daemon", args: ["__harness-mcp"], env: [] }, client);
  const events: HarnessStreamEvent[] = []; session.subscribe(event => events.push(event));
  await expect(session.prompt("新消息")).resolves.toBe("完整回答");
  expect(servers).toEqual([{ name: "wave-flow-harness", command: "/wave-flow-daemon", args: ["__harness-mcp"], env: [] }]);
  expect(prompt).toContain("旧消息"); expect(prompt).toContain("新消息");
  expect(events).toEqual([{ type: "reasoning_delta", delta: "思考" }, { type: "assistant_delta", delta: "完整回答" }]);
  await session.prompt("第二轮");
  expect(prompt).toBe("第二轮");
});
