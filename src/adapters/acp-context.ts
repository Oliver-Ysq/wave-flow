import type * as acp from "@agentclientprotocol/sdk";

/**
 * ACP 上下文占用与压缩事实的只读投影。
 *
 * 它只解释 Agent 已经广播的结构化事实，不推断节点业务状态：
 * `usage_update` 是 Agent 自报的上下文占用，`compaction_update` 是 Agent 自报的压缩生命周期。
 * 两者都不是完成依据，也不能反过来改写节点状态；Wave Flow 只用它们做诊断归因与回合边界决策。
 *
 * 协议语义（ACP v1，见 agentclientprotocol.com/rfds/session-compaction）：
 * - `compaction_update` 按 `compactionId` upsert；首次通知确定该压缩在时间线上的位置，之后同 id 的通知就地 patch。
 * - patch 语义：字段省略表示保持原值，`null` 表示清空，具体值表示整体替换；`summary: []` 同样清空。
 * - `compaction_summary_chunk` 按接收顺序追加到该压缩的摘要末尾；首次见到的 id 会创建一个进行中的压缩。
 * - `usage_update` 不需要客户端能力声明；`used` 是当前上下文占用，`size` 是上下文窗口总量。
 */

/** Agent 自报的上下文占用快照。 */
export type AcpContextUsage = {
  /** 当前上下文中的 token 数；Agent 自报，可能包含缓存命中 token，因此不能当作计费口径。 */
  readonly used: number;
  /** 上下文窗口总大小（token）；Agent 自报，个别实现在会话早期可能给出占位值。 */
  readonly size: number;
  /** 累计会话成本；只有部分 Agent 提供，缺省表示未知而非零。 */
  readonly cost?: acp.Cost | null;
};

/** 一次上下文压缩的聚合事实。 */
export type AcpCompaction = {
  /** Agent 拥有的压缩 id，session 内唯一。 */
  readonly compactionId: string;
  /** 最近一次已知的生命周期状态；协议允许 Agent 自定义扩展值。 */
  readonly status: string;
  /** 压缩后保留的用户可见摘要内容块；协议允许没有，Agent 也可在不宜披露时省略。 */
  readonly summary: readonly acp.ContentBlock[];
  /** 压缩失败原因；成功时为 null。 */
  readonly error: string | null;
};

/** 内部可变实体；对外只暴露只读快照。 */
type MutableCompaction = {
  compactionId: string;
  status: string;
  summary: acp.ContentBlock[];
  error: string | null;
};

/** 上下文占用是否可用于阈值判断。 */
export type AcpContextUsageVerdict = {
  /** 最新占用快照；从未收到时为 null。 */
  readonly usage: AcpContextUsage | null;
  /**
   * 是否可以按 `used / size` 做阈值判断。
   *
   * 只有 `size` 存在且不小于 `used` 时才可信：个别 Adapter 在会话早期把窗口大小
   * 写成占位常量，此时 `used` 可能超过 `size`，据此计算的百分比是假的。
   */
  readonly reliable: boolean;
  /**
   * 这份快照是否测于压缩之后。
   *
   * 真实 Codex 在压缩完成后立刻把 `used` 降到压缩后的大小（实测从 16747 降到 11909）。
   * 占用下降是压缩的结果，不是"额度回升"，不能据此放松对协议重申的判断。
   * 只在所属回合内成立：回合边界会清零。
   */
  readonly afterCompaction: boolean;
};

/**
 * 单个 ACP 会话的上下文事实跟踪器。
 *
 * 只消费 `session/update` 通知，不发起任何协议调用，也不写 Journal。
 * 回合级标记由宿主在回合边界显式推进，避免把"上一回合发生过压缩"误当成"当前回合发生过"。
 */
