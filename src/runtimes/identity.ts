import { access, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import type { ExecutableIdentity } from "./types";

/** 已检查的常规可执行文件。 */
export type VerifiedExecutable = { readonly executablePath: string; readonly identity: ExecutableIdentity };

/** 校验绝对路径、realpath 最终目标、常规文件与当前用户可执行权限。 */
export async function verifyExecutable(path: string): Promise<VerifiedExecutable> {
  if (!isAbsolute(path)) throw new Error("CLI 路径必须是绝对路径。 ");
  const executablePath = await realpath(path).catch(() => { throw new Error("CLI 可执行文件不存在或无法解析。 "); });
  const info = await lstat(executablePath).catch(() => { throw new Error("CLI 可执行文件不可读取。 "); });
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("CLI 必须是 realpath 后的常规文件。 ");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("CLI 可执行文件不属于当前用户。 ");
  await access(executablePath, constants.X_OK).catch(() => { throw new Error("CLI 文件不可执行。 "); });
  return { executablePath, identity: { device: Number(info.dev), inode: Number(info.ino), size: info.size, modifiedAtMs: info.mtimeMs } };
}

/** 启动前完整身份检查；变化交由Registry同路径完整复验，路径目标改变仍需用户确认。 */
export async function verifyExecutableIdentity(path: string, expected: ExecutableIdentity): Promise<VerifiedExecutable> {
  const current = await verifyExecutable(path);
  if(current.executablePath!==path)throw new Error("CLI 路径目标已变化，需要用户确认。 ");
  const actual = current.identity;
  if (actual.device !== expected.device || actual.inode !== expected.inode || actual.size !== expected.size || actual.modifiedAtMs !== expected.modifiedAtMs) throw new Error("CLI 文件已变化，需要重新验证。 ");
  return current;
}
