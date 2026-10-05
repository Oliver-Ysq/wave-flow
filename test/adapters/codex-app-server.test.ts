import { describe, expect, test } from "bun:test";
import { CodexAppServerAdapter, CodexAppServerAmbiguousSubmissionError, CodexAppServerHost, CodexAppServerRegistry, assertLoopbackWebSocketEndpoint, createCodexRemoteViewer, type CodexAppServerConnection, type CodexAppServerMessage, type CodexAppServerRequest, type CodexAppServerResponse } from "../../src/adapters/codex-app-server";
import type { AgentNodeSnapshot } from "../../src/runtime/run-types";
import type { CreateSessionOptions, DestroyResult, SessionBackend, SessionIdentity, SessionLiveness } from "../../src/sessions/types";

const node: AgentNodeSnapshot = {
  id: "review", phase: "执行", sequence: 1, cli: "codex", sandbox: "workspace-write", cwd: "/workspace", label: "review", status: "running", result: null, diagnostic: null,
  createdAt: "2026-10-04T00:00:00.000Z", startedAt: "2026-10-04T00:00:00.000Z", endedAt: null, agentSessionId: null, block: null,
  request: { id: "review", cli: "codex", label: "review", cwd: "/workspace", sandbox: "workspace-write", prompt: "检查实现", phase: "执行" },
};

class FakeConnection implements CodexAppServerConnection {
  readonly sent: Array<CodexAppServerRequest | CodexAppServerResponse | { readonly method: string; readonly params: Readonly<Record<string, unknown>> }> = [];
  closed = false;
  constructor(private readonly replies: CodexAppServerMessage[]) {}
  async send(message: CodexAppServerRequest | CodexAppServerResponse | { readonly method: string; readonly params: Readonly<Record<string, unknown>> }): Promise<void> { this.sent.push(message); }
  async receive(_signal: AbortSignal): Promise<CodexAppServerMessage> {
    const reply = this.replies.shift();
    if (!reply) throw new Error("connection closed");
    return reply;
  }
  async close(): Promise<void> { this.closed = true; }
}

