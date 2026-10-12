import type { HarnessStreamEvent } from "./types";

/** HarnessService 依赖的通用主控会话；具体 CLI/Adapter 不泄漏到服务层。 */
export type HarnessSession = {
  /** 订阅当前回合的瞬时 reasoning / assistant delta。 */
  subscribe(listener: (event: HarnessStreamEvent) => void): () => void;
  /** 发送一轮用户消息并返回可耐久的完整 assistant 文本。 */
  prompt(text: string): Promise<string>;
  /** 取消当前回合；不能将取消伪装成完整回答。 */
  abort(): void;
  /** 当前是否有尚未收敛的主控回合。 */
  readonly isRunning: boolean;
  /** 关闭 ACP/MCP 等会话资源；不会修改 Harness Journal。 */
  close?(): void;
};
