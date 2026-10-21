import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * 没有版本管理器时 CLI 的常见安装落点。
 *
 * 目录与优先级移植自 Orca `getSystemCliInstallDirectories`
 * （src/shared/system-cli-install-dirs.ts）：Homebrew 两个前缀、npm 默认全局前缀、
 * nix、以及各 CLI 自带安装器；并按本项目 CLI 的真实位置补充
 * `~/.kimi-code/bin`、`~/.npm-global/bin`、`~/.bun/bin`、`~/.volta/bin` 与
 * ChatGPT.app 内嵌 Codex；claude 与 dsh 主要由 npm 全局前缀及 nvm 枚举覆盖。
 * 只在 PATH 完全找不到该 CLI 时兜底，不参与优先级排序，
 * 避免把系统目录抬到用户已选的 PATH 前面。
 */
export function systemCliInstallDirectories(platform: NodeJS.Platform, homePath: string): string[] {
  if (platform === "win32") return [];
  const directories: string[] = [];
  if (platform === "darwin") directories.push("/opt/homebrew/bin");
  directories.push("/usr/local/bin");
  if (platform === "linux") directories.push("/snap/bin", "/home/linuxbrew/.linuxbrew/bin");
  directories.push(
    "/nix/var/nix/profiles/default/bin",
    join(homePath, ".nix-profile", "bin"),
    join(homePath, ".local", "bin"),
    join(homePath, ".npm-global", "bin"),
    join(homePath, ".bun", "bin"),
    join(homePath, ".volta", "bin"),
    join(homePath, ".kimi-code", "bin"),
  );
  // ChatGPT 桌面端自带 Codex CLI，是常见安装器路径之一。
  if (platform === "darwin") directories.push("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS");
  return directories;
}

/** nvm 的全局 bin 随 node 版本变化，只能枚举；枚举失败视为没有该版本管理器。 */
export async function versionManagerBinDirectories(homePath: string, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  if (platform === "win32") return [];
  const root = join(homePath, ".nvm", "versions", "node");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name, "bin"));
}
