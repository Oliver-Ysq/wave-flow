import * as acp from "@agentclientprotocol/sdk";

/** ACP Agent 的受控启动配置；argv 只能由 Engine 的已验证配置提供。 */
export type AcpLauncher = {
  /** 用于审计和能力策略匹配的稳定标识，例如 `codex-acp`。 */
  readonly id: string;
  /** 已验证的本地可执行文件。 */
  readonly command: string;
  /** 由 Wave Flow 配置提供的固定参数；不接受模型或 Workflow 自定义 argv。 */
  readonly args: readonly string[];
  /** 仅允许非敏感、会话专属的启动环境。 */
  readonly env?: Readonly<Record<string, string>>;
};

/** ACP Agent 请求权限时的客户端决策；Harness 与 Worker 不能共用默认值。 */
export type AcpPermissionMode = "deny" | "allow";
/** Adapter无关的权限决策；未来桌面协调器可耐久等待用户，测试/兼容模式仍用deny/allow。 */
export type AcpPermissionResolver = (
  /** 原CLI的结构化请求，不从文本重建路径或操作。 */ request: acp.RequestPermissionRequest,
  /** 连接/回合取消时中止等待；迟到决定不得返回allow。 */ signal: AbortSignal,
) => Promise<acp.RequestPermissionResponse> | acp.RequestPermissionResponse;


/** ACP transport 的可关闭资源。 */
export type AcpTransport = {
  /** 官方 ACP v1 双向 JSON-RPC stream。 */
  readonly stream: acp.Stream;
  /** 子进程或测试 transport 关闭时 resolve；非零退出是诊断事实。 */
  readonly exited: Promise<number>;
  /** 只关闭 transport；不会将未确认 prompt 解释为未发送。 */
  close(): void;
  /** 生产stdio真实进程组身份；测试transport可省略，省略不能用于受管写退出证明。 */
  readonly writerProcess?: import("../workspace/writer-process-group").OwnedWriterProcess;
  /** 受管写transport提供的有界退出核验；close本身仍为非阻塞清理。 */
  verifyClosed?(): Promise<void>;
};

/** 允许替换 transport，确保协议测试不依赖真实模型或本地登录。 */
export type AcpTransportFactory = (launcher: AcpLauncher, signal: AbortSignal) => Promise<AcpTransport>;

/** 一条已归一化的 ACP 展示事件；它不是 Worker 业务状态。 */
export type AcpSessionEvent = {
  /** 事件所属 ACP session。 */
  readonly sessionId: string;
  /** ACP 标准 session update 的原始结构化内容。 */
  readonly update: acp.SessionUpdate;
};

/** Wave Flow 需要持久化的 ACP 会话绑定；能力快照仅用于 Policy，不是授权凭证。 */
export type AcpSessionBinding = {
  /** 配置中选择的 launcher id。 */
  readonly launcherId: string;
  /** ACP Agent 返回的原生会话 id。 */
  readonly sessionId: string;
  /** initialize 返回的能力快照；恢复前必须重新协商，不能盲信历史值。 */
  readonly capabilities: acp.AgentCapabilities;
};

/** prompt 已写入 ACP 连接但响应未确认时抛出；调用方禁止自动重发。 */
export class AcpAmbiguousPromptError extends Error {
  /** 明示上层不得把该错误当作可安全重试。 */
  readonly retryAutomatically = false;
}

/**
 * Engine 内的单 ACP Agent 连接。
 *
 * 本类只负责协议层的创建、session、事件与取消；它不创建 Worker 节点、不写 Journal，
 * 也绝不把 ACP stopReason 映射为 Wave Flow completed。
 */
export class AcpSessionClient {
  #transport: AcpTransport | null = null;
  #connection: acp.ClientConnection | null = null;
  #binding: AcpSessionBinding | null = null;
  #capabilities: acp.AgentCapabilities | null = null;
  #subscribers = new Set<(event: AcpSessionEvent) => void>();
  #closed: Error | null = null;
  #closingTransport: AcpTransport | null = null;
  #permissionAbort = new AbortController();
  #permissionTurn: AbortController | null = null;
  #permissionSignal: AbortSignal | null = null;

