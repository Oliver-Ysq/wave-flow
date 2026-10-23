import { access, constants, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** Worker 环境保证包含的系统目录；与 worker-environment 的最小 PATH 语义保持一致。 */
const ESSENTIAL_PATH_DIRECTORIES = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;

/** 可执行文件名只允许常规命令名；含路径分隔符的声明不参与 PATH 查找。 */
const SAFE_BIN = /^[A-Za-z0-9._+-]+$/;

/**
 * 计算技能依赖诊断使用的 PATH。
 *
 * 只读诊断：优先使用 Engine 当前 PATH，并补上 Worker 环境保证包含的系统目录。
 * 它不包含各 CLI 自己的 node 目录，因此结果只用于提示“当前可见 PATH 中缺失”，
 * 不声称覆盖任意 Worker 的完整环境。
 */
export function skillDependencyPath(pathValue: string | undefined = process.env.PATH): string {
  const entries = (pathValue ?? "").split(":").filter(item => isAbsolute(item));
  return [...new Set([...entries, ...ESSENTIAL_PATH_DIRECTORIES])].join(":");
}

/**
 * 返回在给定 PATH 中找不到（或不是可执行文件）的 required bins。
 *
 * 不安装、不修改 PATH、不访问网络；找不到时只返回名称供界面提示。
 */
export async function missingRequiredBins(bins: readonly string[], pathValue: string = skillDependencyPath()): Promise<readonly string[]> {
  if (bins.length === 0) return [];
  const directories = pathValue.split(":").filter(item => isAbsolute(item));
  const missing: string[] = [];
  for (const bin of bins) {
    if (!SAFE_BIN.test(bin)) { missing.push(bin); continue; }
    let found = false;
    for (const directory of directories) {
      const candidate = join(directory, bin);
      try {
        const info = await stat(candidate);
        if (!info.isFile()) continue;
        await access(candidate, constants.X_OK);
        found = true; break;
      } catch { /* 继续下一个目录。 */ }
    }
    if (!found) missing.push(bin);
  }
  return missing;
}
