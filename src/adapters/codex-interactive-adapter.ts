import type { SessionBackend, SessionIdentity } from "../sessions/types";
import type { AgentSandbox } from "../shared/workflow-types";
import type { InteractiveCliAdapter, InteractiveCliLaunchPlan, InteractiveCliStartRequest, PromptReadyEvidence, PromptSubmissionEvidence } from "./interactive-cli-adapter";
import type { AdapterCapabilities } from "./capabilities";
import type { RegisteredInteractiveAdapter } from "./adapter-registry";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Codex 启动请求是通用交互式 Adapter 请求的别名，保留为公开导入兼容名。 */
export type CodexInteractiveStartRequest = InteractiveCliStartRequest;

/** Codex Adapter 内部时序配置；生产使用 Botmux 已验证的 200ms settle 与 800ms history 窗口。 */
export type CodexInteractiveAdapterOptions = {
  /** 正常交互 Codex 可执行文件；默认从 PATH 查找 codex。 */
  readonly command?: string;
  /** Codex 原生提交历史路径；默认当前 CODEX_HOME 或用户 .codex 下的 history.jsonl。 */
  readonly historyPath?: string;
  /** history 轮询间隔毫秒数；默认 100。 */
  readonly historyPollMs?: number;
  /** bracketed paste 后发送 Enter 前的等待毫秒数；默认 200。 */
  readonly pasteSettleMs?: number;
  /** 每次 Enter 后等待 history 记录的窗口毫秒数；默认 800。 */
  readonly confirmationAttemptMs?: number;
};

/** Codex 首条 Prompt 确认所需的 Adapter 私有 launch context。 */
type CodexSubmissionContext = {
  /** 粘贴前 history.jsonl 的字节长度；只扫描此位置之后的新增完整行。 */
  historyOffset: number | null;
  /** 带本节点随机关联标识的完整任务文本，必须与 Codex 原生记录精确匹配。 */
  readonly submittedPrompt: string;
};

/**
 * Codex 正常交互式启动 Adapter。
 *
 * 它只负责受控 argv 及 SessionBackend 创建，绝不解析 TUI 文本、判断完成状态或替 Runtime
 * 更改节点状态。Codex 没有稳定的 composer-ready/submit 回执时，不能把 session 存活误称为
 * Prompt 已被模型接收；调用方必须检查标准化提交 evidence 并 fail closed。
 */
export class CodexInteractiveAdapter implements InteractiveCliAdapter {
  readonly id = "codex";
  readonly cli = "codex" as const;
  private readonly codexCommand: string;
  private readonly historyPath: string;
  private readonly historyPollMs: number;
  private readonly pasteSettleMs: number;
  private readonly confirmationAttemptMs: number;

  constructor(private readonly sessions: SessionBackend, options: CodexInteractiveAdapterOptions = {}) {
    this.codexCommand = options.command ?? "codex";
    this.historyPath = options.historyPath ?? join(process.env.CODEX_HOME || homedir(), process.env.CODEX_HOME ? "history.jsonl" : ".codex/history.jsonl");
    this.historyPollMs = positiveMilliseconds(options.historyPollMs ?? 100, "historyPollMs");
    this.pasteSettleMs = positiveMilliseconds(options.pasteSettleMs ?? 200, "pasteSettleMs");
    this.confirmationAttemptMs = positiveMilliseconds(options.confirmationAttemptMs ?? 800, "confirmationAttemptMs");
  }

  /** 构造空启动的正常交互式 Codex argv；首条任务必须经 Ready Gate 后 bracketed paste 投递。 */
  commandFor(request: Pick<CodexInteractiveStartRequest, "node" | "prompt">): readonly string[] {
    const { node, prompt } = request;
    if (node.cli !== "codex") throw new Error("Codex Adapter 只能启动 cli: codex 节点。");
    if (typeof prompt !== "string" || prompt.trim() === "") throw new Error("Codex 初始 Prompt 必须为非空字符串。");
    const sandbox = codexSandbox(node.sandbox);
    const command = [this.codexCommand, "--sandbox", sandbox, "--cd", node.cwd, "--no-alt-screen"];
    if (node.request.model) command.push("--model", node.request.model);
    return command;
  }

