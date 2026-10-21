import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { systemCliInstallDirectories, versionManagerBinDirectories } from "./install-dirs";
import { verifyExecutable, verifyExecutableIdentity } from "./identity";
import type { ExecutableIdentity } from "./types";

/** JavaScript 入口 CLI（codex/dsh）经 `env node` 运行时所需的、已验证的 Node 依赖。 */
export type VerifiedNodeRuntime = {
  /** `node` realpath；仅保存在私有 Runtime Registry，不回显到 Web 或 Journal。 */
  readonly executablePath: string;
  /** 启动前复核的文件身份，防止 PATH 中同名 node 被静默替换。 */
  readonly executableIdentity: ExecutableIdentity;
};

/** 从受控 login shell 查找 node；命令固定且不接受模型、网页或 Workflow 参数。
 * 声明 minMajor 时（如 dsh 需要 Node ≥ 24）会继续检查受控候选目录，返回第一个满足下限的解释器；
 * 这样用户在默认 node 过旧的机器上仍能通过设置页一次验证，而不是只能手动钉住路径。
 */
export async function resolveNodeRuntime(shell: string | null, minMajor?: number): Promise<VerifiedNodeRuntime> {
  const candidates = await nodeCandidates(shell);
  return selectNodeRuntime(candidates, minMajor);
}

/** login shell 结果优先，其后是按受控目录兜底的候选；去重但不改变发现顺序。 */
async function nodeCandidates(shell: string | null): Promise<readonly string[]> {
  const discovered: string[] = [];
  const commandShell = safeShell(shell);
  const env: Record<string, string> = { PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin", HOME: process.env.HOME ?? "", USER: process.env.USER ?? "", SHELL: commandShell, DISABLE_AUTO_UPDATE: "true" };
  const child = Bun.spawn([commandShell, "-ilc", "command -v node"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env });
  const timer = setTimeout(() => child.kill(), 5_000);
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  clearTimeout(timer);
  const path = stdout.trim().split(/\r?\n/).find(line => line.startsWith("/"))?.trim();
  if (code === 0 && path) discovered.push(path);
  // login shell 没给出 node 时按受控目录兜底：nvm 可能只由 GUI 环境注入，
  // 从 Finder 启动的 App 两条 PATH 都不含它，Codex 会因此被判成不可用。
  discovered.push(...await candidateNodePaths());
  return [...new Set(discovered)];
}

/** 按候选顺序解析 node；minMajor 缺省时首个可验证候选即结果，声明下限时逐候选读取主版本。 */
export async function selectNodeRuntime(candidates: readonly string[], minMajor?: number): Promise<VerifiedNodeRuntime> {
  let highest: { readonly executablePath: string; readonly executableIdentity: ExecutableIdentity; readonly major: number } | null = null;
  for (const candidate of candidates) {
    let verified;
    try { verified = await verifyExecutable(candidate); } catch { continue; /* 继续查下一个候选 */ }
    if (minMajor === undefined) return { executablePath: verified.executablePath, executableIdentity: verified.identity };
    const major = await nodeMajorVersion(verified.executablePath);
    if (major === null) continue;
    if (major >= minMajor) return { executablePath: verified.executablePath, executableIdentity: verified.identity };
    if (!highest || major > highest.major) highest = { executablePath: verified.executablePath, executableIdentity: verified.identity, major };
  }
  if (minMajor !== undefined) {
    const found = highest ? `找到的最高版本为 v${highest.major}` : "受控目录中没有可验证的 node";
    throw new Error(`未找到满足 Node ≥ ${minMajor} 的 node 解释器（${found}）。请安装新版本 Node 后重新验证该 CLI。 `);
  }
  throw new Error("无法解析该 CLI 所需的 node 解释器。 ");
}

/** 固定 argv `--version` 读取主版本；无法解析返回 null（不把未知当满足）。 */
async function nodeMajorVersion(executablePath: string): Promise<number | null> {
  const child = Bun.spawn([executablePath, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin" } });
  const timer = setTimeout(() => child.kill(), 5_000);
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  clearTimeout(timer);
  const match = /^v(\d+)\./.exec(stdout.trim());
  return code === 0 && match ? Number(match[1]) : null;
}

/** 受控 node 候选：进程 PATH、系统安装目录与 nvm 版本目录，去重后逐个验证。 */
async function candidateNodePaths(): Promise<readonly string[]> {
  const home = process.env.HOME ?? homedir();
  const directories = [
    ...(process.env.PATH ?? "").split(":").filter(Boolean),
    ...systemCliInstallDirectories(process.platform, home),
    ...(home ? await versionManagerBinDirectories(home) : []),
  ];
  return [...new Set(directories)].map((directory) => join(directory.replace(/\/$/, ""), "node"));
}

/** 已存 node 依赖在每次启动前都要复核；路径漂移必须 fail closed。 */
export async function verifyNodeRuntime(path: string, identity: ExecutableIdentity): Promise<VerifiedNodeRuntime> {
  const verified = await verifyExecutableIdentity(path, identity);
  return { executablePath: verified.executablePath, executableIdentity: verified.identity };
}

/**
 * 对已复核的 node 执行固定 argv `--version` 主版本校验。语义是"该 CLI 的入口脚本
 * 由此 node 执行时的最低主版本"：例如 dsh 入口用 import.meta.main，Node ≤22 下静默
 * 退出 0 且零输出。不达标即抛错（验证或启动前复核 fail closed），文案必须可操作。
 */
export async function assertNodeMinimumVersion(node: VerifiedNodeRuntime, minMajor: number, cliLabel: string): Promise<void> {
  const child = Bun.spawn([node.executablePath, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin" } });
  const timer = setTimeout(() => child.kill(), 5_000);
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  clearTimeout(timer);
  const match = /^v(\d+)\./.exec(stdout.trim());
  const major = match ? Number(match[1]) : NaN;
  if (code !== 0 || !Number.isInteger(major)) throw new Error(`无法确认 ${cliLabel} 所需 node 解释器的版本（需要 Node ≥ ${minMajor}）。 `);
  if (major < minMajor) throw new Error(`${cliLabel} 需要 Node ≥ ${minMajor} 运行时，当前验证到的 node 为 v${major}。请安装新版本 Node 后重新验证该 CLI。 `);
}

/** 仅把经验证 node 所在目录加入最小 PATH。 */
export function nodeRuntimeDirectory(node: VerifiedNodeRuntime): string { return dirname(node.executablePath); }

function safeShell(value: string | null): "/bin/zsh" | "/bin/bash" {
  return value === "/bin/bash" ? "/bin/bash" : "/bin/zsh";
}