  constructor(
    private readonly launcher: AcpLauncher,
    private readonly createTransport: AcpTransportFactory = bunAcpTransport,
    private readonly permission: AcpPermissionMode | AcpPermissionResolver = "deny",
  ) {}

  /** 当前已确认 binding；尚未 new/load 时为 null。 */
  get binding(): AcpSessionBinding | null { return this.#binding; }

  /** 订阅标准化展示事件；订阅者不能影响 ACP 协议循环。 */
  subscribe(listener: (event: AcpSessionEvent) => void): () => void {
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  }

  /** 建立 transport 并完成 ACP initialize；协议或进程失败后拒绝继续使用。 */
  async initialize(signal: AbortSignal): Promise<acp.InitializeResponse> {
    if (this.#connection) {
      return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: this.#capabilities ?? {}, agentInfo: undefined };
    }
    if (this.#closed) throw this.#closed;
    const transport = await this.createTransport(this.launcher, signal);
    const app = acp.client({ name: "wave-flow" })
      .onNotification(acp.methods.client.session.update, (context) => this.onSessionUpdate(context.params))
      .onRequest(acp.methods.client.session.requestPermission, async (context) => this.resolvePermission(context.params));
    const connection = app.connect(transport.stream);
    this.#transport = transport;
    this.#connection = connection;
    connection.closed.then(() => this.fail(new Error("ACP 连接已关闭。"))).catch((error) => this.fail(new Error(`ACP 连接失败：${messageOf(error)}`)));
    transport.exited.then((code) => this.fail(new Error(`ACP Agent 进程已退出（${code}）。`))).catch((error) => this.fail(new Error(`ACP Agent 进程观察失败：${messageOf(error)}`)));
    try {
      const result = await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }, { cancellationSignal: signal });
      if (result.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error(`ACP 协议版本不匹配：${result.protocolVersion}。`);
      this.#capabilities = result.agentCapabilities ?? {};
      return result;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** 创建新 ACP session；只有成功响应后才发布 binding。 */
  async createSession(cwd: string, signal: AbortSignal, mcpServers: acp.McpServer[] = [], mcpStartupAwaitMs?: number): Promise<AcpSessionBinding> {
    const connection = this.requireConnection();
    const created = await connection.agent.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers,
      // Codex ACP 默认异步启动 stdio MCP。受管 Worker 的首轮 Prompt 不能在
      // 私有完成工具尚未可调用时发出，否则模型会诚实地 end_turn 而无法上报。
      ...(mcpServers.length > 0 && mcpStartupAwaitMs !== undefined ? { _meta: { mcpStartupAwaitTimeoutMs: mcpStartupAwaitMs } } : {}),
    }, { cancellationSignal: signal });
    if (!created.sessionId.trim()) throw new Error("ACP session/new 返回空 sessionId。 ");
    const capabilities = await this.requireCapabilities(signal);
    const binding = { launcherId: this.launcher.id, sessionId: created.sessionId, capabilities } as const;
    this.#binding = binding;
    return binding;
  }

  /** 重新附着一个已有 ACP session；只证明原生会话可 load，不等于恢复 Workflow。 */
  async loadSession(sessionId: string, cwd: string, signal: AbortSignal): Promise<AcpSessionBinding> {
    if (!sessionId.trim()) throw new Error("ACP sessionId 不能为空。 ");
    const connection = this.requireConnection();
    await connection.agent.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers: [] }, { cancellationSignal: signal });
    const capabilities = await this.requireCapabilities(signal);
    const binding = { launcherId: this.launcher.id, sessionId, capabilities } as const;
    this.#binding = binding;
    return binding;
  }

  /** 发起一个 prompt。连接在请求完成前中断时，一律抛投递不确定，禁止上层自动重发。 */
  async prompt(text: string, signal: AbortSignal, images: readonly { readonly data: string; readonly mimeType: string }[] = []): Promise<acp.PromptResponse> {
    const binding = this.requireBinding();
    if (!text.trim()) throw new Error("ACP prompt 不能为空。 ");
    if (this.#permissionTurn) throw new Error("ACP回合仍在运行，不能覆盖权限等待身份。");
    const turn = new AbortController();
    this.#permissionTurn = turn;
    this.#permissionSignal = AbortSignal.any([signal, turn.signal, this.#permissionAbort.signal]);
    try {
      const prompt: acp.ContentBlock[] = [{ type: "text", text }, ...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }))];
      return await this.requireConnection().agent.request(acp.methods.agent.session.prompt, {
        sessionId: binding.sessionId,
        prompt,
      }, { cancellationSignal: signal });
    } catch (error) {
      if (signal.aborted || this.#closed) throw new AcpAmbiguousPromptError(`ACP prompt 投递结果不确定：${messageOf(error)}`);
      throw error;
    } finally {
      turn.abort();
      if (this.#permissionTurn === turn) { this.#permissionTurn = null; this.#permissionSignal = null; }
    }
  }

  /** 请求取消当前 ACP turn；取消是否完成必须由 prompt stopReason 或后续事件确认。 */
  async cancel(signal: AbortSignal): Promise<void> {
    const binding = this.requireBinding();
    if (signal.aborted) throw new Error("ACP cancel 已取消。 ");
    this.#permissionTurn?.abort();
    await this.requireConnection().agent.notify(acp.methods.agent.session.cancel, { sessionId: binding.sessionId });
  }

  /** 关闭连接和 Agent 子进程；不会伪造任何 prompt 或 Worker 状态。 */
  close(): void {
    this.#permissionAbort.abort();
    this.#closingTransport ??= this.#transport;
    this.#transport?.close();
    this.#connection?.close();
    this.#transport = null;
    this.#connection = null;
  }

  /** 宿主Git交接前验证整个writer退出；普通/未知transport不能伪装为受管写证明。 */
  async verifyClosed(): Promise<void> {
    const transport = this.#closingTransport;
    if (!transport?.verifyClosed) throw new Error("ACP transport没有可核验的writer退出证明。");
    await transport.verifyClosed();
  }

  private async requireCapabilities(signal: AbortSignal): Promise<acp.AgentCapabilities> {
    if (signal.aborted) throw new Error("ACP capability 读取已取消。 ");
    if (!this.#capabilities) throw new Error("ACP initialize 未返回 capability。 ");
    return this.#capabilities;
  }

  private onSessionUpdate(value: acp.SessionNotification): void {
    if (!this.#binding || value.sessionId !== this.#binding.sessionId) return;
    const event = { sessionId: value.sessionId, update: value.update } as const;
    for (const listener of this.#subscribers) {
      try { listener(event); } catch { /* 展示订阅者不能中断 ACP protocol loop。 */ }
    }
  }

  /** Worker allow 模式只从 Agent 实际提供的选项中选择 allow；没有 allow 选项仍拒绝。 */
  private async resolvePermission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    if (typeof this.permission === "function") {
      const signal = this.#permissionSignal;
      if (!signal || signal.aborted || !this.#binding || request.sessionId !== this.#binding.sessionId) return { outcome: { outcome: "cancelled" } };
      const resolver = this.permission;
      const response = await waitPermission(Promise.resolve().then(() => resolver(request, signal)), signal);
      if (signal.aborted || this.#closed || this.#binding?.sessionId !== request.sessionId) return { outcome: { outcome: "cancelled" } };
      const outcome = response.outcome;
      if (outcome.outcome === "selected" && !request.options.some(option => option.optionId === outcome.optionId)) return { outcome: { outcome: "cancelled" } };
      return response;
    }
    if (this.permission === "deny") return { outcome: { outcome: "cancelled" } };
    const option = request.options.find((item) => item.kind === "allow_once")
      ?? request.options.find((item) => item.kind === "allow_always");
    return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
  }

  private requireConnection(): acp.ClientConnection {
    if (this.#closed) throw this.#closed;
    if (!this.#connection) throw new Error("ACP 尚未 initialize。 ");
    return this.#connection;
  }


  private requireBinding(): AcpSessionBinding {
    if (!this.#binding) throw new Error("ACP 尚未创建或加载 session。 ");
    return this.#binding;
  }

  private fail(error: Error): void {
    this.#permissionAbort.abort();
    if (!this.#closed) this.#closed = error;
  }
}

/** 取消即结算原权限RPC；Resolver不遵守signal时也不能拖住CLI或放行迟到批准。 */
function waitPermission(pending: Promise<acp.RequestPermissionResponse>, signal: AbortSignal): Promise<acp.RequestPermissionResponse> {
  return new Promise((resolve, reject) => {
    const cancelled = () => { signal.removeEventListener("abort", cancelled); resolve({ outcome: { outcome: "cancelled" } }); };
    if (signal.aborted) { cancelled(); return; }
    signal.addEventListener("abort", cancelled, { once: true });
    pending.then(value => { signal.removeEventListener("abort", cancelled); resolve(value); }, error => { signal.removeEventListener("abort", cancelled); reject(error); });
  });
}

/** SIGTERM 后等待进程组消失的宽限；与 Orca `PROVIDER_SIGTERM_GRACE_MS` 同值。 */
const ACP_SIGTERM_GRACE_MS = 3_000;

/** Bun 生产 stdio transport；launcher argv 只能来自 Engine 的已验证配置。 */
export const bunAcpTransport: AcpTransportFactory = async (launcher, signal) => {
  if (signal.aborted) throw new Error("ACP 启动已取消。 ");
  const child = Bun.spawn([launcher.command, ...launcher.args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // 每个 ACP adapter 是本次 Engine 可回收的独立进程组 leader。Codex 会从它
    // 派生 MCP 子进程；退出时只 kill adapter PID 会留下孤儿 Worker MCP。
    detached: true,
    // launcher.env 必须由 WorkerLauncherResolver 白名单构造，禁止将 Engine 完整
    // 环境（例如 discovery shell、认证 token）透传给用户 CLI。
    env: launcher.env ?? {},
  });
  const stderr = new Response(child.stderr).text().catch(() => "");
  const exited = child.exited.then(async (code) => {
    if (code !== 0) throw new Error(`ACP Agent stderr：${(await stderr).slice(0, 2_000)}`);
    return code;
  });
  const terminateGroup = () => {
    // POSIX 向负 PID 发信号即定向到该独立进程组。若平台或进程已经退出而拒绝，
    // 回退单进程 kill；两者都只是 best-effort，不影响 Journal 的 durable 终态。
    const groupAlive = () => { try { process.kill(-child.pid, 0); return true; } catch { return false; } };
    const signalGroup = (name: NodeJS.Signals) => {
      try { process.kill(-child.pid, name); } catch { try { process.kill(child.pid, name); } catch { /* 已退出 */ } }
    };
    try { child.stdin.end(); } catch { /* 通道可能已关闭 */ }
    signalGroup("SIGTERM");
    // 忽略 SIGTERM 的子进程组不能永久遗留：升级阶梯同 Orca provider supervisor
    // （SIGTERM → 宽限 → SIGKILL）。定时器 unref，不阻止 Engine 正常退出；
    // 与上游的差别是这里不先等 stdin 结束宽限，停止动作立刻发 SIGTERM。
    const escalate = setTimeout(() => { if (groupAlive()) signalGroup("SIGKILL"); }, ACP_SIGTERM_GRACE_MS);
    escalate.unref?.();
  };
  // Tauri/Engine 私有 stdin 意外断开时，JS finally 不一定有机会逐一关闭 session。
  // 该钩子只清理本进程创建的独立进程组，不写任何 Journal 终态；下次 Engine 启动
  // 仍会把没有 desktop.exit_requested 的活跃节点诚实收敛为 interrupted。
  const onParentExit = () => terminateGroup();
  process.once("exit", onParentExit);
  const abort = () => terminateGroup();
  signal.addEventListener("abort", abort, { once: true });
  return {
    stream: acp.ndJsonStream(new WritableStream<Uint8Array>({
      write(chunk) { child.stdin.write(chunk); },
      close() { child.stdin.end(); },
      abort() { child.stdin.end(); },
    }), child.stdout),
    exited,
    writerProcess: { pid: child.pid, exited: child.exited, terminate: terminateGroup },
    close: () => { signal.removeEventListener("abort", abort); process.removeListener("exit", onParentExit); terminateGroup(); },
  };
};

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
