import { expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import { AcpHarnessSession, applyWaveFlowCommandInstruction } from "../../src/harness/acp-harness";
import type { AcpSessionClient } from "../../src/adapters/acp-session";
import type { HarnessStreamEvent } from "../../src/harness/types";

test("ACP Harness 创建独立 session、注入私有 MCP 并只耐久 assistant 文本", async () => {
  let servers: acp.McpServer[] = []; let startupBudget:number|undefined; let prompt = ""; let listener: ((event: { update: acp.SessionUpdate }) => void) | null = null;
  const client = {
    subscribe(value: typeof listener) { listener = value; return () => {}; },
    async initialize() {},
    async createSession(_cwd: string, _signal: AbortSignal, value: acp.McpServer[], budget?:number) { servers = value; startupBudget=budget; return { launcherId: "codex-acp", sessionId: "harness-session", capabilities: {} }; },
    async prompt(value: string) { prompt = value; listener?.({ update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "思考" } } }); listener?.({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "完整回答" } } }); return { stopReason: "end_turn" }; },
    async cancel() {}, close() {},
  } as unknown as AcpSessionClient;
  const session = new AcpHarnessSession({ id: "codex-acp", command: "fake", args: [] }, "/workspace", "系统约束", [{ id: "u", role: "user", text: "旧消息", createdAt: new Date().toISOString() }], { name: "wave-flow-harness", command: "/wave-flow-desktop-engine", args: ["__harness-mcp"], env: [] }, client);
  const events: HarnessStreamEvent[] = []; session.subscribe(event => events.push(event));
  await expect(session.prompt("新消息")).resolves.toBe("完整回答");
  expect(servers).toEqual([{ name: "wave-flow-harness", command: "/wave-flow-desktop-engine", args: ["__harness-mcp"], env: [] }]);
  expect(startupBudget).toBe(10_000);
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

for (const stopReason of ["max_tokens", "max_turn_requests", "refusal", "unknown_reason", undefined]) {
  test(`ACP 非正常结束 ${String(stopReason)} 不能接纳非空部分回答`, async () => {
    let listener: ((event: { update: acp.SessionUpdate }) => void) | null = null;
    const client = {
      subscribe(value: typeof listener) { listener = value; return () => {}; },
      async initialize() {}, async createSession() {},
      async prompt() {
        listener?.({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "尚未写完的回答" } } });
        return { stopReason };
      },
      close() {},
    } as unknown as AcpSessionClient;
    const session = new AcpHarnessSession({ id: "codex-acp", command: "fake", args: [] }, "/workspace", "系统约束", [], { name: "test", command: "fake", args: [], env: [] }, client);
    await expect(session.prompt("总结")).rejects.toThrow("未正常结束");
    expect(session.isRunning).toBe(false);
  });
}

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

/** 回归：附件路径在 Harness 生命周期锁内调用 prepare；CLI 假死若无超时会把锁永久
 * 挂住，该 Harness 后续所有 action 无响应。握手必须在预算内断开并放行。 */
test("主控 CLI 握手假死有界：prepare 超时断开而不是永久等待", async () => {
  process.env.WF_HARNESS_PREPARE_BUDGET_MS = "100";
  try {
    const client = {
      subscribe() { return () => {}; },
      // initialize 永不主动返回，仅在调用方 abort 后 reject —— 模拟假死 CLI 进程。
      initialize(signal: AbortSignal) { return new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }); },
      async createSession() {}, async prompt() {}, async cancel() {}, close() {},
    } as unknown as AcpSessionClient;
    const session = new AcpHarnessSession({ id: "codex-acp", command: "fake", args: [] }, "/workspace", "系统约束", [], { name: "test", command: "fake", args: [], env: [] }, client);
    await expect(session.prepare()).rejects.toThrow("未响应");
  } finally { delete process.env.WF_HARNESS_PREPARE_BUDGET_MS; }
});

