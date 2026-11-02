import * as acp from "@agentclientprotocol/sdk";
import { join } from "node:path";
import { waveFlowHome } from "../journal/paths";
import { encodeWorkerSupervisorSpec, type WorkerSupervisorSpec } from "../runtimes/worker-supervisor";
import { captureWriterStartedAt } from "../workspace/writer-process-control";
import { removeLaunchFiles, reportPathFor } from "../runtimes/supervisor-report";
import { acpLifecycleLogPath, logAcpLifecycle } from "./acp-lifecycle-log";

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

/** ACP Agent 请求权限时的客户端决策；Lead 与 Worker 不能共用默认值。 */
export type AcpPermissionMode = "deny" | "allow";
/** Adapter无关的权限决策；未来桌面协调器可耐久等待用户，测试/兼容模式仍用deny/allow。 */
export type AcpPermissionResolver = (
  /** 原CLI的结构化请求，不从文本重建路径或操作。 */ request: acp.RequestPermissionRequest,
  /** 连接/回合取消时中止等待；迟到决定不得返回allow。 */ signal: AbortSignal,
) => Promise<acp.RequestPermissionResponse> | acp.RequestPermissionResponse;

/** Worker 私有表单请求处理；Lead 不注册此能力。 */
export type AcpElicitationResolver = (
  /** 原 ACP 表单请求；调用方负责绑定既有 block。 */ request: acp.CreateElicitationRequest,
  /** 表单关闭或连接取消信号；不得据此伪造答案。 */ signal: AbortSignal,
) => Promise<acp.CreateElicitationResponse>;

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

/**
 * 会话级客户端系统提示（ACP client-system-prompt，当前为未稳定能力）。
 *
 * 只允许 `append` 与纯文本：宿主仅发送自己编写的静态说明，禁止把任务正文、
 * Workflow 源码、模型输出或任何用户内容拼进来——系统层的指令权重更高，
 * 混入不可信文本会扩大提示注入面。
 */
export type AcpClientSystemPrompt = {
  /** 投递模式；本期只支持在 Agent 自身指令之后追加。 */
  readonly mode: "append";
  /** 纯文本内容；空白或超过上限时拒绝发送。 */
  readonly text: string;
};

/** 客户端系统提示的体积上限；超过即拒绝，不做截断。 */
const MAX_CLIENT_SYSTEM_PROMPT_BYTES = 16 * 1024;

/**
 * ACP session/new 的附加参数；只由已验证的宿主能力产生，不是 Workflow 作者输入。
 * 未使用的能力必须保持省略，不能发送空数组/空对象改变既有协议行为。
 */
export type AcpSessionOptions = {
  /** 扩展会话文件系统范围的绝对目录；Codex 用它追加 skill 额外根。 */
  readonly additionalDirectories?: readonly string[];
  /** ACP `_meta` 透传对象；必须由宿主构造，禁止透传模型或用户自由文本。 */
  readonly meta?: Readonly<Record<string, unknown>>;
  /**
   * 会话级系统提示；只有 Agent 在 initialize 声明 `sessionCapabilities.systemPrompt`
   * 时才允许发送，否则直接拒绝，不能静默降级为用户消息。
   */
  readonly systemPrompt?: AcpClientSystemPrompt;
};

/** 允许替换 transport，确保协议测试不依赖真实模型或本地登录。 */
export type AcpTransportFactory = (launcher: AcpLauncher, signal: AbortSignal) => Promise<AcpTransport>;

/**
 * 本 ACP 客户端要广告的会话能力。
 *
 * 每项都对应协议里"广告即承诺完整消费"的契约：没有消费者的能力不得广告。
 */
export type AcpClientSessionCapabilities = {
  /**
   * 是否广告压缩契约。开启后 Agent 才会发 compaction_update / compaction_summary_chunk；
   * 未开启时适配器把压缩降级成一条 tool_call 呈现。
   */
  readonly compaction?: boolean;
};

/** 一条已归一化的 ACP 展示事件；它不是 Worker 业务状态。 */
export type AcpSessionEvent = {
  /** 事件所属 ACP session。 */
  readonly sessionId: string;
  /** ACP 标准 session update 的原始结构化内容。 */
  readonly update: acp.SessionUpdate;
};

