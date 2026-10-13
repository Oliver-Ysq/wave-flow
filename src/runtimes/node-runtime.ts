import { dirname } from "node:path";
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
  if (code !== 0 || !path) throw new Error("无法解析 Codex CLI 所需的 node 解释器。 ");
  const verified = await verifyExecutable(path);
  return { executablePath: verified.executablePath, executableIdentity: verified.identity };
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
