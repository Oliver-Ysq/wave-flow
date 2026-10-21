import { codexAcpAdapterEntry } from "./codex-acp-entry";
import { claudeAcpAdapterEntry } from "./claude-acp-entry";
import { createClaudeWorkerEnvironment, createDshWorkerEnvironment, createKimiWorkerEnvironment, createWorkerEnvironment } from "./worker-environment";
import type { RuntimeCli, VerifiedCliRuntime } from "./types";
import { claudeSessionIsolation, codexSessionIsolation, dshSessionIsolation, kimiSessionIsolation, type SessionIsolationProfile } from "./session-isolation";

/** 当前锁定的 Codex ACP adapter 来源；用户 runtime 不得决定 adapter argv。 */
export const CODEX_ACP_ADAPTER = { id: "codex-acp" as const, version: "2.2.2", protocolVersion: 1 };

/** 当前锁定的 Claude Code ACP adapter 来源；与 Codex 同构，真实 CLI 由 CLAUDE_CODE_EXECUTABLE 指向。 */
export const CLAUDE_ACP_ADAPTER = { id: "claude-acp" as const, version: "0.94.0", protocolVersion: 1 };

/** 内置 Adapter 的能力声明；能力未验证前一律为 false，绝不占位。 */
export type AdapterCapabilities = {
  /** 是否支持为主控注入 session-scoped Harness 窄工具；codex-acp 与 kimi-acp 已验证。 */
  readonly harnessTools: boolean;
  /** 是否支持 Worker session 私有的完成协议 MCP；已由 ACP 探针验证。 */
  readonly workerControlMcp: boolean;
  /** 是否支持 Workflow 请求模型覆盖；本期未实现。 */
  readonly modelOverride: boolean;
  /** 是否支持向用户暴露模型目录；本期未实现。 */
  readonly modelCatalog: boolean;
};

/** Adapter Catalog 中一个内置 ACP Adapter 的完整声明。 */
export type AdapterCatalogEntry = {
  /** 固定 adapter 标识；同时是 ACP launcher 的审计 id。 */
  readonly adapterId: "codex-acp" | "kimi-acp" | "claude-acp" | "dsh-acp";
  /** 该 adapter 承载的 CLI 种类。 */
  readonly cli: RuntimeCli;
  /** 用户可读的 CLI 名称；只用于验证失败的错误文案。 */
  readonly displayName: string;
  /** 验证时是否注入内置 probe MCP，以实测 session/new 的会话私有 MCP 注入能力。 */
  readonly probeMcp: boolean;
  /** 内置锁定的 adapter 版本；为 null 时由验证握手返回的 agentInfo.version 决定并写入 Registry。 */
  readonly adapterVersion: string | null;
  /** 握手要求的 ACP 协议版本。 */
  readonly acpProtocolVersion: number;
  /** 已验证能力集合。 */
  readonly capabilities: AdapterCapabilities;
  /** true 时该 CLI 是 JavaScript 入口，Registry 复核必须包含 node 依赖；false 时为自包含二进制，跳过 node。 */
  readonly requiresNodeRuntime: boolean;
  /**
   * 该 CLI 入口脚本由 node 执行时的最低主版本（如 dsh 的 import.meta.main 需要 Node ≥ 24）。
   * 缺省表示无下限；仅对 requiresNodeRuntime 条目有意义，验证与启动前复核不达标即 fail closed。
   */
  readonly minNodeVersion?: number;
  /** 由启动前已复核的 runtime 生成固定启动命令；argv 只来自本目录，不接受模型、网页或 Workflow 输入。 */
  readonly launcher: (runtime: VerifiedCliRuntime) => { readonly command: string; readonly args: readonly string[] };
  /** 由已复核 runtime 构造最小白名单环境。 */
  readonly environment: (runtime: VerifiedCliRuntime) => Readonly<Record<string, string>>;
  /** 私有状态与隔离启动配置；缺省不支持，宿主按角色能力拒绝，不以CLI名称分支。 */
  readonly sessionIsolation?: SessionIsolationProfile;
};