  /** 将 Codex 空启动计划和首条 Prompt 的私有关联上下文暴露为通用 Adapter LaunchPlan。 */
  async launch(request: CodexInteractiveStartRequest, signal: AbortSignal): Promise<InteractiveCliLaunchPlan> {
    throwIfAborted(signal);
    const nonce = crypto.randomUUID();
    const submittedPrompt = `${request.prompt}\n\n[Wave Flow 内部关联标识：wf-submit:${nonce}]`;
    const context: CodexSubmissionContext = { historyOffset: null, submittedPrompt };
    return { command: this.commandFor(request), submissionContext: context };
  }

  /** 严格参考 Botmux：拒绝 loading、恢复、容量队列与编号菜单，仅在 composer 与初始化 banner 同时成立时放行。 */
  async waitUntilReady(_request: CodexInteractiveStartRequest, _plan: InteractiveCliLaunchPlan, identity: SessionIdentity, signal: AbortSignal): Promise<PromptReadyEvidence> {
    while (true) {
      throwIfAborted(signal);
      const screen = await this.sessions.readRecent(identity, 120);
      if (isCodexComposerReady(screen)) return { ready: true, diagnostic: "Codex composer 已确认就绪。" };
      await waitForAbortableDelay(this.historyPollMs, signal);
    }
  }

  /** 严格参考 Botmux：记录粘贴前基线，bracketed paste 多行 Prompt，等待 200ms 后单独 Enter。 */
  async submitInitialPrompt(_request: CodexInteractiveStartRequest, plan: InteractiveCliLaunchPlan, identity: SessionIdentity, signal: AbortSignal): Promise<void> {
    const context = requireCodexContext(plan);
    context.historyOffset = await historyOffset(this.historyPath, signal);
    await this.sessions.pasteText(identity, context.submittedPrompt);
    await waitForAbortableDelay(this.pasteSettleMs, signal);
    await this.sessions.sendSpecialKey(identity, "Enter");
  }

  /** 只接受启动后新增的、带 session_id 且精确匹配完整任务信封的 Codex 原生提交历史。 */
  async confirmInitialPrompt(_request: CodexInteractiveStartRequest, plan: InteractiveCliLaunchPlan, identity: SessionIdentity, signal: AbortSignal): Promise<PromptSubmissionEvidence> {
    const context = plan.submissionContext as CodexSubmissionContext | undefined;
    if (!context || typeof context.historyOffset !== "number" || typeof context.submittedPrompt !== "string") {
      return unconfirmed("Codex launch context 缺失，拒绝猜测 Prompt 是否已提交。");
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const match = await waitForHistoryMatch(this.historyPath, context.historyOffset, context.submittedPrompt, this.confirmationAttemptMs, this.historyPollMs, signal);
      if (match) return { submitted: true, proof: "native-history", cliSessionId: match, diagnostic: "已确认 Codex 原生 history 提交记录。" };
      await this.sessions.sendSpecialKey(identity, "Enter");
    }
    const match = await waitForHistoryMatch(this.historyPath, context.historyOffset, context.submittedPrompt, this.confirmationAttemptMs, this.historyPollMs, signal);
    return match ? { submitted: true, proof: "native-history", cliSessionId: match, diagnostic: "已确认 Codex 原生 history 提交记录。" }
      : unconfirmed("未找到本次提交后可归属的 Codex 原生记录。");
  }

}

/** 将已实现的正常交互 Codex Adapter 注册为唯一可用的 tmux TUI 控制传输。 */
export function codexTmuxTuiRegistration(
  adapter: CodexInteractiveAdapter,
  probeCapabilities: () => Promise<AdapterCapabilities>,
): RegisteredInteractiveAdapter {
  return { cli: "codex", controlTransport: "tmux-tui", adapter, probeCapabilities };
}