/**
 * 判断一条 ACP session update 是否代表模型侧的真实进展。
 * 只有正文、工具调用/更新与计划更新算进展；thought 空分片、available_commands、
 * current_mode 等心跳/元信息事件不得刷新 Worker 停滞提示计时——否则“进程活着、
 * 模型流静默”时空心跳会续命，“无实质进展”提示永远不出现。
 */
export function acpProgressIsMeaningful(update: acp.SessionUpdate): boolean {
  // `plan_update` / `plan_removed` 属于 ACP 未稳定事件，不在稳定 SessionUpdate 联合类型里；
  // 这里只读判别字段，按名字比较，避免为了计数进展而依赖未稳定类型。
  const name: string = update.sessionUpdate;
  return name === "agent_message_chunk"
    || name === "tool_call"
    || name === "tool_call_update"
    || name === "plan"
    || name === "plan_update"
    || name === "plan_removed";
}

/** Wave Flow 需要持久化的 ACP 会话绑定；能力快照仅用于 Policy，不是授权凭证。 */
export type AcpSessionBinding = {
  /** 配置中选择的 launcher id。 */
  readonly launcherId: string;
  /** ACP Agent 返回的原生会话 id。 */
  readonly sessionId: string;
  /** initialize 返回的能力快照；恢复前必须重新协商，不能盲信历史值。 */
  readonly capabilities: acp.AgentCapabilities;
  /**
   * provider 进程组与启动时间指纹；用于恢复前判断旧写者是否已死。
   * 采集失败时缺省；恢复端必须按“无证据”处理，不得续用。
   */
  readonly writer?: { readonly pgid: number; readonly startedAt: string };
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
  #elicitationResolver: AcpElicitationResolver | null = null;
  /** load 重放抑制：从 load 请求发出到首个新 prompt 之前，session/update 一律丢弃。 */
  #suppressReplay = false;

  constructor(
    private readonly launcher: AcpLauncher,
    private readonly createTransport: AcpTransportFactory = bunAcpTransport,
    private readonly permission: AcpPermissionMode | AcpPermissionResolver = "deny",
    /**
     * 本客户端要广告的会话能力。默认不广告任何能力。
     *
     * ACP 规定"广告压缩契约"等于承诺完整处理 compaction_update/compaction_summary_chunk
     * 的生命周期、placement、patch 与 replay 语义。因此只有真正消费压缩事实的会话才能广告；
     * 不消费却广告既违反契约，也会让适配器把压缩从一条 tool_call 改成结构化事件，
     * 静默改变该会话的对话投影。
     */
    private readonly sessionCapabilities: AcpClientSessionCapabilities = {},
  ) {}

  /** 仅 Worker 在 initialize 前注册表单处理；Lead 与无 handler 会话不广告该能力。 */
  setElicitationResolver(resolver: AcpElicitationResolver): void {
    if (this.#connection) throw new Error("ACP initialize 后不能改变 elicitation 能力。 ");
    this.#elicitationResolver = resolver;
  }

  /** 当前已确认 binding；尚未 new/load 时为 null。 */
  get binding(): AcpSessionBinding | null { return this.#binding; }

  /**
   * Agent 是否声明支持客户端系统提示。
   *
   * 能力来自 initialize 响应的 `agentCapabilities.sessionCapabilities.systemPrompt`；
   * 该字段当前属于 ACP 未稳定能力，因此按结构化读取，不依赖 SDK 的稳定类型。
   * 未声明时宿主 MUST NOT 发送 systemPrompt。
   */
  supportsClientSystemPrompt(): boolean {
    const capabilities = this.#capabilities as { readonly sessionCapabilities?: Readonly<Record<string, unknown>> } | null;
    return capabilities?.sessionCapabilities?.systemPrompt != null;
  }

  /**
   * 把宿主系统提示转成线上字段；未声明能力、内容为空或超限一律拒绝。
   *
   * 不能静默丢弃：协议说明若发不出去，就只剩会被上下文压缩折叠的用户消息，
   * 等于回到原来的缺陷，因此这里按契约失败而不是降级。
   */
  #clientSystemPrompt(prompt: AcpClientSystemPrompt | undefined): { readonly mode: "append"; readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }> } | undefined {
    if (!prompt) return undefined;
    if (prompt.mode !== "append") throw new Error("ACP 客户端系统提示本期只支持 append 模式。 ");
    const text = prompt.text.trim();
    if (!text) throw new Error("ACP 客户端系统提示不能为空。 ");
    if (Buffer.byteLength(text, "utf8") > MAX_CLIENT_SYSTEM_PROMPT_BYTES) throw new Error("ACP 客户端系统提示超过 16KiB，拒绝发送。 ");
    if (!this.supportsClientSystemPrompt()) throw new Error("该 CLI 未声明 ACP sessionCapabilities.systemPrompt，拒绝发送客户端系统提示。 ");
    return { mode: "append", content: [{ type: "text", text }] };
  }

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
      .onRequest(acp.methods.client.session.requestPermission, async (context) => this.resolvePermission(context.params))
      .onRequest(acp.methods.client.elicitation.create, async (context) => {
        if (!this.#elicitationResolver) return { action: "decline" as const };
        return this.#elicitationResolver(context.params, context.signal);
      });
    const connection = app.connect(transport.stream);
    this.#transport = transport;
    this.#connection = connection;
    connection.closed.then(() => this.fail(new Error("ACP 连接已关闭。"))).catch((error) => this.fail(new Error(`ACP 连接失败：${messageOf(error)}`)));
    transport.exited.then((code) => this.fail(new Error(`ACP Agent 进程已退出（${code}）。`))).catch((error) => this.fail(new Error(`ACP Agent 进程观察失败：${messageOf(error)}`)));
    try {
      const result = await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          // 只有真实处理 Worker 表单的会话才广告 Elicitation；Lead 不获得该能力。
          ...(this.#elicitationResolver ? { elicitation: { form: {} } } : {}),
          // 只有真正消费压缩事实的会话才广告压缩契约（见 AcpClientSessionCapabilities）。
          ...(this.sessionCapabilities.compaction === true ? { session: { compaction: {} } } : {}),
        },
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
  async createSession(cwd: string, signal: AbortSignal, mcpServers: acp.McpServer[] = [], mcpStartupAwaitMs?: number, options: AcpSessionOptions = {}): Promise<AcpSessionBinding> {
    const connection = this.requireConnection();
    // 宿主能力（技能注入）与会话启动参数合并，不能互相覆盖对方的 _meta。
    const meta: Record<string, unknown> = { ...(options.meta ?? {}) };
    // Codex ACP 默认异步启动 stdio MCP。受管 Worker 的首轮 Prompt 不能在
    // 私有完成工具尚未可调用时发出，否则模型会诚实地 end_turn 而无法上报。
    if (mcpServers.length > 0 && mcpStartupAwaitMs !== undefined) meta.mcpStartupAwaitTimeoutMs = mcpStartupAwaitMs;
    const systemPrompt = this.#clientSystemPrompt(options.systemPrompt);
    const params = {
      cwd,
      mcpServers,
      ...(options.additionalDirectories && options.additionalDirectories.length > 0 ? { additionalDirectories: [...options.additionalDirectories] } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    };
    const created = await connection.agent.request(acp.methods.agent.session.new, params, { cancellationSignal: signal });
    if (!created.sessionId.trim()) throw new Error("ACP session/new 返回空 sessionId。 ");
    const capabilities = await this.requireCapabilities(signal);
    const writer = await this.captureWriterEvidence();
    const binding = { launcherId: this.launcher.id, sessionId: created.sessionId, capabilities, ...(writer ? { writer } : {}) } as const;
    this.#binding = binding;
    return binding;
  }

  /** 重新附着一个已有 ACP session；只证明原生会话可 load，不等于恢复 Workflow。 */
  async loadSession(
    sessionId: string,
    cwd: string,
    signal: AbortSignal,
    mcpServers: acp.McpServer[] = [],
    mcpStartupAwaitMs?: number,
    options: AcpSessionOptions = {},
  ): Promise<AcpSessionBinding> {
    if (!sessionId.trim()) throw new Error("ACP sessionId 不能为空。 ");
    const connection = this.requireConnection();
    const meta: Record<string, unknown> = { ...(options.meta ?? {}) };
    if (mcpServers.length > 0 && mcpStartupAwaitMs !== undefined) meta.mcpStartupAwaitTimeoutMs = mcpStartupAwaitMs;
    // 协议要求客户端在 load 时重发同一份系统提示；省略会让 Agent 回到自己的默认指令。
    const systemPrompt = this.#clientSystemPrompt(options.systemPrompt);
    // load 会把整段历史当作 session/update 重放；从请求发出到首个新 prompt 之前全部丢弃，
    // 不能依赖 binding 发布时序——adapter 可能在响应之后继续补发重放事件。
    this.#suppressReplay = true;
    try {
      await connection.agent.request(acp.methods.agent.session.load, {
        sessionId,
        cwd,
        mcpServers,
        ...(options.additionalDirectories && options.additionalDirectories.length > 0 ? { additionalDirectories: [...options.additionalDirectories] } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
      }, { cancellationSignal: signal });
    } catch (error) {
      this.#suppressReplay = false;
      throw error;
    }
    const capabilities = await this.requireCapabilities(signal);
    const writer = await this.captureWriterEvidence();
    const binding = { launcherId: this.launcher.id, sessionId, capabilities, ...(writer ? { writer } : {}) } as const;
    this.#binding = binding;
    return binding;
  }

  /** 发起一个 prompt。连接在请求完成前中断时，一律抛投递不确定，禁止上层自动重发。 */
  async prompt(text: string, signal: AbortSignal, images: readonly { readonly data: string; readonly mimeType: string }[] = []): Promise<acp.PromptResponse> {
    const binding = this.requireBinding();
    if (!text.trim()) throw new Error("ACP prompt 不能为空。 ");
    if (this.#permissionTurn) throw new Error("ACP回合仍在运行，不能覆盖权限等待身份。");
    // 首个新 prompt 之后的重放窗口结束：之后到的 update 属于真实回合。
    this.#suppressReplay = false;
    const turn = new AbortController();
    this.#permissionTurn = turn;
    this.#permissionSignal = AbortSignal.any([signal, turn.signal, this.#permissionAbort.signal]);
    logAcpLifecycle({ event: "prompt_start", launcher: this.launcher.id, sessionId: binding.sessionId });
    try {
      const prompt: acp.ContentBlock[] = [{ type: "text", text }, ...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }))];
      const response = await this.requireConnection().agent.request(acp.methods.agent.session.prompt, {
        sessionId: binding.sessionId,
        prompt,
      }, { cancellationSignal: signal });
      logAcpLifecycle({ event: "prompt_end", launcher: this.launcher.id, sessionId: binding.sessionId });
      return response;
    } catch (error) {
      logAcpLifecycle({ event: "prompt_end", launcher: this.launcher.id, sessionId: binding.sessionId, diagnostic: messageOf(error) });
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

  /** 采集 provider 进程组与启动指纹；失败或缺省时按无证据处理，不阻塞会话建立。 */
  private async captureWriterEvidence(): Promise<{ pgid: number; startedAt: string } | null> {
    const pid = this.#transport?.writerProcess?.pid;
    if (!pid || !Number.isInteger(pid) || pid <= 1) return null;
    const reported = this.#transport?.writerProcess?.startedAt;
    try { return { pgid: pid, startedAt: reported ?? await captureWriterStartedAt(pid) }; }
    catch { return null; }
  }

  private async requireCapabilities(signal: AbortSignal): Promise<acp.AgentCapabilities> {
    if (signal.aborted) throw new Error("ACP capability 读取已取消。 ");
    if (!this.#capabilities) throw new Error("ACP initialize 未返回 capability。 ");
    return this.#capabilities;
  }

  private onSessionUpdate(value: acp.SessionNotification): void {
    if (!this.#binding || value.sessionId !== this.#binding.sessionId) return;
    if (this.#suppressReplay) return;
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
    if (this.#closed) return;
    this.#closed = error;
    // ACP transport/子进程退出后必须主动关闭协议连接；只记录 #closed 不会拒绝
    // 已经发出的 prompt 请求，会让 Lead 回合永久停在“等待新的输出”。
    logAcpLifecycle({ event: "fail", launcher: this.launcher.id, diagnostic: error.message });
    try { this.#connection?.close(error); } catch { /* 连接可能已关闭 */ }
    try { this.#transport?.close(); } catch { /* 进程可能已退出 */ }
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
  logAcpLifecycle({ event: "spawn", launcher: launcher.id, pid: child.pid });
  // stderr 必须在后台增量读取，不能阻塞 transport.exited：adapter 的子进程可能继承
  // stderr，进程退出后管道未必立即 EOF；等待它会把“退出检测”重新变成永久挂起。
  const stderrReader = child.stderr.getReader();
  const stderrDecoder = new TextDecoder();
  let stderrTail = "";
  const stderrDone = (async () => {
    try {
      for (;;) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        if (value) stderrTail = (stderrTail + stderrDecoder.decode(value, { stream: true })).slice(-8_000);
      }
      stderrTail = (stderrTail + stderrDecoder.decode()).slice(-8_000);
    } catch { /* stderr 读取失败不能影响退出判定。 */ }
  })();
  const exited = child.exited.then(async (code) => {
    logAcpLifecycle({ event: "exit", launcher: launcher.id, pid: child.pid, code, signal: child.signalCode, stderr: stderrTail });
    if (code !== 0) {
      // 仅异常退出时给 stderr 一个很短的有界汇合窗口；正常退出立即 resolve。
      await Promise.race([stderrDone, Bun.sleep(250)]);
      throw new Error(`ACP Agent 进程异常退出（code=${code}），诊断日志：${acpLifecycleLogPath()}`);
    }
    return code;
  });
  const terminateGroup = () => {
    logAcpLifecycle({ event: "terminate", launcher: launcher.id, pid: child.pid });
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

/**
 * 受 supervisor 托管的 ACP transport。
 *
 * 与 `bunAcpTransport` 的区别只有一个：直接子进程是 supervisor，provider 是它的子进程。
 * Engine 拿到的是 provider 的真实进程组（报告文件），`terminate` 改为请 supervisor 走
 * 自己的收尾阶梯；provider 的真实退出码由 supervisor 透传，异常退出判定与原来一致。
 */
export const supervisedAcpTransport: AcpTransportFactory = async (launcher, signal) => {
  if (signal.aborted) throw new Error("ACP 启动已取消。 ");
  const launchKey = launcher.env?.WF_WORKER_LAUNCH_KEY;
  const reportDir = process.env.WF_SUPERVISOR_REPORT_DIR?.trim() || join(waveFlowHome(), "runtime");
  // Worker 会话用身份派生的稳定路径，恢复端可据此找到 provider 报告；
  // 主控等无 launch key 的会话仍用一次性路径。
  const reportPath = launchKey ? reportPathFor(launchKey, reportDir) : join(reportDir, `worker-supervisor-${crypto.randomUUID()}.pid`);
  // 同一 launch key 的上一代报告会留在同一路径上；本次 spawn 用一次性 spawnId 认领自己的报告，
  // 否则启动超时后的自动重试会立刻读到上一代 pgid 并把它当成新 provider。
  const spawnId = crypto.randomUUID();
  const spec: WorkerSupervisorSpec = {
    command: launcher.command,
    args: [...launcher.args],
    cwd: process.cwd(),
    env: { ...(launcher.env ?? {}) },
    ownerPid: process.pid,
    reportPath,
    spawnId,
  };
  const compiled = import.meta.dir.startsWith("/$bunfs/");
  const supervisorArgs = compiled ? ["__worker-supervisor"] : [join(import.meta.dir, "../desktop/engine-main.ts"), "__worker-supervisor"];
  const supervisor = Bun.spawn([process.execPath, ...supervisorArgs], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // supervisor 必须自成进程组：Engine 被整组杀掉时它要活下来完成收尾。
    detached: true,
    env: { ...(launcher.env ?? {}), WF_WORKER_SUPERVISOR_SPEC: encodeWorkerSupervisorSpec(spec) },
  });

  let reported: { pgid: number; startedAt?: string };
  try {
    reported = await awaitReportedPgid(reportPath, supervisor, signal, spawnId);
  } catch (error) {
    try { process.kill(supervisor.pid, "SIGKILL"); } catch { /* 已退出 */ }
    throw error;
  }
  const pgid = reported.pgid;
  logAcpLifecycle({ event: "spawn", launcher: launcher.id, pid: pgid });

  const stderrReader = supervisor.stderr.getReader();
  const stderrDecoder = new TextDecoder();
  let stderrTail = "";
  const stderrDone = (async () => {
    try {
      for (;;) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        if (value) stderrTail = (stderrTail + stderrDecoder.decode(value, { stream: true })).slice(-8_000);
      }
      stderrTail = (stderrTail + stderrDecoder.decode()).slice(-8_000);
    } catch { /* stderr 读取失败不能影响退出判定。 */ }
  })();
  const exited = supervisor.exited.then(async (code) => {
    logAcpLifecycle({ event: "exit", launcher: launcher.id, pid: pgid, code, signal: supervisor.signalCode, stderr: stderrTail });
    if (code !== 0) {
      await Promise.race([stderrDone, Bun.sleep(250)]);
      throw new Error(`ACP Agent 进程异常退出（code=${code}），诊断日志：${acpLifecycleLogPath()}`);
    }
    return code;
  });

  /** 请 supervisor 收尾；宽限后仍未退出时再直接杀 provider 组与 supervisor。 */
  let terminated = false;
  const terminate = () => {
    // 多次 close/abort 只允许一条终止链，避免叠加多个 escalate 定时器。
    if (terminated) return;
    terminated = true;
    logAcpLifecycle({ event: "terminate", launcher: launcher.id, pid: pgid });
    try { process.kill(supervisor.pid, "SIGTERM"); } catch { /* 已退出 */ }
    const escalate = setTimeout(() => {
      // pgid 可能在窗口内被复用；先确认组仍存在再发 SIGKILL，降低误杀无关进程组的概率。
      if (processGroupExists(pgid)) {
        try { process.kill(-pgid, "SIGKILL"); } catch { /* 已退出 */ }
      }
      try { process.kill(supervisor.pid, "SIGKILL"); } catch { /* 已退出 */ }
    }, ACP_SIGTERM_GRACE_MS + 500);
    escalate.unref?.();
    // supervisor 正常退出后立即撤销升级定时器，不能让它在几秒后凭旧 pgid 开枪。
    void supervisor.exited.then(() => clearTimeout(escalate), () => clearTimeout(escalate));
  };
  const onParentExit = () => terminate();
  process.once("exit", onParentExit);
  const abort = () => terminate();
  signal.addEventListener("abort", abort, { once: true });

  return {
    stream: acp.ndJsonStream(new WritableStream<Uint8Array>({
      write(chunk) { supervisor.stdin.write(chunk); },
      close() { supervisor.stdin.end(); },
      abort() { supervisor.stdin.end(); },
    }), supervisor.stdout),
    exited,
    writerProcess: { pid: pgid, exited: supervisor.exited, terminate, ...(reported.startedAt ? { startedAt: reported.startedAt } : {}) },
    close: () => {
      signal.removeEventListener("abort", abort); process.removeListener("exit", onParentExit); terminate();
      // 无 launch key 的会话（主控）不参与写者恢复，关闭时直接回收报告文件。
      if (!launchKey) void removeLaunchFiles(reportPath);
    },
  };
};

/** 等待 supervisor 报告 provider 进程组；先退出或超时都拒绝启动。 */
async function awaitReportedPgid(path: string, supervisor: Bun.Subprocess, signal: AbortSignal, spawnId: string): Promise<{ pgid: number; startedAt?: string }> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const lines = (await Bun.file(path).text()).trim().split("\n");
      const value = Number(lines[0]?.trim());
      // 只认本次 spawn 写出的报告：同一 launch key 的上一代报告会留在同一路径上，
      // 不校验 spawnId 就会在自动重试时立刻读到上一代的死 pgid。
      if (Number.isInteger(value) && value > 1 && lines[2]?.trim() === spawnId) {
        const startedAt = lines[1]?.trim();
        // 报告文件保留：Engine 可能在记录写者证据前崩溃，恢复端仍需按同一路径围栏。
        return { pgid: value, ...(startedAt ? { startedAt } : {}) };
      }
    } catch { /* 还没写出来 */ }
    if (supervisor.exitCode !== null) throw new Error(`Worker supervisor 在报告 provider 前退出（code=${supervisor.exitCode}）。`);
    if (signal.aborted) throw new Error("ACP 启动已取消。 ");
    if (Date.now() >= deadline) throw new Error("Worker supervisor 未在预算内报告 provider 进程组。");
    await Bun.sleep(25);
  }
}

/** 进程组是否仍存在；只用于升级终止前的保守判断，不作为退出证明。 */
function processGroupExists(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
