import type { LeadSession } from "./session";
import type { LeadStreamEvent } from "./types";

/** 仅自动测试注入的确定性 LeadSession；生产绝不使用或暴露此实现。 */
export class DeterministicLeadSession implements LeadSession {
  #listeners = new Set<(event: LeadStreamEvent) => void>();
  #running = false;
  get isRunning(): boolean { return this.#running; }
  subscribe(listener: (event: LeadStreamEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  async prompt(text: string): Promise<string> { this.#running = true; try { const answer = `已收到：${text}`; for (const listener of this.#listeners) listener({ type: "assistant_delta", delta: answer }); return answer; } finally { this.#running = false; } }
  abort(): void { this.#running = false; }
}
