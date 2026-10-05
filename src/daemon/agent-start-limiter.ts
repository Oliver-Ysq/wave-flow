import type { AgentNodeExecutor, AgentNodeSnapshot } from "../runtime/run-types";

/** 当前用户 daemon 共享的真实 Agent 启动名额。 */
export class AgentStartLimiter {
  #active = 0;
  #waiting: Array<(release: () => void) => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("maxActiveAgents 必须是不小于 1 的整数。");
  }

  /** 等待名额；返回的 release 必须在节点结束后恰好调用一次。 */
  async acquire(): Promise<() => void> {
    // 有等待者时，新节点不能绕过队列抢走刚释放的名额。名额由 release() 直接
    // 转交给队首等待者，使 active 永远不超过 limit。
    if (this.#active < this.limit && this.#waiting.length === 0) {
      this.#active += 1;
      return this.createRelease();
    }
    return new Promise<() => void>((resolve) => this.#waiting.push(resolve));
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiting.shift();
      // 直接转交名额，active 保持不变；这样在等待者恢复前，新请求也无法插队。
      if (next) { next(this.createRelease()); return; }
      this.#active -= 1;
    };
  }

  get waiting(): number { return this.#waiting.length; }
}

/** 为一个节点执行器附加 daemon 共享名额，不改动具体 CLI Adapter 的职责。 */
export class LimitedAgentExecutor implements AgentNodeExecutor {
  #releases = new Map<string, () => void>();
  #waiting = new Set<string>();

  constructor(private readonly delegate: AgentNodeExecutor, private readonly limiter: AgentStartLimiter) {}

  async waitForStart(node: AgentNodeSnapshot): Promise<void> {
    const key = nodeKey(node);
    if (this.#releases.has(key)) throw new Error("同一 Agent 节点重复申请启动名额。");
    this.#waiting.add(key);
    try {
      this.#releases.set(key, await this.limiter.acquire());
    } finally {
      this.#waiting.delete(key);
    }
  }

  /** 只报告当前 Run executor 的节点是否等待，不能把其他 Run 的排队当成本 Run 已安全交还。 */
  hasWaitingStart(): boolean { return this.#waiting.size > 0; }

  async execute(node: AgentNodeSnapshot) {
    const key = nodeKey(node);
    try { return await this.delegate.execute(node); }
    finally {
      this.#releases.get(key)?.();
      this.#releases.delete(key);
    }
  }

  cancelStart(node: AgentNodeSnapshot): void {
    const key = nodeKey(node);
    this.#releases.get(key)?.();
    this.#releases.delete(key);
  }

  async probeCapabilities() {
    if (!this.delegate.probeCapabilities) throw new Error("执行器未提供运行期能力重检。");
    return this.delegate.probeCapabilities();
  }

  requiredCapabilities(node: AgentNodeSnapshot) { return this.delegate.requiredCapabilities?.(node) ?? {}; }
}

// 每个 Run 都创建独立 LimitedAgentExecutor，且节点 id 在 Run 内唯一；不能把
// agentSessionId 放进 key，因为申请名额时它尚未生成，进入 execute 时才存在。
function nodeKey(node: AgentNodeSnapshot): string { return node.id; }
