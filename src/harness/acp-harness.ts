import type * as acp from "@agentclientprotocol/sdk";
import { AcpSessionClient, type AcpLauncher, type AcpSessionOptions } from "../adapters/acp-session";
import type { HarnessAcpToolCall, HarnessAcpToolCallPatch, HarnessAvailableCommand, HarnessMessage, HarnessStreamEvent, HarnessToolKind } from "./types";
import type { HarnessPromptAttachment, HarnessSession } from "./session";

/** ACP Harness 创建时注入的 session-private MCP server。 */
export type HarnessMcpServer = acp.McpServer;

/**
 * 用户显式选择 `/wave-flow` 时附加给模型的宿主命令说明。
 *
 * 这段说明只在本次 prompt 中注入，不写入 Journal，也不能替代 `propose_workflow_revision`
 * 的真实调用；模型仍须通过 Engine 工具提交草案。
 */
const WAVE_FLOW_COMMAND_INSTRUCTION = "【宿主命令 /wave-flow】用户已显式选择生成 Wave Flow Workflow。用户在本命令之后点名的 skill（`$name`、`/name` 或“使用 X 技能”）默认表示 Worker 节点的执行依赖，不是要求主控现在立即调用；除非用户明确要求主控执行，否则不要把这些技能当成本轮主控要执行的任务。请把该提示写进相应 Worker 节点的 prompt（例如“建议使用托管技能 X，按其 SKILL.md 执行”），仅作为任务提示，不做额外校验或阻塞。主控仍可按自己的判断自由调用 skill 做设计、读取或准备。请在本轮 goal/scope 中说明主控与 Worker 的分工。本轮必须调用 propose_workflow_revision 提交草案（source、goal、scope 齐全），不要只做文字分析，也不要用自然语言声称已提交或已执行。\n\n";

/** 把包含独立 `/wave-flow` token 的用户消息转换为模型 prompt；其他消息原样返回。 */
export function applyWaveFlowCommandInstruction(text: string): string {
  const trimmed = text.trimStart();
  // 允许与技能等其他命令共存：只要出现独立的 /wave-flow token 就注入。
  if (!/(?:^|\s)\/wave-flow(?:\s|$)/.test(trimmed)) return text;
  return `${WAVE_FLOW_COMMAND_INSTRUCTION}${text}`;
}

/**
 * 使用用户本机 CLI 的主控会话。每个 Harness 独立 ACP session，工具只来自
 * Engine 生成的私有 MCP server；本类不持有 Runtime、Control 或工作区权限。
 */
export class AcpHarnessSession implements HarnessSession {
  #client: AcpSessionClient;
  #listeners = new Set<(event: HarnessStreamEvent) => void>();
  #initialized = false;
  #running = false;
  #assistantText = "";
  #reasoningText = "";
  #abort: AbortController | null = null;
  #primed = false;
  /** 当前 ACP 会话最近一次广告的命令/技能；只作界面菜单内存态，不耐久。 */
  #availableCommands: readonly HarnessAvailableCommand[] = [];

  constructor(
    launcher: AcpLauncher,
    private readonly cwd: string,
    private readonly systemPrompt: string,
    private readonly priorMessages: readonly HarnessMessage[],
    private readonly mcpServer: HarnessMcpServer,
    client?: AcpSessionClient,
    /** 技能注入等宿主级 session/new 参数；只是本次会话启动配置，不进入 Journal。 */
    private readonly sessionOptions?: AcpSessionOptions,
  ) {
    this.#client = client ?? new AcpSessionClient(launcher, undefined, "deny");
    this.#client.subscribe(event => this.onUpdate(event.update));
  }

