import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpSessionClient, type AcpTransportFactory } from "../adapters/acp-session";
import { verifyExecutable } from "./identity";
import { createWorkerEnvironment } from "./worker-environment";
import { codexAcpAdapterEntry } from "./codex-acp-entry";
import { resolveNodeRuntime } from "./node-runtime";
import type { CliRuntimeRecord, RuntimeDiscoverySource } from "./types";

/** 当前锁定的 Codex ACP adapter 来源；用户 runtime 不得决定 adapter argv。 */
export const CODEX_ACP_ADAPTER = { id: "codex-acp" as const, version: "2.2.2", protocolVersion: 1 };

/** 验证候选 CLI 可以被固定 ACP adapter initialize/session/new；绝不发送业务 Prompt。 */
export async function validateCodexRuntime(input: { readonly executablePath: string; readonly discoveredFrom: RuntimeDiscoverySource; readonly discoveredShell: string | null; readonly controlCommand: string; readonly createTransport?: AcpTransportFactory }): Promise<CliRuntimeRecord> {
  const executable = await verifyExecutable(input.executablePath);
  const node = await resolveNodeRuntime(input.discoveredShell);
  const version = await readVersion(executable.executablePath, node.executablePath);
  const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-validate-"));
  try {
    const provisional = { runtimeId: crypto.randomUUID(), cli: "codex" as const, executablePath: executable.executablePath, executableIdentity: executable.identity, nodeExecutable: { path: node.executablePath, identity: node.executableIdentity }, version, discoveredFrom: input.discoveredFrom, discoveredShell: input.discoveredShell, verifiedAdapter: { adapterId: CODEX_ACP_ADAPTER.id, adapterVersion: CODEX_ACP_ADAPTER.version, acpProtocolVersion: CODEX_ACP_ADAPTER.protocolVersion, harnessTools: true }, verifiedAt: new Date().toISOString(), status: "verified" as const, diagnostic: null };
    const entry = codexAcpAdapterEntry();
    const launcher = { id: CODEX_ACP_ADAPTER.id, command: entry.command, args: entry.args, env: createWorkerEnvironment(provisional, input.controlCommand) };
    const client = new AcpSessionClient(launcher, input.createTransport);
    try { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15_000); const initialized = await client.initialize(controller.signal); await client.createSession(root, controller.signal); clearTimeout(timer); if (initialized.protocolVersion !== CODEX_ACP_ADAPTER.protocolVersion) throw new Error("ACP 协议版本不兼容。 "); }
    finally { client.close(); }
    return provisional;
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function readVersion(path: string, nodePath: string): Promise<string> {
  // `--version` 也必须模拟用户实际 CLI 环境的最小必要部分；许多用户安装器会
  // 通过 HOME 读取自身配置或解析 wrapper。仍然不继承任意 daemon 环境变量。
  const env: Record<string, string> = { PATH: `${nodePath.slice(0, nodePath.lastIndexOf("/"))}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin` };
  for (const key of ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG"] as const) if (process.env[key]) env[key] = process.env[key]!;
  const child = Bun.spawn([path, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
  const timer = setTimeout(() => child.kill(), 5_000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  // 成功时以 stdout 的首个非空行为权威版本；stderr 常含 PATH alias、临时目录
  // 等非版本警告，不得污染 Registry 展示或形成虚假的版本漂移。
  const value = (stdout.trim() || stderr.trim()).split(/\r?\n/).find(line => line.trim())?.trim() ?? "";
  if (code !== 0 || !value || value.length > 500) throw new Error("无法读取 Codex CLI 版本。 ");
  return value;
}