export class AcpContextTracker {
  #usage: AcpContextUsage | null = null;
  /**
   * 最新占用快照是否测于本回合最近一次压缩完成之后。
   *
   * 它是一个关于"这份快照测在什么位置"的断言，只能由**压缩完成后到达的**占用快照建立：
   * 压缩完成时把已有快照继续标成"压缩后测量"会把压缩前的大数字读成压缩后的结果。
   */
  #usageAfterCompaction = false;
  /** 本回合内是否已有压缩进入 completed；占用快照据此判断自己是否测于压缩之后。 */
  #compactionCompletedThisTurn = false;
  #compactions = new Map<string, MutableCompaction>();
  /** 本回合内是否出现过任意状态的压缩。 */
  #compactedThisTurn = false;

  /** 应用一条 session update；与上下文无关的事件被忽略。 */
  apply(update: acp.SessionUpdate): void {
    if (update.sessionUpdate === "usage_update") {
      this.#usage = {
        used: update.used,
        size: update.size,
        ...(update.cost !== undefined ? { cost: update.cost } : {}),
      };
      // 只有压缩完成之后到达的快照才是"压缩后测量"；压缩前采到的旧快照仍属于压缩前。
      this.#usageAfterCompaction = this.#compactionCompletedThisTurn;
      return;
    }
    if (update.sessionUpdate === "compaction_update") {
      this.#applyCompactionUpdate(update);
      return;
    }
    if (update.sessionUpdate === "compaction_summary_chunk") {
      this.#applySummaryChunk(update);
    }
  }

  /** 上下文占用快照与其可用性判定。 */
  get usage(): AcpContextUsageVerdict {
    const usage = this.#usage;
    if (!usage) return { usage: null, reliable: false, afterCompaction: false };
    // size 缺失、为零或小于 used 时，窗口大小不可信：不能用它算百分比。
    const reliable = Number.isFinite(usage.used) && Number.isFinite(usage.size) && usage.size > 0 && usage.used <= usage.size;
    return { usage, reliable, afterCompaction: this.#usageAfterCompaction };
  }

  /** 全部已知压缩事实，按首次出现顺序。 */
  get compactions(): readonly AcpCompaction[] {
    return [...this.#compactions.values()].map((entry) => ({
      compactionId: entry.compactionId,
      status: entry.status,
      summary: [...entry.summary],
      error: entry.error,
    }));
  }

  /** 本回合内是否出现过压缩（任意状态）。 */
  get compactedThisTurn(): boolean { return this.#compactedThisTurn; }

  /** 回合边界：清空回合级标记，保留 usage 与压缩实体的历史。 */
  beginTurn(): void {
    this.#compactedThisTurn = false;
    // 压缩后标记只在所属回合内有效：本回合末的占用快照才可能是"压缩后测量"。
    // 不清空会让很久之后的快照继续被标成压缩后，读成"刚发生过压缩"。
    this.#usageAfterCompaction = false;
    this.#compactionCompletedThisTurn = false;
  }

  #applyCompactionUpdate(update: Extract<acp.SessionUpdate, { sessionUpdate: "compaction_update" }>): void {
    const existing = this.#compactions.get(update.compactionId);
    const entry: MutableCompaction = existing ?? { compactionId: update.compactionId, status: update.status, summary: [], error: null };
    entry.status = update.status;
    // patch 语义：省略=保持，null/[]=清空，具体值=整体替换。
    if (update.summary !== undefined) {
      entry.summary = update.summary === null ? [] : [...update.summary];
    }
    if (update.error !== undefined) entry.error = update.error;
    this.#compactions.set(update.compactionId, entry);
    this.#compactedThisTurn = true;
    if (update.status === "completed") {
      this.#compactionCompletedThisTurn = true;
      // 已有快照测于压缩之前：压缩完成不会让它的测量位置变新。
      this.#usageAfterCompaction = false;
    }
  }

  #applySummaryChunk(update: Extract<acp.SessionUpdate, { sessionUpdate: "compaction_summary_chunk" }>): void {
    const existing = this.#compactions.get(update.compactionId);
    // 首次见到的 id 会创建一个进行中的压缩，状态沿用协议默认语义。
    const entry: MutableCompaction = existing ?? { compactionId: update.compactionId, status: "in_progress", summary: [], error: null };
    entry.summary.push(update.content);
    this.#compactions.set(update.compactionId, entry);
    this.#compactedThisTurn = true;
  }
}
