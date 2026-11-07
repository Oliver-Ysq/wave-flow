import type { JsonObject } from "../shared/json";
import type { AgentNodeExecutor, AgentNodeSnapshot } from "./run-types";

/** 仅供自动测试注入的确定性执行器；不创建 CLI、进程或会话。 */
export class DeterministicExecutor implements AgentNodeExecutor {
  readonly #pending = new Map<string, { result: JsonObject; resolve: (result: JsonObject) => void; reject: (error: Error) => void }>();

  constructor(private readonly pendingNodeIds: readonly string[] = []) {}

  /** 返回稳定 JSON 结果，验证 Runtime、Journal 和 inspect 链路。 */
  async execute(node: AgentNodeSnapshot): Promise<JsonObject> {
    if (this.pendingNodeIds.includes(node.id)) {
      return new Promise<JsonObject>((resolve, reject) => {
        const previous = this.#pending.get(node.id);
        if (previous) previous.reject(new Error(`节点 ${node.id} 被新的执行尝试取代。`));
        this.#pending.set(node.id, { result: { nodeId: node.id, summary: `开发验证节点已完成：${node.label}` }, resolve: (result) => resolve(result), reject: (error) => reject(error) });
      });
    }
    return { nodeId: node.id, summary: `开发验证节点已完成：${node.label}` };
  }

  completePending(): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) entry.resolve(entry.result);
  }

  hasPending(nodeId: string): boolean {
    return this.#pending.has(nodeId);
  }

  async stop(node: AgentNodeSnapshot): Promise<void> {
    const pending = this.#pending.get(node.id);
    if (!pending) return;
    this.#pending.delete(node.id);
    pending.reject(new Error(`节点 ${node.id} 已停止。`));
  }

  discard(node: AgentNodeSnapshot): void {
    const pending = this.#pending.get(node.id);
    if (!pending) return;
    this.#pending.delete(node.id);
    pending.reject(new Error(`节点 ${node.id} 已停止。`));
  }

  /** 确定性节点没有 ACP 协议恢复；显式声明该能力为空，避免包装层静默丢失真实 Worker 钩子。 */
  bindRecoveryHold(): void {}
}
