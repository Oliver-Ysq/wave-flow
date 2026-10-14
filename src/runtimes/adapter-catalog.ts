import { codexAcpAdapterEntry } from "./codex-acp-entry";
import { createKimiWorkerEnvironment, createWorkerEnvironment } from "./worker-environment";
import type { RuntimeCli, VerifiedCliRuntime } from "./types";

/** 当前锁定的 Codex ACP adapter 来源；用户 runtime 不得决定 adapter argv。 */
export const CODEX_ACP_ADAPTER = { id: "codex-acp" as const, version: "2.2.2", protocolVersion: 1 };

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
  readonly adapterId: "codex-acp" | "kimi-acp";
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
  /** 由启动前已复核的 runtime 生成固定启动命令；argv 只来自本目录，不接受模型、网页或 Workflow 输入。 */
  readonly launcher: (runtime: VerifiedCliRuntime) => { readonly command: string; readonly args: readonly string[] };
  /** 由已复核 runtime 构造最小白名单环境。 */
  readonly environment: (runtime: VerifiedCliRuntime) => Readonly<Record<string, string>>;
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