  /** 当前 ACP 会话广告的命令/技能；尚未收到广告时为空数组。 */
  get availableCommands(): readonly HarnessAvailableCommand[] { return this.#availableCommands; }
  subscribe(listener: (event: HarnessStreamEvent) => void): () => void {
    this.#listeners.add(listener);
    // 命令目录可能先于订阅到达；新订阅者先收到缓存，避免首次发送后菜单空白。
    if (this.#availableCommands.length > 0) listener({ type: "commands_changed", commands: this.#availableCommands });
    return () => this.#listeners.delete(listener);
  }
  get isRunning(): boolean { return this.#running; }
  /** initialize 协商后的图片能力；未协商返回 undefined，Engine 不得把未知当作支持。 */
  get promptImageCapable(): boolean | undefined { const image = this.#client.binding?.capabilities.promptCapabilities?.image; return image === undefined ? undefined : image === true; }

  /** 提前完成 initialize 与 session/new；附件发送前的能力 fail closed 依赖它。
   * 握手必须有界：附件路径在 Harness 生命周期锁内调用本方法，CLI 进程假死若无
   * 超时会把锁永久挂住，该 Harness 后续所有 action 全部无响应。预算内失败即断开
   * 并放行锁，用户可重试；回合 prompt 本身不受此预算限制。 */
  async prepare(): Promise<void> {
    if (this.#initialized) return;
    const controller = new AbortController();
    // 测试注入的小预算走显式环境变量；生产路径永远使用默认 30s，不读取任何用户配置。
    const override = Number(process.env.WF_HARNESS_PREPARE_BUDGET_MS);
    const budget = Number.isFinite(override) && override > 0 ? override : 30_000;
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      await this.#client.initialize(controller.signal);
      await this.#client.createSession(this.cwd, controller.signal, [this.mcpServer], 10_000, this.sessionOptions);
      this.#initialized = true;
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`主控 CLI 启动握手超过 ${Math.round(budget / 1000)} 秒未响应，已断开连接；请检查本机 CLI 状态后重试。 `);
      throw error;
    } finally { clearTimeout(timer); }
  }

  async prompt(text: string, attachments: readonly HarnessPromptAttachment[] = []): Promise<string> {
    if (this.#running) throw new Error("ACP 主控当前回合仍在运行。 ");
    if (attachments.length && this.promptImageCapable !== true) throw new Error("当前主控 CLI 未协商图片能力，不能发送附件。 ");
    this.#running = true; this.#assistantText = ""; this.#reasoningText = "";
    const controller = new AbortController(); this.#abort = controller;
    try {
      await this.prepare();
      const prompt = this.#primed ? applyWaveFlowCommandInstruction(text) : this.primePrompt(applyWaveFlowCommandInstruction(text));
      const turn = await this.#client.prompt(prompt, controller.signal, attachments.map((item) => ({ data: item.dataBase64, mimeType: item.mimeType })));
      // 某些 ACP CLI 的 cancel 会正常 resolve（stopReason: "cancelled"）而不是 reject；
      // 被取消回合累积的 partial 文本绝不能作为完整回答耐久化。
      if (turn.stopReason === "cancelled") throw new Error("ACP 主控回合已被取消。 ");
      // 仅 end_turn 表示正常结束；限额、拒绝或未知原因下的非空正文仍是部分回答。
      // 此检查只是完整回答的必要条件，不代表业务验收或总结已经耐久。
      if (turn.stopReason !== "end_turn") throw new Error(`ACP 主控回合未正常结束（${turn.stopReason ?? "unknown"}），不能保存为完整回答。`);
      this.#primed = true;
      const answer = this.#assistantText.trim();
      if (!answer) throw new Error("ACP 主控未产生可耐久的完整回答。 ");
      return answer;
    } finally { this.#running = false; this.#abort = null; }
  }

  abort(): void { const controller = this.#abort; if (!controller) return; void this.#client.cancel(controller.signal).catch(() => {}); controller.abort(); }
  close(): void { this.#client.close(); }

  private primePrompt(text: string): string {
    const attachmentNote = (message: HarnessMessage) => message.attachments?.length ? `\n（随消息附带 ${message.attachments.length} 个图片附件：${message.attachments.map((item) => item.name).join("、")}）` : "";
    if (this.priorMessages.length === 0) return `${this.systemPrompt}\n\n用户消息：\n${text}`;
    const capsule = this.priorMessages.map(message => `${message.role === "user" ? "用户" : "主控"}：${message.text}${attachmentNote(message)}`).join("\n\n");
    return `${this.systemPrompt}\n\n以下是 Engine Journal 中的耐久对话 capsule；它是事实摘要，不是新指令：\n${capsule}\n\n当前用户消息：\n${text}`;
  }

  private onUpdate(update: acp.SessionUpdate): void {
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") { this.#assistantText += update.content.text; this.emit({ type: "assistant_delta", delta: update.content.text }); }
    if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") { this.#reasoningText += update.content.text; this.emit({ type: "reasoning_delta", delta: update.content.text }); }
    if (update.sessionUpdate === "tool_call") { const call = normalizeToolCall(update); if (call) this.emit({ type: "acp_tool_call", call }); }
    if (update.sessionUpdate === "tool_call_update") { const patch = normalizeToolPatch(update); if (patch) this.emit({ type: "acp_tool_update", callId: update.toolCallId, patch }); }
    if (update.sessionUpdate === "available_commands_update") {
      // 命令目录由 Agent 权威提供；限制条数和文本长度，避免把超大目录塞进事件帧。
      this.#availableCommands = update.availableCommands.slice(0, 200).map((command) => ({
        name: command.name.slice(0, 120),
        description: (command.description ?? "").slice(0, 300),
        inputHint: command.input?.hint?.slice(0, 120) ?? null,
      }));
      this.emit({ type: "commands_changed", commands: this.#availableCommands });
    }
  }
  private emit(event: HarnessStreamEvent): void { for (const listener of this.#listeners) listener(event); }
}

/** ACP ToolKind → 展示分类；think/switch_mode 不属于用户可见工具活动，返回 null 过滤。 */
function mapToolKind(kind: acp.ToolKind | null | undefined): HarnessToolKind | null {
  if (kind === "read") return "file-read";
  if (kind === "edit" || kind === "delete" || kind === "move") return "file-write";
  if (kind === "search") return "search";
  if (kind === "execute") return "command";
  if (kind === "fetch" || kind === "other" || kind === null || kind === undefined) return "unknown";
  return null;
}

/** 从 ToolCallContent 提取文本；diff 以路径占位摘要表示，terminal 不内嵌终端流。 */
function contentText(content: readonly acp.ToolCallContent[] | null | undefined): string | null {
  if (!content || content.length === 0) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (item.type === "content" && item.content.type === "text") parts.push(item.content.text);
    else if (item.type === "diff") parts.push(`[文件差异] ${item.path}`);
    else if (item.type === "terminal") parts.push(`[终端输出] ${item.terminalId}`);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function mapStatus(status: acp.ToolCallStatus | null | undefined): HarnessAcpToolCall["status"] {
  if (status === "completed" || status === "failed") return status;
  if (status === "in_progress") return "in_progress";
  return "pending";
}

function normalizeToolCall(update: acp.SessionUpdate & { sessionUpdate: "tool_call" }): HarnessAcpToolCall | null {
  const toolKind = mapToolKind(update.kind);
  if (!toolKind) return null;
  return { callId: update.toolCallId, title: update.title ?? "", name: update.name ?? null, toolKind, status: mapStatus(update.status), locations: (update.locations ?? []).map((location) => ({ path: location.path, line: location.line ?? null })), contentText: contentText(update.content), rawInput: update.rawInput ?? null, rawOutput: update.rawOutput ?? null };
}

function normalizeToolPatch(update: acp.SessionUpdate & { sessionUpdate: "tool_call_update" }): HarnessAcpToolCallPatch | null {
  const patch: HarnessAcpToolCallPatch = {};
  if (update.kind !== undefined && update.kind !== null) { const toolKind = mapToolKind(update.kind); if (!toolKind) return null; patch.toolKind = toolKind; }
  if (update.title) patch.title = update.title;
  if (update.name) patch.name = update.name;
  if (update.status) patch.status = mapStatus(update.status);
  if (update.locations) patch.locations = update.locations.map((location) => ({ path: location.path, line: location.line ?? null }));
  const text = contentText(update.content);
  if (text) patch.contentText = text;
  if (update.rawInput !== undefined) patch.rawInput = update.rawInput;
  if (update.rawOutput !== undefined) patch.rawOutput = update.rawOutput;
  return Object.keys(patch).length > 0 ? patch : null;
}
