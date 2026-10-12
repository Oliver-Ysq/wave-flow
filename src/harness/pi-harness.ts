import { Agent } from "@mariozechner/pi-agent-core";
import { streamSimpleOpenAICompletions } from "@mariozechner/pi-ai/openai-completions";
import type { Model } from "@mariozechner/pi-ai";
import type { HarnessStreamEvent } from "./types";
import type { ResolvedHarnessModelConfig } from "./config";
import { createHarnessReadTools } from "./read-tools";
import { HARNESS_ACTION_TOOL_NAMES, type HarnessActionCallbacks, createHarnessActionTools } from "./action-tools";
import { executeReadOnlyProjectQuery, readProjectFile } from "./shell-policy";

/** Pi Harness 的受限适配器：只暴露经过 daemon 校验的只读与行动窄工具。 */
export class PiHarnessSession {
  readonly #agent: Agent;
  readonly #cwd: string;
  #assistantText = "";
  #reasoningText = "";
  #insideTaggedReasoning = false;
  #tagBuffer = "";
  #initialText = "";
  #requireReadTool = false;
  #successfulReadTools = 0;
  #listeners = new Set<(event: HarnessStreamEvent) => void>();

  constructor(
    config: ResolvedHarnessModelConfig,
    cwd: string,
    systemPrompt: string,
    priorMessages: readonly { readonly role: "user" | "assistant"; readonly text: string }[] = [],
    actions?: HarnessActionCallbacks,
  ) {
    this.#cwd = cwd;
    const model: Model<"openai-completions"> = {
      id: config.model, name: config.model, api: "openai-completions", provider: "wave-flow-openai-compatible", baseUrl: config.baseUrl,
      reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 8_192,
    };
    this.#agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        tools: [...createHarnessReadTools(cwd), ...(actions ? createHarnessActionTools(actions) : [])],
        messages: priorMessages.map((message) => message.role === "user"
          ? { role: "user" as const, content: message.text, timestamp: Date.now() }
          : { role: "assistant" as const, content: [{ type: "text" as const, text: message.text }], api: "openai-completions", provider: "wave-flow-openai-compatible", model: config.model, usage: zeroUsage(), stopReason: "stop" as const, timestamp: Date.now() }),
      },
      // DashScope Qwen thinking mode rejects `tool_choice: required`. Keep the
      // provider on auto and enforce the stronger local invariant after the
      // turn: a requested project-fact answer is never durable unless a
      // registered read tool actually completed successfully.
      streamFn: ((model, context, options) => streamSimpleOpenAICompletions(model as Model<"openai-completions">, context, options)) as import("@mariozechner/pi-agent-core").StreamFn,
      getApiKey: () => config.apiKey,
      // 已注册工具以外一律拒绝。行动工具只提出 Journal 化请求，不能直接
      // 创建 Worker、改变 Execution 状态或伪造完成。
      beforeToolCall: async ({ toolCall }) => {
        if (isHarnessToolAllowed(toolCall.name, !!actions)) return undefined;
        return { block: true, reason: "Harness 工具策略拒绝未注册或越权工具。" };
      },
    });
    this.#agent.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "assistant") { this.#assistantText = ""; this.#reasoningText = ""; this.#insideTaggedReasoning = false; this.#tagBuffer = ""; this.#initialText = ""; }
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "thinking_delta") this.pushReasoning(update.delta);
        if (update.type === "text_delta") this.pushText(update.delta);
      }
      if (event.type === "tool_execution_end" && !event.isError && (event.toolName === "read_project_file" || event.toolName === "query_project")) this.#successfulReadTools += 1;
    });
  }

  subscribe(listener: (event: HarnessStreamEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  /** 发起一轮；返回完整可耐久回答。reasoning 仅经 subscribe 实时推送。 */
  async prompt(text: string): Promise<string> {
    this.#requireReadTool = requiresVerifiedProjectFacts(text);
    this.#successfulReadTools = 0;
    const verifiedContext = this.#requireReadTool ? await collectVerifiedContext(this.#cwd, text) : "";
    await this.#agent.prompt(verifiedContext ? `${text}\n\n以下是 daemon 经 Shell Policy 验证的只读事实。只能基于这些事实回答，不要声称额外执行了工具：\n${verifiedContext}` : text);
    this.flushTextBuffer();
    // Pi 会把 abort/provider 错误收敛成最终 assistant error message，而非向
    // prompt() 抛出。必须在这里显式转为失败，不能把它伪装成“没有回答”。
    if (this.#agent.state.errorMessage) throw new Error(`Pi 回合失败：${this.#agent.state.errorMessage}`);
    if (this.#requireReadTool && this.#successfulReadTools === 0 && !verifiedContext) throw new Error("主控未执行任何已验证只读工具，拒绝耐久项目事实结论。 ");
    if (!this.#assistantText.trim()) throw new Error("Pi 未产生可耐久的完整主控回答。 ");
    return this.#assistantText;
  }
  abort(): void { this.#agent.abort(); }
  get isRunning(): boolean { return this.#agent.state.isStreaming; }
  private emit(event: HarnessStreamEvent): void { for (const listener of this.#listeners) listener(event); }
  /** 将兼容模型把 reasoning 包在 <think> 的文本流拆开；标签本身永不转发或持久化。 */
  private pushText(chunk: string): void {
    // DashScope/Qwen may send raw thinking text followed only by `</think>`. Do
    // not optimistically publish the beginning as an assistant answer: buffer
    // the first segment until we can classify it by a thinking marker.
    if (!this.#assistantText && !this.#reasoningText && !this.#insideTaggedReasoning) {
      this.#initialText += chunk;
      const opening = this.#initialText.indexOf("<think>");
      const closing = this.#initialText.indexOf("</think>");
      const label = this.#initialText.indexOf("Thinking Process:");
      // 未分类的首段不能因为长度增长就被当作正文。某些兼容 provider 会在很长
      // 的 raw reasoning 后才给出唯一的 `</think>`；宁可普通回答延迟到最终 flush，
      // 也不能把 reasoning 流入可耐久 assistant 文本。
      if (opening < 0 && closing < 0 && label < 0) return;
      let initial = this.#initialText;
      this.#initialText = "";
      if (opening >= 0) initial = initial.slice(opening + "<think>".length), this.#insideTaggedReasoning = true;
      else if (label >= 0 && (label === 0 || /^\s*$/.test(initial.slice(0, label)))) initial = initial.slice(label + "Thinking Process:".length), this.#insideTaggedReasoning = true;
      else if (closing >= 0) {
        this.pushReasoning(initial.slice(0, closing));
        this.pushText(initial.slice(closing + "</think>".length));
        return;
      }
      chunk = initial;
    }
    let remaining = this.#tagBuffer + chunk;
    this.#tagBuffer = "";
    while (remaining) {
      // Qwen compatible mode may emit `Thinking Process:` followed by a closing
      // `</think>` without first emitting `<think>`. Only at the beginning of
      // an assistant message, recognize that provider quirk before any text is
      // allowed into the durable-answer buffer.
      if (!this.#insideTaggedReasoning && !this.#assistantText && !this.#reasoningText) {
        const label = "Thinking Process:";
        if (label.startsWith(remaining)) { this.#tagBuffer = remaining; return; }
        if (remaining.startsWith(label)) {
          this.#insideTaggedReasoning = true;
          remaining = remaining.slice(label.length);
          continue;
        }
      }
      if (this.#insideTaggedReasoning) {
        const end = remaining.indexOf("</think>");
        if (end < 0) {
          const retained = suffixPrefix(remaining, "</think>");
          this.pushReasoning(remaining.slice(0, remaining.length - retained.length));
          this.#tagBuffer = retained;
          return;
        }
        this.pushReasoning(remaining.slice(0, end));
        this.#insideTaggedReasoning = false;
        remaining = remaining.slice(end + "</think>".length);
        continue;
      }
      const start = remaining.indexOf("<think>");
      if (start < 0) {
        const retained = suffixPrefix(remaining, "<think>");
        this.pushAssistant(remaining.slice(0, remaining.length - retained.length));
        this.#tagBuffer = retained;
        return;
      }
      this.pushAssistant(remaining.slice(0, start));
      this.#insideTaggedReasoning = true;
      remaining = remaining.slice(start + "<think>".length);
    }
  }
  private flushTextBuffer(): void {
    if (this.#initialText) { const initial = this.#initialText; this.#initialText = ""; this.pushAssistant(initial); }
    if (!this.#tagBuffer) return;
    if (this.#insideTaggedReasoning) this.pushReasoning(this.#tagBuffer); else this.pushAssistant(this.#tagBuffer);
    this.#tagBuffer = "";
  }
  private pushReasoning(delta: string): void { if (delta) { this.#reasoningText += delta; this.emit({ type: "reasoning_delta", delta }); } }
  private pushAssistant(delta: string): void { if (delta) { this.#assistantText += delta; this.emit({ type: "assistant_delta", delta }); } }
}

/** Pi beforeToolCall 的唯一工具白名单；无行动回调的只读会话不得越权。 */
export function isHarnessToolAllowed(name: string, hasActions: boolean): boolean {
  return name === "read_project_file" || name === "query_project" || hasActions && (HARNESS_ACTION_TOOL_NAMES as readonly string[]).includes(name);
}

/** HarnessService 依赖的 Pi 最小接口，允许在不调用模型的情况下验证耐久边界。 */
export type HarnessPiSession = Pick<PiHarnessSession, "subscribe" | "prompt" | "abort" | "isRunning">;

/** 默认本机 OpenAI-compatible Harness 配置；key 只从环境读取。 */
function zeroUsage() { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; }
function suffixPrefix(value: string, marker: string): string { for (let length = Math.min(value.length, marker.length - 1); length > 0; length -= 1) if (value.endsWith(marker.slice(0, length))) return value.slice(-length); return ""; }

/** 对常见项目事实问题预取有限只读证据，不依赖 provider 是否愿意发 tool_call。 */
async function collectVerifiedContext(cwd: string, prompt: string): Promise<string> {
  const facts: string[] = [];
  if (/package\.json|依赖/i.test(prompt)) facts.push(`package.json（受控读取）：\n${await readProjectFile(cwd, { path: "package.json", startLine: 1, endLine: 120 })}`);
  if (/git\s+status|git 状态|改动|工作区状态|\bstatus\b/i.test(prompt)) facts.push(`git status --short（受控查询）：\n${await executeReadOnlyProjectQuery(cwd, { command: "git", args: ["status", "--short"] })}`);
  if (/分支|branch/i.test(prompt)) facts.push(`git branch --show-current（受控查询）：\n${await executeReadOnlyProjectQuery(cwd, { command: "git", args: ["branch", "--show-current"] })}`);
  if (/提交历史|git\s+log|\blog\b|日志/i.test(prompt)) facts.push(`git log --oneline -n 10（受控查询）：\n${await executeReadOnlyProjectQuery(cwd, { command: "git", args: ["log", "--oneline", "-n", "10"] })}`);
  return facts.join("\n\n");
}
/** 只匹配有确定 Shell Policy 映射的事实请求；模糊“项目/状态”咨询不能伪装成已验证读取。 */
function requiresVerifiedProjectFacts(prompt: string): boolean { return /(?:package\.json|\bdependencies\b|依赖|git\s+status|git 状态|改动|工作区状态|\bstatus\b|分支|\bbranch\b|提交历史|git\s+log|\blog\b|Git 日志)/i.test(prompt); }