class DeferredConnection extends FakeConnection {
  #release: (() => void) | null = null;
  readonly waiting = new Promise<void>((resolve) => { this.#release = resolve; });
  override async receive(signal: AbortSignal): Promise<CodexAppServerMessage> {
    await Promise.race([this.waiting, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))]);
    return super.receive(signal);
  }
  release(): void { this.#release?.(); }
}

function adapter(replies: CodexAppServerMessage[]) {
  const connection = new FakeConnection(replies);
  return { connection, adapter: new CodexAppServerAdapter("ws://127.0.0.1:4500", async () => connection, 100) };
}

describe("CodexAppServerAdapter", () => {
  test("严格按 initialize、thread/start、turn/start ACK 提交，且不使用 tmux history", async () => {
    const { adapter: subject, connection } = adapter([
      { id: 1, result: { serverInfo: { name: "codex" } } },
      { id: 2, result: { thread: { id: "thr-1" } } },
      { id: 3, result: { turn: { id: "turn-1" } } },
    ]);
    const result = await subject.submitInitialPrompt(node, "检查实现", new AbortController().signal);
    expect(result).toEqual({ submitted: true, proof: "native-rpc", binding: { endpoint: "ws://127.0.0.1:4500", threadId: "thr-1", turnId: "turn-1" } });
    expect(connection.sent.map(methodOf)).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    expect((connection.sent[2] as CodexAppServerRequest).params).toMatchObject({ cwd: "/workspace", sandbox: "workspace-write", serviceName: "wave-flow" });
    expect((connection.sent[3] as CodexAppServerRequest).params).toEqual({ threadId: "thr-1", input: [{ type: "text", text: "检查实现" }] });
  });

  test("turn/start ACK 缺失或 request id 错配时进入 ambiguous，绝不自动重发", async () => {
    const { adapter: subject, connection } = adapter([
      { id: 1, result: {} }, { id: 2, result: { thread: { id: "thr-1" } } }, { id: 99, result: { turn: { id: "turn-1" } } },
    ]);
    await expect(subject.submitInitialPrompt(node, "检查实现", new AbortController().signal)).rejects.toBeInstanceOf(CodexAppServerAmbiguousSubmissionError);
    expect(connection.sent.filter((item) => methodOf(item) === "turn/start")).toHaveLength(1);
  });

  test("等待 turn/start ACK 时分流命令审批并按 Botmux 接受会话内授权，不误判为 ACK 错配", async () => {
    const { adapter: subject, connection } = adapter([
      { id: 1, result: {} },
      { id: 2, result: { thread: { id: "thr-1" } } },
      { id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: "thr-1" } },
      { id: 3, result: { turn: { id: "turn-1" } } },
    ]);
    await expect(subject.submitInitialPrompt(node, "检查实现", new AbortController().signal)).resolves.toMatchObject({ binding: { turnId: "turn-1" } });
    expect(connection.sent.at(-1)).toEqual({ id: "approval-1", result: { decision: "acceptForSession" } });
  });

  test("文件变更审批同样按 Botmux 接受会话内授权，但不扩大 request_permissions", async () => {
    const { adapter: subject, connection } = adapter([
      { id: 1, result: {} },
      { id: 2, result: { thread: { id: "thr-1" } } },
      { id: "file-1", method: "item/fileChange/requestApproval", params: {} },
      { id: "permissions-1", method: "item/permissions/requestApproval", params: {} },
      { id: 3, result: { turn: { id: "turn-1" } } },
    ]);
    await subject.submitInitialPrompt(node, "检查实现", new AbortController().signal);
    expect(connection.sent).toContainEqual({ id: "file-1", result: { decision: "acceptForSession" } });
    expect(connection.sent).toContainEqual({ id: "permissions-1", result: { permissions: {} } });
  });

  test("MCP elicitation 与未知 server request 均有明确回应，绝不静默悬挂", async () => {
    const { adapter: subject, connection } = adapter([
      { id: 1, result: {} },
      { id: 2, result: { thread: { id: "thr-1" } } },
      { id: "mcp-1", method: "mcpServer/elicitation/request", params: {} },
      { id: "unknown-1", method: "future/request", params: {} },
      { id: 3, result: { turn: { id: "turn-1" } } },
    ]);
    await subject.submitInitialPrompt(node, "检查实现", new AbortController().signal);
    expect(connection.sent).toContainEqual({ id: "mcp-1", result: { action: "cancel", content: null } });
    expect(connection.sent).toContainEqual({ id: "unknown-1", error: { code: -32601, message: "Wave Flow 尚未支持 App Server server request：future/request" } });
  });

  test("工具输入请求使用官方 answers response shape，而不混用 MCP cancel", async () => {
    const { adapter: subject, connection } = adapter([
      { id: 1, result: {} },
      { id: 2, result: { thread: { id: "thr-1" } } },
      { id: "input-1", method: "item/tool/requestUserInput", params: {} },
      { id: 3, result: { turn: { id: "turn-1" } } },
    ]);
    await subject.submitInitialPrompt(node, "检查实现", new AbortController().signal);
    expect(connection.sent).toContainEqual({ id: "input-1", result: { answers: {} } });
  });

  test("恢复时先以 thread/resume 验证原 thread，再以 ACK 创建新 turn", async () => {
    const { adapter: subject, connection } = adapter([
      { id: 1, result: {} }, { id: 2, result: { thread: { id: "thr-old" } } }, { id: 3, result: { turn: { id: "turn-new" } } },
    ]);
    const result = await subject.submitInitialPrompt(node, "继续检查", new AbortController().signal, "thr-old");
    expect(result.binding).toMatchObject({ threadId: "thr-old", turnId: "turn-new" });
    expect(connection.sent.map(methodOf)).toContain("thread/resume");
  });

  test("控制操作单飞，拒绝并发 turn 请求而不让响应交叉归属", async () => {
    const connection = new DeferredConnection([
      { id: 1, result: {} }, { id: 2, result: { thread: { id: "thr-1" } } }, { id: 3, result: { turn: { id: "turn-1" } } },
    ]);
    const subject = new CodexAppServerAdapter("ws://127.0.0.1:4500", async () => connection, 100);
    const first = subject.submitInitialPrompt(node, "检查实现", new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(subject.interrupt("thr-1", "turn-1", new AbortController().signal)).rejects.toThrow("拒绝并发请求");
    connection.release();
    await expect(first).resolves.toMatchObject({ binding: { turnId: "turn-1" } });
  });
});

describe("Codex App Server viewer 与注册边界", () => {
  test("viewer 严格使用 remote resume argv，不能携带 Prompt", async () => {
    const capture: { options: CreateSessionOptions | null } = { options: null };
    const sessions: SessionBackend = {
      async create(value) { capture.options = value; return identity; }, async sendText() {}, async pasteText() {}, async sendSpecialKey() {}, async readRecent() { return ""; }, async liveness() { return "missing" as SessionLiveness; }, async detach() {}, async destroy(): Promise<DestroyResult> { return { status: "destroyed", diagnostic: null }; },
    };
    await createCodexRemoteViewer(sessions, { runId: "run-1", node, identityFile: "/tmp/session.json" }, { endpoint: "ws://127.0.0.1:4500", threadId: "thr-1", turnId: "turn-1" });
    const viewerCommand = capture.options?.command;
    expect(viewerCommand).toEqual(["codex", "--remote", "ws://127.0.0.1:4500", "-c", "check_for_update_on_startup=false", "resume", "--no-alt-screen", "thr-1"]);
    expect(JSON.stringify(viewerCommand)).not.toContain("Prompt");
  });

  test("只接受无凭据的 IPv4 loopback ws endpoint，且 Registry 不接受空实现", () => {
    expect(() => assertLoopbackWebSocketEndpoint("ws://localhost:4500")).toThrow("loopback");
    expect(() => assertLoopbackWebSocketEndpoint("wss://127.0.0.1:4500")).toThrow("loopback");
    expect(() => assertLoopbackWebSocketEndpoint("ws://127.0.0.1:4500/?token=x")).toThrow("loopback");
    expect(() => new CodexAppServerRegistry().resolve()).toThrow("未注册");
  });
});

describe("CodexAppServerHost", () => {
  test("仅以 loopback listener 启动，并在 endpoint 可连接后才报告就绪", async () => {
    const capture: { command: readonly string[] | null } = { command: null };
    let killed = false;
    const host = new CodexAppServerHost(
      (argv) => { capture.command = argv; return { exited: new Promise<number>(() => {}), kill: () => { killed = true; } }; },
      "codex-test",
      100,
    );
    const endpoint = await host.start(async () => new FakeConnection([]), new AbortController().signal);
    expect(endpoint).toStartWith("ws://127.0.0.1:");
    expect(capture.command).toEqual(["codex-test", "app-server", "--listen", endpoint]);
    host.stop();
    expect(killed).toBe(true);
  });

  test("并发 start 复用同一启动事务，避免创建两个 App Server", async () => {
    let spawned = 0;
    const latch: { release: (() => void) | null } = { release: null };
    const connectable = new Promise<void>((resolve) => { latch.release = resolve; });
    const host = new CodexAppServerHost(
      () => { spawned += 1; return { exited: new Promise<number>(() => {}), kill() {} }; },
      "codex-test",
      100,
    );
    const signal = new AbortController().signal;
    const first = host.start(async () => { await connectable; return new FakeConnection([]); }, signal);
    const second = host.start(async () => new FakeConnection([]), signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spawned).toBe(1);
    latch.release?.();
    expect(await first).toBe(await second);
  });

  test("stop 会使尚未就绪的旧启动失效，不能在之后复活 endpoint", async () => {
    const latch: { release: (() => void) | null } = { release: null };
    const connectable = new Promise<void>((resolve) => { latch.release = resolve; });
    let killed = 0;
    const host = new CodexAppServerHost(
      () => ({ exited: new Promise<number>(() => {}), kill: () => { killed += 1; } }),
      "codex-test",
      100,
    );
    const starting = host.start(async () => { await connectable; return new FakeConnection([]); }, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    host.stop();
    latch.release?.();
    await expect(starting).rejects.toThrow("已被停止");
    expect(killed).toBeGreaterThan(0);
  });

  test("成功启动后可观察 App Server 进程退出", async () => {
    let exit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { exit = resolve; });
    const host = new CodexAppServerHost(
      () => ({ exited, kill() {} }),
      "codex-test",
      100,
    );
    await host.start(async () => new FakeConnection([]), new AbortController().signal);
    exit(17);
    await expect(host.exited).resolves.toBe(17);
  });

  test("stop 后立即 start 创建新 generation，旧启动的 finally 不会清空新事务", async () => {
    const firstLatch: { release: (() => void) | null } = { release: null };
    const firstConnect = new Promise<void>((resolve) => { firstLatch.release = resolve; });
    let spawned = 0;
    const host = new CodexAppServerHost(
      () => { spawned += 1; return { exited: new Promise<number>(() => {}), kill() {} }; },
      "codex-test",
      100,
    );
    const first = host.start(async () => { await firstConnect; return new FakeConnection([]); }, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    host.stop();
    const second = host.start(async () => new FakeConnection([]), new AbortController().signal);
    firstLatch.release?.();
    await expect(first).rejects.toThrow("已被停止");
    await expect(second).resolves.toStartWith("ws://127.0.0.1:");
    expect(spawned).toBe(2);
  });

  test("独立 Registry 只接纳完整 App Server Adapter，且不能重复注册", () => {
    const { adapter: subject } = adapter([]);
    const registry = new CodexAppServerRegistry();
    registry.register({ cli: "codex", controlTransport: "app-server-bridged", adapter: subject, probeCapabilities: async () => capabilities });
    expect(registry.resolve().adapter).toBe(subject);
    expect(() => registry.register({ cli: "codex", controlTransport: "app-server-bridged", adapter: subject, probeCapabilities: async () => capabilities })).toThrow("已注册");
  });
});

const identity: SessionIdentity = { backend: "tmux", sessionName: "wf-test", backendRef: "/tmp/tmux.sock", runId: "run-1", nodeId: "review", agentSessionId: "agent-1", cli: "codex", createdAt: "2026-10-04T00:00:00.000Z" };
const capabilities = { status: "available", interactiveSession: "available", verifiedPromptDelivery: "available", persistentTmuxSession: "available", sandbox: { readOnly: "available", workspaceWrite: "available" } } as const;

function methodOf(message: CodexAppServerRequest | CodexAppServerResponse | { readonly method: string; readonly params: Readonly<Record<string, unknown>> }): string | undefined {
  return "method" in message ? message.method : undefined;
}