function requireCodexContext(plan: InteractiveCliLaunchPlan): CodexSubmissionContext {
  const context = plan.submissionContext as CodexSubmissionContext | undefined;
  if (!context || typeof context.submittedPrompt !== "string") throw new Error("Codex launch context 缺失。");
  return context;
}

function isCodexComposerReady(screen: string): boolean {
  if (/(?:model|directory):\s*loading\b|Resuming session|esc to interrupt|Queued for capacity/i.test(screen)) return false;
  const lines = screen.trimEnd().split(/\r?\n/);
  const promptIndex = [...lines].reverse().findIndex((line) => /^\s*›(?!\s*\d+\.)\s*(?:Ask Codex to do anything)?\s*$/.test(line));
  if (promptIndex < 0) return false;
  const index = lines.length - 1 - promptIndex;
  const footer = lines.slice(index + 1).filter((line) => line.trim());
  const bannerReady = /│[ \t]+model:[ \t]+(?!loading\b)[^│\s][^│\r\n]*│[ \t\r\n]*│[ \t]+directory:[ \t]+(?!loading\b)[^│\s][^│\r\n]*│/.test(screen);
  return bannerReady && footer.length === 1 && /^\s*\S[^\n]* · (?:\/|~)\S*/.test(footer[0]);
}

/** 在创建会话前记录 history 当前字节长度；仅文件不存在时允许以空历史的 0 作为基线。 */
async function historyOffset(path: string, signal: AbortSignal): Promise<number> {
  throwIfAborted(signal);
  try { return (await stat(path)).size; } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT") return 0;
    throw new Error(`Codex history 基线不可读取：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function findHistoryMatch(path: string, offset: number, expectedPrompt: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (info.size <= offset) return null;
    const handle = await open(path, "r");
    try {
      const content = Buffer.alloc(info.size - offset);
      await handle.read(content, 0, content.length, offset);
      const text = content.toString("utf8");
      // 不以最后一条没有换行的 JSON 为证据，避免与 Codex 正在追加的半行竞争。
      const completeLines = text.split("\n").slice(0, -1);
      for (const line of completeLines) {
        try {
          const value = JSON.parse(line) as unknown;
          if (!value || typeof value !== "object") continue;
          const record = value as { text?: unknown; session_id?: unknown };
          if (record.text === expectedPrompt && typeof record.session_id === "string" && record.session_id.trim()) return record.session_id;
        } catch { /* 忽略正在追加的半行或无关记录；下次 Gate 重试会重新读取。 */ }
      }
    } finally { await handle.close(); }
  } catch { return null; }
  return null;
}

/** 在 Bootstrap 的 confirm 窗口内轮询新增完整行；时间上限由 Bootstrap 的 confirm Gate 控制。 */
async function waitForHistoryMatch(path: string, offset: number, expectedPrompt: string, timeoutMs: number, pollMs: number, signal: AbortSignal): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const match = await findHistoryMatch(path, offset, expectedPrompt);
    if (match) return match;
    await waitForAbortableDelay(Math.min(pollMs, Math.max(1, deadline - Date.now())), signal);
  }
  throwIfAborted(signal);
  return null;
}

function positiveMilliseconds(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Codex Adapter ${name} 必须是正的有限毫秒数。`);
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("首条 Prompt Gate 已取消。");
}

function waitForAbortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, milliseconds);
    const aborted = () => { clearTimeout(timer); reject(new Error("首条 Prompt Gate 已取消。")); };
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function unconfirmed(diagnostic: string): PromptSubmissionEvidence {
  return { submitted: false, proof: "unconfirmed", diagnostic };
}

function codexSandbox(value: AgentSandbox): "read-only" | "workspace-write" {
  if (value === "read-only" || value === "workspace-write") return value;
  throw new Error("Codex Adapter 只允许 read-only 或 workspace-write sandbox。");
}
