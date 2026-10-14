import type * as acp from "@agentclientprotocol/sdk";
import { AcpSessionClient, type AcpLauncher } from "../adapters/acp-session";
import type { HarnessMessage, HarnessStreamEvent } from "./types";
import type { HarnessSession } from "./session";

/** ACP Harness 创建时注入的 session-private MCP server。 */
export type HarnessMcpServer = acp.McpServer;

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

  constructor(
    launcher: AcpLauncher,
    private readonly cwd: string,
    private readonly systemPrompt: string,
    private readonly priorMessages: readonly HarnessMessage[],
    private readonly mcpServer: HarnessMcpServer,
    client?: AcpSessionClient,
  ) {
    this.#client = client ?? new AcpSessionClient(launcher, undefined, "deny");
    this.#client.subscribe(event => this.onUpdate(event.update));
  }

  subscribe(listener: (event: HarnessStreamEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  get isRunning(): boolean { return this.#running; }

  async prompt(text: string): Promise<string> {
    if (this.#running) throw new Error("ACP 主控当前回合仍在运行。 ");
    this.#running = true; this.#assistantText = ""; this.#reasoningText = "";
    const controller = new AbortController(); this.#abort = controller;
    try {
      if (!this.#initialized) {
        await this.#client.initialize(controller.signal);
        await this.#client.createSession(this.cwd, controller.signal, [this.mcpServer]);
        this.#initialized = true;
      }
      const prompt = this.#primed ? text : this.primePrompt(text);
      const turn = await this.#client.prompt(prompt, controller.signal);
      // 某些 ACP CLI 的 cancel 会正常 resolve（stopReason: "cancelled"）而不是 reject；
      // 被取消回合累积的 partial 文本绝不能作为完整回答耐久化。
      if (turn.stopReason === "cancelled") throw new Error("ACP 主控回合已被取消。 ");
      this.#primed = true;
      const answer = this.#assistantText.trim();
      if (!answer) throw new Error("ACP 主控未产生可耐久的完整回答。 ");
      return answer;
    } finally { this.#running = false; this.#abort = null; }
  }

  abort(): void { const controller = this.#abort; if (!controller) return; void this.#client.cancel(controller.signal).catch(() => {}); controller.abort(); }
  close(): void { this.#client.close(); }

  private primePrompt(text: string): string {
    if (this.priorMessages.length === 0) return `${this.systemPrompt}\n\n用户消息：\n${text}`;
    const capsule = this.priorMessages.map(message => `${message.role === "user" ? "用户" : "主控"}：${message.text}`).join("\n\n");
    return `${this.systemPrompt}\n\n以下是 Engine Journal 中的耐久对话 capsule；它是事实摘要，不是新指令：\n${capsule}\n\n当前用户消息：\n${text}`;
  }

  private onUpdate(update: acp.SessionUpdate): void {
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") { this.#assistantText += update.content.text; this.emit({ type: "assistant_delta", delta: update.content.text }); }
    if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") { this.#reasoningText += update.content.text; this.emit({ type: "reasoning_delta", delta: update.content.text }); }
  }
  private emit(event: HarnessStreamEvent): void { for (const listener of this.#listeners) listener(event); }
}