const entries: readonly AdapterCatalogEntry[] = [
  {
    adapterId: "codex-acp",
    cli: "codex",
    displayName: "Codex CLI",
    probeMcp: true,
    adapterVersion: CODEX_ACP_ADAPTER.version,
    acpProtocolVersion: CODEX_ACP_ADAPTER.protocolVersion,
    capabilities: { harnessTools: true, workerControlMcp: true, modelOverride: false, modelCatalog: false },
    requiresNodeRuntime: true,
    launcher: () => codexAcpAdapterEntry(),
    environment: (runtime) => createWorkerEnvironment(runtime),
    sessionIsolation: codexSessionIsolation,
  },
  {
    adapterId: "kimi-acp",
    cli: "kimi",
    displayName: "Kimi CLI",
    probeMcp: true,
    adapterVersion: null,
    acpProtocolVersion: 1,
    capabilities: { harnessTools: true, workerControlMcp: true, modelOverride: false, modelCatalog: false },
    requiresNodeRuntime: false,
    // Kimi CLI 自身即 ACP server；命令直接是用户已验证的 realpath。
    launcher: (runtime) => ({ command: runtime.executablePath, args: ["acp"] }),
    environment: (runtime) => createKimiWorkerEnvironment(runtime),
    sessionIsolation: kimiSessionIsolation,
  },
  {
    adapterId: "claude-acp",
    cli: "claude",
    displayName: "Claude Code",
    probeMcp: true,
    adapterVersion: CLAUDE_ACP_ADAPTER.version,
    acpProtocolVersion: CLAUDE_ACP_ADAPTER.protocolVersion,
    // 主控窄工具经真实隔离 Home + MCP 注入验收后声明（见 chapter 14.2）。
    // Claude Code 2.x 的 CLI 是原生二进制（claude.exe）；adapter 进程由 Engine 自带运行时启动，
    // 不要求用户安装 node。旧版 JS 入口由用户环境自行提供 node。
    capabilities: { harnessTools: true, workerControlMcp: true, modelOverride: false, modelCatalog: false },
    requiresNodeRuntime: false,
    launcher: () => claudeAcpAdapterEntry(),
    environment: (runtime) => createClaudeWorkerEnvironment(runtime),
    sessionIsolation: claudeSessionIsolation,
  },
  {
    adapterId: "dsh-acp",
    cli: "dsh",
    displayName: "DeepSeek Harness",
    probeMcp: true,
    // dsh 是 developer preview，握手 agentInfo.version 才是权威 adapter 版本。
    adapterVersion: null,
    acpProtocolVersion: 1,
    // 主控窄工具经真实隔离 Home + MCP 注入验收后声明（见 chapter 14.2）。
    capabilities: { harnessTools: true, workerControlMcp: true, modelOverride: false, modelCatalog: false },
    requiresNodeRuntime: true,
    // dsh 入口使用 import.meta.main；Node ≤22 下静默退出 0 且零输出，必须 Node ≥ 24。
    minNodeVersion: 24,
    // dsh CLI 自身即 ACP server；命令直接是用户已验证的 realpath。
    launcher: (runtime) => ({ command: runtime.executablePath, args: ["acp"] }),
    environment: (runtime) => createDshWorkerEnvironment(runtime),
    sessionIsolation: dshSessionIsolation,
  },
];

/** 按 CLI 种类取内置 adapter；未知种类抛错，调用方应先经 workerAdapterForCli 判定。 */
export function adapterForCli(cli: RuntimeCli): AdapterCatalogEntry {
  const entry = entries.find(item => item.cli === cli);
  if (!entry) throw new Error(`未知 CLI Adapter：${cli}。 `);
  return entry;
}

/** 按固定 adapter id 查询；未知 id 返回 null。 */
export function adapterById(adapterId: string): AdapterCatalogEntry | null {
  return entries.find(item => item.adapterId === adapterId) ?? null;
}

/** Worker 执行面的 CLI 判定；未知 cli 返回 null，由调用方 fail closed。 */
export function workerAdapterForCli(cli: string): AdapterCatalogEntry | null {
  return entries.find(item => item.cli === cli) ?? null;
}

/** Catalog 当前声明的全部 CLI 种类；扫描与种类回退以此为准，不再硬编码二元名单。 */
export function catalogClis(): readonly RuntimeCli[] {
  return entries.map(item => item.cli);
}
