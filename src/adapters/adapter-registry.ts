import type { AdapterCapabilities } from "./capabilities";
import type { InteractiveCliAdapter } from "./interactive-cli-adapter";
import type { AgentCli } from "../shared/workflow-types";

/**
 * Codex 节点的控制传输方式；它描述谁负责可靠地投递与确认任务，不等同于终端是否可被用户打开。
 * 当前仅包含已实现的 tmux TUI。App Server bridge 使用 `turn/start` ACK、thread 映射和
 * remote viewer，故不得塞入要求 tmux Gate 的本契约。
 */
export type CodexControlTransport = "tmux-tui";

/** 已完整实现的交互 CLI Adapter 注册项。 */
export type RegisteredInteractiveAdapter = {
  /** 与 Workflow 节点一致的 CLI 标识。 */
  readonly cli: AgentCli;
  /** Codex 的控制传输方式；同一 CLI 的不同传输方式必须独立注册。 */
  readonly controlTransport: CodexControlTransport;
  /** 实现 launch / ready / submit / confirm 的正常交互 Adapter。 */
  readonly adapter: InteractiveCliAdapter;
  /** 当前机器与本 Adapter 实现共同决定的能力探测器；必须返回完整能力声明。 */
  readonly probeCapabilities: () => Promise<AdapterCapabilities>;
};

/**
 * 已实现 Adapter 的不可变选择边界。
 *
 * Registry 不创建 TraeX 或 App Server 空占位；它只允许当前完整实现的 tmux TUI Adapter、能力探测和
 * 控制传输身份同时存在的条目注册。请求未注册传输方式时必须明确失败，不能回退或伪装为 tmux TUI。
 */
export class AdapterRegistry {
  #entries = new Map<string, RegisteredInteractiveAdapter>();

  /**
   * 当前发行版本只允许注册已实现并经过 tmux Gate 验证的 `tmux-tui`。
   * App Server 使用独立的协议注册边界，不能通过此构造器注册。
   */
  constructor() {}

  /** 注册一个完整实现；重复 cli/controlTransport 或 Adapter CLI 不一致均立即拒绝。 */
  register(entry: RegisteredInteractiveAdapter): void {
    if (entry.adapter.cli !== entry.cli) throw new Error(`Adapter 注册 CLI 不一致：${entry.adapter.id}=${entry.adapter.cli}，期望 ${entry.cli}。`);
    if (typeof entry.probeCapabilities !== "function") throw new Error(`Adapter 注册缺少 capability 探测器：${entry.adapter.id}。`);
    const key = adapterKey(entry.cli, entry.controlTransport);
    if (this.#entries.has(key)) throw new Error(`Adapter 控制传输已注册：${entry.cli}/${entry.controlTransport}。`);
    this.#entries.set(key, entry);
  }

  /** 按 CLI 与控制传输精确解析；不允许隐式传输方式回退。 */
  resolve(cli: AgentCli, controlTransport: string): RegisteredInteractiveAdapter {
    const entry = this.#entries.get(adapterKey(cli, controlTransport));
    if (!entry) throw new Error(`未注册的 Adapter 控制传输：${cli}/${controlTransport}。`);
    return entry;
  }

  /** 返回注册项的只读快照，供 capability 汇总或诊断使用。 */
  entries(): readonly RegisteredInteractiveAdapter[] { return [...this.#entries.values()]; }
}

function adapterKey(cli: AgentCli, controlTransport: string): string { return `${cli}\0${controlTransport}`; }
