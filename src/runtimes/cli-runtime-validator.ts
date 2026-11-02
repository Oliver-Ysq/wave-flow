import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { AcpSessionClient, type AcpLauncher, type AcpTransportFactory } from "../adapters/acp-session";
import { adapterForCli } from "./adapter-catalog";
import { verifyExecutable } from "./identity";
import { readCliVersion } from "./cli-version";
import { resolveNodeRuntime, assertNodeMinimumVersion } from "./node-runtime";
import type { CliRuntimeRecord, RuntimeCli, RuntimeDiscoverySource, VerifiedCliRuntime } from "./types";

/** 探针 MCP 由 Engine 自身承载：编译态是 `__mcp-probe` 子命令，开发态直接 spawn 引擎入口脚本。 */
function mcpProbeServer(): acp.McpServer {
  const compiled = process.env.WF_DESKTOP_ENGINE === "1" || import.meta.dir.startsWith("/$bunfs/");
  const args = compiled ? ["__mcp-probe"] : [join(import.meta.dir, "../desktop/engine-main.ts"), "__mcp-probe"];
  return { name: "wave-flow-mcp-probe", command: process.execPath, args, env: [] } as acp.McpServer;
}

/**
 * 所有内置 CLI 的唯一验证入口：realpath 与身份 → 按 Catalog 条件解析 node 依赖 →
 * `--version` → ACP initialize → 注入内置 probe MCP server 的 session/new。
 * 接入新 CLI 只需要一条 Catalog 声明；任何一步失败都不写入 Registry。
 */
export async function validateCliRuntime(cli: RuntimeCli, input: { readonly executablePath: string; readonly discoveredFrom: RuntimeDiscoverySource; readonly discoveredShell: string | null; readonly createTransport?: AcpTransportFactory;
  /** 自动复验锁定原Node路径；缺省仅首次验证时从受控shell解析，不允许复验静默换解释器。 */
  readonly nodeExecutablePath?: string }): Promise<CliRuntimeRecord> {
  const entry = adapterForCli(cli);
  const executable = await verifyExecutable(input.executablePath);
  const pinnedNode = input.nodeExecutablePath ? await verifyExecutable(input.nodeExecutablePath) : null;
  const node = entry.requiresNodeRuntime ? pinnedNode ? {executablePath:pinnedNode.executablePath,executableIdentity:pinnedNode.identity} : await resolveNodeRuntime(input.discoveredShell, entry.minNodeVersion) : null;
  // 声明了 minNodeVersion 的 CLI（如 dsh）在旧 node 下会静默退出零输出，必须先拦在验证阶段。
  if (node && entry.minNodeVersion !== undefined) await assertNodeMinimumVersion({ executablePath: node.executablePath, executableIdentity: node.executableIdentity }, entry.minNodeVersion, entry.displayName);
  const version = await readCliVersion(executable.executablePath, entry.displayName, node ? [dirname(node.executablePath)] : []);
  const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-validate-"));
  try {
    const runtime = {
      runtimeId: crypto.randomUUID(), cli, executablePath: executable.executablePath, executableIdentity: executable.identity,
      ...(node ? { nodeExecutable: { path: node.executablePath, identity: node.executableIdentity } } : {}),
      version, discoveredFrom: input.discoveredFrom, discoveredShell: input.discoveredShell,
      // adapterVersion：Catalog 锁定值优先；未锁定（kimi）时先占位 --version 摘要，握手后以 agentInfo.version 为准。
      verifiedAdapter: { adapterId: entry.adapterId, adapterVersion: entry.adapterVersion ?? version, acpProtocolVersion: entry.acpProtocolVersion, leadTools: entry.capabilities.leadTools },
      verifiedAt: new Date().toISOString(), status: "verified", diagnostic: null,
    } satisfies CliRuntimeRecord;
    const launched = entry.launcher(runtime as VerifiedCliRuntime);
    const launcher: AcpLauncher = { id: entry.adapterId, command: launched.command, args: launched.args, env: entry.environment(runtime as VerifiedCliRuntime) };
    const client = new AcpSessionClient(launcher, input.createTransport);
    try {
      // 分阶段预算：适配器自身握手通常数秒；session/new 还要等真实 CLI 的模型列表与
      // stdio MCP 启动，实测 Codex 适配器 2.5.0 约 20–30 秒。合并成一个 15s 预算会把
      // 正常验证误判成连接失败，错误只剩一句“ACP connection closed”。
      let initialized: Awaited<ReturnType<AcpSessionClient["initialize"]>>;
      let abortPhase: "initialize" | "session/new" | null = null;
      const initController = new AbortController();
      const initTimer = setTimeout(() => { abortPhase = "initialize"; initController.abort(); }, 20_000);
      try {
        initialized = await client.initialize(initController.signal);
      } catch (error) {
        if (abortPhase === "initialize") throw new Error(`${entry.displayName} ACP initialize 超过 20 秒未响应。 `);
        throw error;
      } finally { clearTimeout(initTimer); }
      if (initialized.protocolVersion !== entry.acpProtocolVersion) throw new Error("ACP 协议版本不兼容。 ");
      const sessionController = new AbortController();
      const sessionTimer = setTimeout(() => { abortPhase = "session/new"; sessionController.abort(); }, 60_000);
      let binding: Awaited<ReturnType<AcpSessionClient["createSession"]>>;
      try {
        // 探针 server 必须随 session/new 真实交付；10s 内未完成 stdio MCP 启动视为不支持。
        binding = await client.createSession(root, sessionController.signal, entry.probeMcp ? [mcpProbeServer()] : [], entry.probeMcp ? 10_000 : undefined);
      } catch (error) {
        if (abortPhase === "session/new") throw new Error(`${entry.displayName} ACP session/new 超过 60 秒未完成（含探针 MCP 启动）。 `);
        throw error;
      } finally { clearTimeout(sessionTimer); }
      if (!binding.sessionId.trim()) throw new Error(`${entry.displayName} ACP session/new 返回空 sessionId。 `);
      if (entry.adapterVersion === null) {
        const negotiated = initialized.agentInfo?.version;
        if (typeof negotiated === "string" && negotiated.trim() && negotiated.length <= 200) {
          return { ...runtime, verifiedAdapter: { ...runtime.verifiedAdapter, adapterVersion: negotiated } };
        }
      }
      return runtime;
    } finally { client.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
}
