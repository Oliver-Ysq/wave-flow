import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/** 验证 Run UUID，阻止状态目录路径穿越。 */
export function validateRunId(runId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
    throw new Error("Run id 必须是 Runtime 创建的 UUID。");
  }
}

/** 返回当前用户的 Wave Flow 状态根目录；Run 档案不得放在任一项目或 Agent cwd。 */
export function waveFlowHome(): string { return join(homedir(), ".wave-flow"); }

/** 返回用户级 Run 档案根目录。root 仅供测试注入，生产调用不传。 */
export function runsRoot(root = waveFlowHome()): string { return join(root, "runs"); }

/** 返回用户级 daemon 运行目录。root 仅供测试注入，生产调用不传。 */
export function runtimeRoot(root = waveFlowHome()): string { return join(root, "runtime"); }

/** 返回指定 Run 的耐久目录，且保证不逃出 runs 根目录。 */
export function runDirectory(root: string, runId: string): string {
  validateRunId(runId);
  const resolvedRoot = resolve(root);
  const directory = resolve(resolvedRoot, runId);
  const fromRoot = relative(resolvedRoot, directory);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error("Run 目录超出状态根目录。");
  return directory;
}

/** 为任意合法 node id 生成稳定的安全目录名，不直接用用户 id 作为路径。 */
export function nodeDirectoryName(nodeId: string): string {
  return createHash("sha256").update(nodeId).digest("hex");
}
