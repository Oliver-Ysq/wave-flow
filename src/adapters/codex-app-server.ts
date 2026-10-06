import { createServer } from "node:net";
import type { AdapterCapabilities } from "./capabilities";
import type { AgentNodeSnapshot } from "../runtime/run-types";
import type { SessionBackend, SessionIdentity } from "../sessions/types";

/** App Server JSON-RPC 请求；仅用于本机受控 Codex 协议，不接受 Workflow 提供的任意方法。 */
export type CodexAppServerRequest = {
  /** 请求的单连接唯一编号。 */
  readonly id: number;
  /** 官方 App Server 方法名。 */
  readonly method: string;
  /** 对应方法的 JSON-safe 参数。 */
  readonly params: Readonly<Record<string, unknown>>;
};

/** App Server 返回的 JSON-RPC 响应或通知。 */
export type CodexAppServerMessage = {
  /** 响应关联编号；通知没有该字段。 */
  readonly id?: number | string;
  /** 通知方法名。 */
  readonly method?: string;
  /** 成功响应或通知负载。 */
  readonly result?: unknown;
  /** JSON-RPC 错误。 */
  readonly error?: { readonly code?: number; readonly message?: string };
  /** 通知参数。 */
  readonly params?: unknown;
};

/** 对 App Server 主动发起请求的 JSON-RPC 回应；当前未接入 Web/HITL 时一律 fail-closed。 */
export type CodexAppServerResponse = {
  /** 必须原样回传 App Server server request 的 JSON-RPC id。 */
  readonly id: number | string;
  /** 成功处理的返回内容。 */
  readonly result?: Readonly<Record<string, unknown>>;
  /** 无法安全处理的请求使用标准 JSON-RPC 错误响应。 */
  readonly error?: { readonly code: number; readonly message: string };
};

/** 受控 WebSocket 连接的最小接口；生产实现和 fake server 使用同一边界。 */
export interface CodexAppServerConnection {
  /** 写入一条完整 JSON-RPC 消息；成功只代表本地连接已接受写入。 */
  send(message: CodexAppServerRequest | CodexAppServerResponse | { readonly method: string; readonly params: Readonly<Record<string, unknown>> }): Promise<void>;
  /** 等待下一条响应或通知；连接结束必须 reject，不能伪造空响应。 */
  receive(signal: AbortSignal): Promise<CodexAppServerMessage>;
  /** 关闭本连接；不会把任何未确认请求当作未发送。 */
  close(): Promise<void>;
}

/** 建立本机 App Server loopback WebSocket 的工厂。 */
export type CodexAppServerConnectionFactory = (endpoint: string, signal: AbortSignal) => Promise<CodexAppServerConnection>;

/** 由 Host 启动的本机 App Server 进程；只暴露受控终止能力。 */
export type CodexAppServerProcess = {
  /** 进程退出状态；提前退出视为 Host 启动失败。 */
  readonly exited: Promise<number>;
  /** 终止 App Server；不得借此改变任何已提交 turn 的业务状态。 */
  kill(): void;
};

/** 可注入 App Server 进程创建器，避免测试依赖真实账号或模型服务。 */
export type CodexAppServerProcessSpawner = (command: readonly string[], env: Readonly<Record<string, string>>) => CodexAppServerProcess;

/** 本机 loopback App Server Host；它不接受 Workflow 自定义 argv 或 listener 地址。 */
export class CodexAppServerHost {
  #process: CodexAppServerProcess | null = null;
  #endpoint: string | null = null;
  #starting: Promise<string> | null = null;
  #startingGeneration: number | null = null;
  #generation = 0;

  /** @param command 正常 Codex 可执行文件，默认从 PATH 查找 `codex`。 */
  constructor(private readonly spawnProcess: CodexAppServerProcessSpawner = bunCodexAppServerSpawner, private readonly command = "codex", private readonly readyTimeoutMs = 10_000, private readonly sessionEnv: Readonly<Record<string, string>> = {}) {
    if (!Number.isFinite(readyTimeoutMs) || readyTimeoutMs <= 0) throw new Error("App Server readyTimeoutMs 必须是正的有限毫秒数。");
  }