test("/wave-flow 在独立 token 时注入宿主提案说明，普通消息不注入", async () => {
  const captured: string[] = [];
  let listener: ((event: { update: acp.SessionUpdate }) => void) | null = null;
  const client = {
    subscribe(value: typeof listener) { listener = value; return () => {}; },
    async initialize() {},
    async createSession() { return { launcherId: "codex-acp", sessionId: "harness-session", capabilities: {} }; },
    async prompt(value: string) {
      captured.push(value);
      listener?.({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "完成" } } });
      return { stopReason: "end_turn" };
    },
    async cancel() {}, close() {},
  } as unknown as AcpSessionClient;
  const session = new AcpHarnessSession({ id: "codex-acp", command: "fake", args: [] }, "/workspace", "系统约束", [], { name: "test", command: "fake", args: [], env: [] }, client);
  await session.prompt("/wave-flow 分析这个流程");
  expect(captured[0]).toContain("宿主命令 /wave-flow");
  expect(captured[0]).toContain("propose_workflow_revision");
  // /wave-flow 后点名的技能默认交给 Worker，而不是要求主控立即调用。
  expect(captured[0]).toContain("默认表示 Worker");
  expect(captured[0]).toContain("除非用户明确要求主控执行");
  expect(captured[0]).toContain("仅作为任务提示");
  expect(captured[0]).toContain("主控仍可");
  await session.prompt("普通追问");
  expect(captured[1]).toBe("普通追问");
  // 只有 `/wave-flow` 独立 token 才算命令；前缀相似文本不能被误判。
  expect(applyWaveFlowCommandInstruction("/waveflow 不是命令")).toBe("/waveflow 不是命令");
  // 多命令共存时，/wave-flow 出现在中间也必须触发提案说明。
  expect(applyWaveFlowCommandInstruction("$brainstorming /wave-flow 分析")).toContain("propose_workflow_revision");
  // 用户示例形态：/wave-flow 之后跟多个技能，默认归 Worker。
  expect(applyWaveFlowCommandInstruction("/wave-flow 使用 $bytedcli $cyber-figma-understanding 生成figma理解文档")).toContain("默认表示 Worker");
});

test("ACP 命令目录归一化为 commands_changed，并缓存给后订阅者", async () => {
  let listener: ((event: { update: acp.SessionUpdate }) => void) | null = null;
  const client = {
    subscribe(value: typeof listener) { listener = value; return () => {}; },
    async initialize() {},
    async createSession() { return { launcherId: "codex-acp", sessionId: "harness-session", capabilities: {} }; },
    async prompt() {
      listener?.({ update: { sessionUpdate: "available_commands_update", availableCommands: [
        { name: "compact", description: "压缩上下文", input: null },
        { name: "$brainstorming", description: "头脑风暴", input: null },
        { name: "status", description: "查看状态", input: { hint: "[detail]" } },
      ] } });
      listener?.({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "完成" } } });
      return { stopReason: "end_turn" };
    },
    async cancel() {}, close() {},
  } as unknown as AcpSessionClient;
  const session = new AcpHarnessSession({ id: "codex-acp", command: "fake", args: [] }, "/workspace", "系统约束", [], { name: "test", command: "fake", args: [], env: [] }, client);
  const events: HarnessStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  await session.prompt("加载命令");
  const changed = events.find((event) => event.type === "commands_changed");
  expect(changed).toEqual({ type: "commands_changed", commands: [
    { name: "compact", description: "压缩上下文", inputHint: null },
    { name: "$brainstorming", description: "头脑风暴", inputHint: null },
    { name: "status", description: "查看状态", inputHint: "[detail]" },
  ] });
  // 命令可能先于服务层订阅到达；后订阅者必须立即得到缓存，不能空白。
  const late: HarnessStreamEvent[] = [];
  session.subscribe((event) => late.push(event));
  expect(changed).toBeDefined();
  expect(late).toEqual([changed!]);
});
