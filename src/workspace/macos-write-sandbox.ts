import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, normalize, relative } from "node:path";
import { WorkflowContractError } from "../workflow/errors";

/** Engine 提供的主控 OS 写边界；不是 Workflow JavaScript sandbox。 */
export type MacosWriteBoundary = {
  /** 本 session 私有 scratch 目录；控制端点与运行目录位于其中。 */
  readonly scratch: string;
  /** 仅开放 Engine 已创建的会话私有控制端点（Unix socket），不开放其父目录。 */
  readonly controlFiles: readonly string[];
  /** 主工作区与 Engine 状态目录；默认允许写，但这些子树保持只读。 */
  readonly protectedDirectories: readonly string[];
};

/**
 * 生成继承到全部后代的主控 Seatbelt 写策略。
 *
 * 语义：默认允许写，只拒绝受保护目录（当前项目与 Engine 状态目录），并显式放行
 * 会话 scratch，保证 MCP 控制 socket 与本会话运行目录仍可写。末尾拒绝受保护目录
 * 自身的 unlink/rename，阻止删除或移动项目根与状态根。硬链接是路径沙箱的已知
 * 逃逸面，因此全局禁止新建硬链接；主控不需要硬链接能力。
 *
 * 该策略只用于主控会话。Worker 按可信原生 CLI 权限运行，不消费此边界。
 */
export async function macosWriteProfile(boundary: MacosWriteBoundary): Promise<string> {
  if (process.platform !== "darwin") throw new WorkflowContractError("受管写隔离当前仅验证 macOS，其他平台拒绝启动。");
  const normalized = normalizeSystemTmp(boundary);
  const protectedDirectories = [...new Set(normalized.protectedDirectories)];
  if (protectedDirectories.length === 0) throw new WorkflowContractError("主控写边界必须声明受保护目录，拒绝以全盘可写启动。");
  for (const path of [normalized.scratch, ...protectedDirectories]) await canonical(path, true);
  // 受保护目录落在 scratch 内时，后面的 allow scratch 会覆盖 deny；必须拒绝这种边界。
  for (const path of protectedDirectories) if (inside(normalized.scratch, path)) throw new WorkflowContractError("会话 scratch 不得覆盖受保护目录，拒绝启动。");
  const files: string[] = [];
  for (const path of normalized.controlFiles) {
    await canonical(path, false);
    files.push(`(literal ${quote(path)})`);
  }
  const denied = protectedDirectories.map(path => `(subpath ${quote(path)})`).join(" ");
  const unlinked = protectedDirectories.map(path => `(literal ${quote(path)})`).join(" ");
  const allowed = [`(subpath ${quote(normalized.scratch)})`, ...files].join(" ");
  return `(version 1)\n(allow default)\n(deny file-write* ${denied})\n(allow file-write* ${allowed})\n(deny file-write-unlink ${unlinked})\n(deny file-link)\n`;
}

async function canonical(path: string, directory: boolean): Promise<void> {
  if (!isAbsolute(path) || path === "/" || /[\x00-\x1f\x7f]/.test(path)) throw new WorkflowContractError("写边界路径无效。");
  const info = await lstat(path);
  // 私有控制端点是 Unix domain socket 文件；保留 FIFO 只为兼容旧边界声明。
  if (info.isSymbolicLink() || await realpath(path) !== path || (directory && !info.isDirectory()) || (!directory && !info.isFIFO() && !info.isSocket())) throw new WorkflowContractError("写边界必须使用 canonical 真实目录或私有控制端点。");
}

function normalizeSystemTmp(boundary: MacosWriteBoundary): MacosWriteBoundary {
  const canonicalPath = (path: string) => path.startsWith("/tmp/") ? `/private/tmp/${path.slice(5)}` : path;
  return { scratch: canonicalPath(boundary.scratch), controlFiles: boundary.controlFiles.map(canonicalPath), protectedDirectories: boundary.protectedDirectories.map(canonicalPath) };
}

function inside(a: string, b: string): boolean { const path = relative(a, b); return path === "" || (path !== ".." && !path.startsWith("../") && !isAbsolute(path)); }
function quote(path: string): string { return JSON.stringify(path); }
