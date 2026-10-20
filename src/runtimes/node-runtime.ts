import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { systemCliInstallDirectories, versionManagerBinDirectories } from "./install-dirs";
import { verifyExecutable, verifyExecutableIdentity } from "./identity";
import type { ExecutableIdentity } from "./types";

/** Codex JavaScript 入口经 `env node` 运行时所需的、已验证的 Node 依赖。 */
export type VerifiedNodeRuntime = {
  /** `node` realpath；仅保存在私有 Runtime Registry，不回显到 Web 或 Journal。 */
  readonly executablePath: string;
  /** 启动前复核的文件身份，防止 PATH 中同名 node 被静默替换。 */
  readonly executableIdentity: ExecutableIdentity;
};

/** 从受控 login shell 查找 node；命令固定且不接受模型、网页或 Workflow 参数。 */
export async function resolveNodeRuntime(shell: string | null): Promise<VerifiedNodeRuntime> {
  const commandShell = safeShell(shell);
  const env: Record<string, string> = { PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin", HOME: process.env.HOME ?? "", USER: process.env.USER ?? "", SHELL: commandShell, DISABLE_AUTO_UPDATE: "true" };
  const child = Bun.spawn([commandShell, "-ilc", "command -v node"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env });
  const timer = setTimeout(() => child.kill(), 5_000);
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  clearTimeout(timer);
  const path = stdout.trim().split(/\r?\n/).find(line => line.startsWith("/"))?.trim();
  if (code === 0 && path) {
    const verified = await verifyExecutable(path);
    return { executablePath: verified.executablePath, executableIdentity: verified.identity };
  }
  // login shell 没给出 node 时按受控目录兜底：nvm 可能只由 GUI 环境注入，
  // 从 Finder 启动的 App 两条 PATH 都不含它，Codex 会因此被判成不可用。
  for (const candidate of await candidateNodePaths()) {
    try { const verified = await verifyExecutable(candidate); return { executablePath: verified.executablePath, executableIdentity: verified.identity }; }
    catch { /* 继续查下一个受控目录 */ }
  }
  throw new Error("无法解析 Codex CLI 所需的 node 解释器。 ");
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

/** 仅把经验证 node 所在目录加入最小 PATH。 */
export function nodeRuntimeDirectory(node: VerifiedNodeRuntime): string { return dirname(node.executablePath); }

function safeShell(value: string | null): "/bin/zsh" | "/bin/bash" {
  return value === "/bin/bash" ? "/bin/bash" : "/bin/zsh";
}