  /** 启动仅监听 IPv4 loopback 的官方 experimental WebSocket transport，并确认可以建立控制连接。 */
  async start(connect: CodexAppServerConnectionFactory, signal: AbortSignal): Promise<string> {
    if (this.#endpoint) return this.#endpoint;
    if (this.#starting && this.#startingGeneration === this.#generation) return this.#starting;
    const generation = this.#generation;
    const starting = this.startOnce(connect, signal, generation).finally(() => {
      if (this.#starting === starting) {
        this.#starting = null;
        this.#startingGeneration = null;
      }
    });
    this.#starting = starting;
    this.#startingGeneration = generation;
    return starting;
  }

  private async startOnce(connect: CodexAppServerConnectionFactory, signal: AbortSignal, generation: number): Promise<string> {
    const port = await reserveLoopbackPort();
    this.requireCurrentGeneration(generation);
    const endpoint = `ws://127.0.0.1:${port}`;
    const process = this.spawnProcess([this.command, "app-server", "--listen", endpoint], this.sessionEnv);
    this.#process = process;
    try {
      await waitForConnectableEndpoint(endpoint, connect, process.exited, this.readyTimeoutMs, signal);
      this.requireCurrentGeneration(generation);
      this.#endpoint = endpoint;
      return endpoint;
    } catch (error) {
      if (this.#process === process) this.#process = null;
      process.kill();
      throw new Error(`Codex App Server 启动失败：${messageOf(error)}`);
    }
  }

  /** 停止本 Host 创建的 App Server；已接受但未确认的 turn 仍由上层按 ambiguous 处理。 */
  stop(): void {
    this.#generation += 1;
    this.#process?.kill();
    this.#process = null;
    this.#endpoint = null;
  }

  /**
   * 返回当前 App Server 的退出事实。
   *
   * Host 已成功报告 endpoint 后，进程仍可能异常退出；调用方必须监测这一事实，不能
   * 只因 remote viewer 仍在重连就把节点误认为可继续。未启动时没有可观察进程。
   */
  get exited(): Promise<number> {
    if (!this.#process) throw new Error("Codex App Server 尚未启动，无法观察退出状态。");
    return this.#process.exited;
  }

  /** 异步启动完成前被 stop 或替代启动时，旧实例不能重新写回当前 Host。 */
  private requireCurrentGeneration(generation: number): void {
    if (generation !== this.#generation) throw new Error("Codex App Server 启动已被停止或替代。");
  }
}

/** 基于 Bun WebSocket 的官方 JSON-RPC text-frame transport；仅连接已验证的 loopback endpoint。 */
export const bunCodexAppServerConnection: CodexAppServerConnectionFactory = async (endpoint, signal) => {
  assertLoopbackWebSocketEndpoint(endpoint);
  if (signal.aborted) throw new Error("App Server 连接已取消。");
  return new Promise<CodexAppServerConnection>((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    const messages: CodexAppServerMessage[] = [];
    const waiters: Array<{ resolve: (value: CodexAppServerMessage) => void; reject: (reason: Error) => void; signal: AbortSignal; abort: () => void }> = [];
    let opened = false;
    let closed: Error | null = null;
    const fail = (error: Error) => {
      if (closed) return;
      closed = error;
      while (waiters.length > 0) {
        const waiter = waiters.shift()!;
        waiter.signal.removeEventListener("abort", waiter.abort);
        waiter.reject(error);
      }
    };
    const connection: CodexAppServerConnection = {
      async send(message) {
        if (closed || socket.readyState !== WebSocket.OPEN) throw closed ?? new Error("App Server WebSocket 未连接。");
        socket.send(JSON.stringify(message));
      },
      async receive(waitSignal) {
        if (messages.length > 0) return messages.shift()!;
        if (closed) throw closed;
        return new Promise<CodexAppServerMessage>((resolveReceive, rejectReceive) => {
          const abort = () => {
            const index = waiters.findIndex((waiter) => waiter.resolve === resolveReceive);
            if (index >= 0) waiters.splice(index, 1);
            rejectReceive(new Error("App Server 接收已取消。"));
          };
          waitSignal.addEventListener("abort", abort, { once: true });
          waiters.push({ resolve: resolveReceive, reject: rejectReceive, signal: waitSignal, abort });
        });
      },
      async close() { socket.close(); fail(new Error("App Server WebSocket 已关闭。")); },
    };
    socket.addEventListener("open", () => { opened = true; signal.removeEventListener("abort", abortOpen); resolve(connection); });
    socket.addEventListener("error", () => { const error = new Error("App Server WebSocket 连接失败。"); if (!opened) reject(error); fail(error); });
    socket.addEventListener("close", () => { const error = new Error("App Server WebSocket 已关闭。"); if (!opened) reject(error); fail(error); });
    socket.addEventListener("message", (event) => {
      let parsed: unknown;
      try { parsed = JSON.parse(String(event.data)); } catch { fail(new Error("App Server 返回了非法 JSON-RPC 消息。")); return; }
      if (!parsed || typeof parsed !== "object") { fail(new Error("App Server 返回了非对象 JSON-RPC 消息。")); return; }
      const message = parsed as CodexAppServerMessage;
      if (isServerRequest(message)) {
        void connection.send(serverRequestFailClosedResponse(message)).catch((error) => fail(new Error(`App Server server request 回应失败：${messageOf(error)}`)));
        return;
      }
      const waiter = waiters.shift();
      if (waiter) { waiter.signal.removeEventListener("abort", waiter.abort); waiter.resolve(message); } else messages.push(message);
    });
    const abortOpen = () => { socket.close(); reject(new Error("App Server 连接已取消。")); };
    signal.addEventListener("abort", abortOpen, { once: true });
  });
};

/** 已确认的 App Server thread / turn 身份，必须写入后续会话记录。 */
export type CodexAppServerBinding = {
  /** 官方 thread id；不能用 nodeId 或本地随机值替代。 */
  readonly threadId: string;
  /** 首条 Prompt 已被 App Server 接收的 turn id。 */
  readonly turnId: string;
  /** 建立绑定的 loopback endpoint。 */
  readonly endpoint: string;
};

/** App Server Adapter 的独立注册项；它故意不继承 InteractiveCliAdapter。 */
export type RegisteredCodexAppServerAdapter = {
  /** 当前固定为 Codex。 */
  readonly cli: "codex";
  /** 独立控制传输标识。 */
  readonly controlTransport: "app-server-bridged";
  /** 实现 App Server protocol 的 Adapter。 */
  readonly adapter: CodexAppServerAdapter;
  /** 只报告该协议实际可验证的能力。 */
  readonly probeCapabilities: () => Promise<AdapterCapabilities>;
};

/** App Server 的独立注册边界，不能误注册到 tmux TUI Gate。 */
export class CodexAppServerRegistry {
  #entry: RegisteredCodexAppServerAdapter | null = null;

  /** 仅允许一个完整的 App Server bridge 实现。 */
  register(entry: RegisteredCodexAppServerAdapter): void {
    if (entry.adapter.cli !== entry.cli) throw new Error(`App Server Adapter 注册 CLI 不一致：${entry.adapter.cli}，期望 ${entry.cli}。`);
    if (entry.controlTransport !== "app-server-bridged") throw new Error("App Server Registry 仅接受 app-server-bridged 控制传输。");
    if (typeof entry.probeCapabilities !== "function") throw new Error("App Server Adapter 注册缺少 capability 探测器。");
    if (this.#entry) throw new Error("App Server Adapter 已注册。");
    this.#entry = entry;
  }

  /** 返回唯一 bridge；未注册时必须 fail closed。 */
  resolve(): RegisteredCodexAppServerAdapter {
    if (!this.#entry) throw new Error("未注册的 Codex App Server Adapter。");
    return this.#entry;
  }
}

/** App Server 首条 Prompt 的可审计提交结果。 */
export type CodexAppServerSubmission = {
  /** 只有接到同 request id 的 turn/start 成功响应时为 true。 */
  readonly submitted: true;
  /** App Server 原生 RPC 是唯一确认依据。 */
  readonly proof: "native-rpc";
  /** 绑定后的官方 thread / turn 身份。 */
  readonly binding: CodexAppServerBinding;
};

/** 连接或响应不确定时的 fail-closed 结果；调用方不得自动重发。 */
export class CodexAppServerAmbiguousSubmissionError extends Error {
  /** 请求可能已到达 server，因而不能安全自动重放。 */
  readonly retryAutomatically = false;
}

/**
 * Codex App Server 的受控控制面。
 *
 * 严格对应官方 initialize → thread/start|resume → turn/start 顺序。此类不将 goal、
 * turn/completed 或终端文字映射为 Wave Flow 业务状态；它只证明首条 Prompt 已被官方协议接收。
 */
export class CodexAppServerAdapter {
  readonly id = "codex-app-server";
  readonly cli = "codex" as const;
  #connection: CodexAppServerConnection | null = null;
  #initializing: Promise<void> | null = null;
  #controlOperationActive = false;
  #nextRequestId = 1;

  /** @param endpoint 仅允许由 daemon 生成的 loopback ws endpoint。 */
  constructor(private readonly endpoint: string, private readonly connect: CodexAppServerConnectionFactory, private readonly requestTimeoutMs = 15_000) {
    assertLoopbackWebSocketEndpoint(endpoint);
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new Error("App Server requestTimeoutMs 必须是正的有限毫秒数。");
  }

  /** 初始化唯一控制连接；初始化失败时不会创建或猜测 thread。 */
  async initialize(signal: AbortSignal): Promise<void> {
    if (this.#connection) return;
    if (this.#initializing) return this.#initializing;
    this.#initializing = this.openAndInitialize(signal).finally(() => { this.#initializing = null; });
    return this.#initializing;
  }

  /** 创建或显式恢复 thread，并以 turn/start ACK 证明首条 Prompt 已进入该 thread。 */
  async submitInitialPrompt(node: AgentNodeSnapshot, prompt: string, signal: AbortSignal, existingThreadId?: string): Promise<CodexAppServerSubmission> {
    return this.withExclusiveControlOperation(async () => {
    if (node.cli !== "codex") throw new Error("Codex App Server Adapter 只能启动 cli: codex 节点。");
    if (!prompt.trim()) throw new Error("Codex App Server 初始 Prompt 必须为非空字符串。");
    await this.initialize(signal);
    const connection = this.requireConnection();
    const thread = existingThreadId
      ? await this.request(connection, "thread/resume", { threadId: existingThreadId }, signal)
      : await this.request(connection, "thread/start", appServerThreadParams(node), signal);
    const threadId = readId(thread, "thread", "id");
    const turn = await this.request(connection, "turn/start", { threadId, input: [{ type: "text", text: prompt }] }, signal, true);
    const turnId = readId(turn, "turn", "id");
    return { submitted: true, proof: "native-rpc", binding: { endpoint: this.endpoint, threadId, turnId } };
    });
  }

  /** 仅验证旧 App Server 仍持有指定 thread；绝不创建新 turn。 */
  async verifyExistingThread(threadId: string, signal: AbortSignal): Promise<void> {
    return this.withExclusiveControlOperation(async () => {
      if (!threadId.trim()) throw new Error("旧 App Server threadId 不能为空。");
      await this.initialize(signal);
      const result = await this.request(this.requireConnection(), "thread/resume", { threadId }, signal);
      if (readId(result, "thread", "id") !== threadId) throw new Error("旧 App Server 返回的 threadId 与 Journal 不匹配。");
    });
  }

  /** 请求取消当前 turn；成功仅代表 App Server 已接受取消，不改变 Wave Flow 节点状态。 */
  async interrupt(threadId: string, turnId: string, signal: AbortSignal): Promise<void> {
    return this.withExclusiveControlOperation(async () => {
    await this.initialize(signal);
    await this.request(this.requireConnection(), "turn/interrupt", { threadId, turnId }, signal);
    });
  }

  /** 列出 App Server 可枚举的 thread 背景终端；仅实验协议已显式协商时可用。 */
  async listBackgroundTerminals(threadId: string, signal: AbortSignal): Promise<readonly { readonly processId: string; readonly command: string }[]> {
    return this.withExclusiveControlOperation(async () => {
      await this.initialize(signal);
      const result = await this.request(this.requireConnection(), "thread/backgroundTerminals/list", { threadId }, signal) as { data?: unknown };
      if (!Array.isArray(result?.data)) throw new Error("App Server backgroundTerminals/list 返回无效。 ");
      return result.data.map((item) => {
        if (!item || typeof item !== "object" || typeof (item as { processId?: unknown }).processId !== "string" || typeof (item as { command?: unknown }).command !== "string") throw new Error("App Server background terminal 条目无效。 ");
        return { processId: (item as { processId: string }).processId, command: (item as { command: string }).command };
      });
    });
  }

  /** 停止该 thread 所有 App Server 受管背景终端；调用后必须再次 list 确认空清单。 */
  async cleanBackgroundTerminals(threadId: string, signal: AbortSignal): Promise<void> {
    return this.withExclusiveControlOperation(async () => {
      await this.initialize(signal);
      await this.request(this.requireConnection(), "thread/backgroundTerminals/clean", { threadId }, signal);
    });
  }

  /** 同一 thread 的恢复回合；ACK 不明必须按 ambiguous 处理，禁止重发。 */
  async submitRecoveryPrompt(node: AgentNodeSnapshot, threadId: string, prompt: string, signal: AbortSignal): Promise<CodexAppServerSubmission> {
    return this.submitInitialPrompt(node, prompt, signal, threadId);
  }

  /** 关闭控制连接；保留 thread/turn 的不确定性给调用方 Journal 处理。 */
  async close(): Promise<void> {
    const connection = this.#connection;
    this.#connection = null;
    if (connection) await connection.close();
  }

  private requireConnection(): CodexAppServerConnection {
    if (!this.#connection) throw new Error("Codex App Server 尚未初始化。");
    return this.#connection;
  }

  /** App Server RPC 需按单一请求流消费响应；并发控制请求必须显式拒绝而不是交叉归属。 */
  private async withExclusiveControlOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#controlOperationActive) throw new Error("Codex App Server 控制操作正在进行，拒绝并发请求以避免 RPC 响应错归属。");
    this.#controlOperationActive = true;
    try { return await operation(); } finally { this.#controlOperationActive = false; }
  }

  private async openAndInitialize(signal: AbortSignal): Promise<void> {
    const connection = await this.connect(this.endpoint, signal);
    try {
      await this.request(connection, "initialize", {
        clientInfo: { name: "wave-flow", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      }, signal);
      await connection.send({ method: "initialized", params: {} });
      this.#connection = connection;
    } catch (error) {
      await connection.close().catch(() => {});
      throw error;
    }
  }

  private async request(connection: CodexAppServerConnection, method: string, params: Readonly<Record<string, unknown>>, signal: AbortSignal, ambiguousAfterSend = false): Promise<unknown> {
    const id = this.#nextRequestId++;
    try {
      await connection.send({ id, method, params });
    } catch (error) {
      if (ambiguousAfterSend) throw new CodexAppServerAmbiguousSubmissionError(`App Server ${method} 写入结果不确定，禁止自动重发：${messageOf(error)}`);
      throw new Error(`App Server ${method} 写入失败：${messageOf(error)}`);
    }
    try {
      const response = await receiveMatchingResponse(connection, id, this.requestTimeoutMs, signal);
      if (response.error) throw new Error(`App Server ${method} 拒绝：${response.error.message ?? `code ${response.error.code ?? "unknown"}`}`);
      return response.result;
    } catch (error) {
      if (ambiguousAfterSend) throw new CodexAppServerAmbiguousSubmissionError(`App Server ${method} 未取得可验证 ACK，禁止自动重发：${messageOf(error)}`);
      throw error;
    }
  }
}

/** 为已验证 thread 创建同一 App Server 的 tmux 原生 viewer；不携带任务 Prompt。 */
export async function createCodexRemoteViewer(
  sessions: SessionBackend,
  request: { readonly runId: string; readonly node: AgentNodeSnapshot; readonly identityFile: string; readonly reclaimTokenHash?: string; /** 仅注入 viewer 进程的运行环境；不得写入 Journal 或作为 Agent 身份来源。 */ readonly env?: Readonly<Record<string, string>> },
  binding: CodexAppServerBinding,
  codexCommand = "codex",
): Promise<SessionIdentity> {
  assertLoopbackWebSocketEndpoint(binding.endpoint);
  if (!binding.threadId.trim()) throw new Error("App Server remote viewer 缺少 threadId。");
  return sessions.create({
    runId: request.runId,
    nodeId: request.node.id,
    agentSessionId: request.node.agentSessionId ?? undefined,
    cli: "codex",
    cwd: request.node.cwd,
    // 严格参考 Botmux remote viewer：viewer 不走受控输入 Gate，启动更新选择器会永久遮挡
    // 人工终端，故以进程级配置关闭它；该配置不写入用户全局 Codex 配置。
    command: [codexCommand, "--remote", binding.endpoint, "-c", "check_for_update_on_startup=false", "resume", "--no-alt-screen", binding.threadId],
    env: request.env,
    identityFile: request.identityFile,
    reclaimTokenHash: request.reclaimTokenHash,
  });
}

/** 官方文档仅允许未认证 ws listener 用于 localhost；拒绝 hostname、IPv6 非 loopback 与 query token。 */
export function assertLoopbackWebSocketEndpoint(endpoint: string): void {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("App Server endpoint 必须是有效的 ws://127.0.0.1:<port> URL。"); }
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("App Server endpoint 只能是无凭据、无路径的 ws://127.0.0.1:<port> loopback URL。");
  }
}

function appServerThreadParams(node: AgentNodeSnapshot): Readonly<Record<string, unknown>> {
  return {
    cwd: node.cwd,
    // Codex App Server 0.159 使用与交互 CLI 相同的 kebab-case sandbox 枚举；
    // 不能沿用早期实验协议的 readOnly/workspaceWrite，否则 thread/start 会在
    // 首条任务前拒绝并触发不必要的 tmux fallback。
    sandbox: node.sandbox,
    serviceName: "wave-flow",
    ...(node.request.model ? { model: node.request.model } : {}),
  };
}

async function receiveMatchingResponse(connection: CodexAppServerConnection, id: number, timeoutMs: number, parentSignal: AbortSignal): Promise<CodexAppServerMessage> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    while (true) {
      const message = await connection.receive(controller.signal);
      if (message.id === id) return message;
      if (isServerRequest(message)) {
        await connection.send(serverRequestFailClosedResponse(message));
        continue;
      }
      if (message.id !== undefined) throw new Error(`App Server 响应 request id 不匹配：期望 ${id}，收到 ${message.id}。`);
      // 通知只用于诊断；不得在等待 ACK 时改变任何节点状态。
    }
  } catch (error) {
    if (parentSignal.aborted) throw new Error("App Server 请求已取消。");
    if (controller.signal.aborted) throw new Error("App Server 请求超时。");
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", abort);
  }
}

/** server request 同时带 id 和 method；普通响应只带 id + result/error，不能混为一谈。 */
function isServerRequest(message: CodexAppServerMessage): message is CodexAppServerMessage & { readonly id: number | string; readonly method: string } {
  return message.id !== undefined && typeof message.method === "string" && message.result === undefined && message.error === undefined;
}

/** Web/HITL 尚未接入时，所有 server request 必须得到明确、最小权限的 fail-closed 回应，绝不静默悬挂。 */
function serverRequestFailClosedResponse(request: CodexAppServerMessage & { readonly id: number | string; readonly method: string }): CodexAppServerResponse {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { id: request.id, result: { decision: "acceptForSession" } };
    case "item/permissions/requestApproval":
      return { id: request.id, result: { permissions: {} } };
    case "mcpServer/elicitation/request":
      return { id: request.id, result: { action: "cancel", content: null } };
    case "item/tool/requestUserInput":
      return { id: request.id, result: { answers: {} } };
    default:
      return { id: request.id, error: { code: -32601, message: `Wave Flow 尚未支持 App Server server request：${request.method}` } };
  }
}

function readId(value: unknown, owner: "thread" | "turn", key: "id"): string {
  if (!value || typeof value !== "object") throw new Error(`App Server ${owner} 响应缺失。`);
  const nested = (value as Record<string, unknown>)[owner];
  const identifier = nested && typeof nested === "object" ? (nested as Record<string, unknown>)[key] : undefined;
  if (typeof identifier !== "string" || !identifier.trim()) {
    throw new Error(`App Server ${owner} 响应缺少稳定 ${key}。`);
  }
  return identifier;
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** 由 OS 分配空闲端口后立即释放；随后的连接探测确保 App Server 已实际接管该 endpoint。 */
function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string" || address.family !== "IPv4") { server.close(); reject(new Error("无法分配 IPv4 loopback App Server 端口。")); return; }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForConnectableEndpoint(endpoint: string, connect: CodexAppServerConnectionFactory, exited: Promise<number>, timeoutMs: number, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("App Server 启动已取消。");
    const probe = new AbortController();
    const probeTimer = setTimeout(() => probe.abort(), Math.min(250, Math.max(1, deadline - Date.now())));
    try {
      const connection = await Promise.race([
        connect(endpoint, probe.signal),
        exited.then((code) => Promise.reject(new Error(`App Server 进程提前退出：${code}`))),
      ]);
      await connection.close();
      return;
    } catch (error) {
      const message = messageOf(error);
      if (message.startsWith("App Server 进程提前退出")) throw error;
      await abortableDelay(50, signal);
    } finally {
      clearTimeout(probeTimer);
      probe.abort();
    }
  }
  throw new Error("App Server loopback endpoint 未在时限内可连接。");
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    const abort = () => { clearTimeout(timer); reject(new Error("操作已取消。")); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

const bunCodexAppServerSpawner: CodexAppServerProcessSpawner = (command, env) => {
  const child = Bun.spawn([...command], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...process.env, ...env } });
  return { exited: child.exited, kill: () => child.kill() };
};
