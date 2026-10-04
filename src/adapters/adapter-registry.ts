import type { AdapterCapabilities } from "./capabilities";
import type { InteractiveCliAdapter } from "./interactive-cli-adapter";
import type { AgentCli } from "../shared/workflow-types";

/** 当前受控运行策略可选择的 Codex CLI Base；未注册 CLI Base 不得被静默降级。 */
export type CodexCliBase = "tmux-tui" | "app-server";

/** 已完整实现的交互 CLI Adapter 注册项。 */
export type RegisteredInteractiveAdapter = {
  /** 与 Workflow 节点一致的 CLI 标识。 */
  readonly cli: AgentCli;
  /** Codex 的具体 CLI Base；同一 CLI 的不同 CLI Base 必须独立注册。 */
  readonly cliBase: CodexCliBase;
  /** 实现 launch / ready / submit / confirm 的正常交互 Adapter。 */
  readonly adapter: InteractiveCliAdapter;
  /** 当前机器与本 Adapter 实现共同决定的能力探测器；必须返回完整能力声明。 */
  readonly probeCapabilities: () => Promise<AdapterCapabilities>;
};

/**
 * 已实现 Adapter 的不可变选择边界。
 *
 * Registry 不创建 TraeX 或 App Server 空占位；它只允许完整 Adapter、能力探测和 CLI Base
 * 身份同时存在的条目注册。请求未注册 CLI Base 时必须明确失败，不能回退到 tmux TUI。
 */
export class AdapterRegistry {
  #entries = new Map<string, RegisteredInteractiveAdapter>();

  /**
   * @param allowedCliBases 当前发行版本允许注册的 CLI Base；默认只开放已实现的 tmux-tui。
   * P1 在 App Server Adapter、官方协议验证与能力探测完整后才可显式扩大该集合。
   */
  constructor(private readonly allowedCliBases: ReadonlySet<CodexCliBase> = new Set(["tmux-tui"])) {}

  /** 注册一个完整实现；重复 cli/cliBase 或 Adapter CLI 不一致均立即拒绝。 */
  register(entry: RegisteredInteractiveAdapter): void {
    if (entry.adapter.cli !== entry.cli) throw new Error(`Adapter 注册 CLI 不一致：${entry.adapter.id}=${entry.adapter.cli}，期望 ${entry.cli}。`);
    if (typeof entry.probeCapabilities !== "function") throw new Error(`Adapter 注册缺少 capability 探测器：${entry.adapter.id}。`);
    if (!this.allowedCliBases.has(entry.cliBase)) throw new Error(`当前版本不允许注册 Adapter CLI Base：${entry.cli}/${entry.cliBase}。`);
    const key = adapterKey(entry.cli, entry.cliBase);
    if (this.#entries.has(key)) throw new Error(`Adapter CLI Base 已注册：${entry.cli}/${entry.cliBase}。`);
    this.#entries.set(key, entry);
  }

  /** 按 CLI 与 CLI Base 精确解析；不允许隐式 CLI Base 回退。 */
  resolve(cli: AgentCli, cliBase: CodexCliBase): RegisteredInteractiveAdapter {
    const entry = this.#entries.get(adapterKey(cli, cliBase));
    if (!entry) throw new Error(`未注册的 Adapter CLI Base：${cli}/${cliBase}。`);
    return entry;
  }

  /** 返回注册项的只读快照，供 capability 汇总或诊断使用。 */
  entries(): readonly RegisteredInteractiveAdapter[] { return [...this.#entries.values()]; }
}

function adapterKey(cli: AgentCli, cliBase: CodexCliBase): string { return `${cli}\0${cliBase}`; }
