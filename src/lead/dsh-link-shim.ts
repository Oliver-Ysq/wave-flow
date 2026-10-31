import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AcpLauncher } from "../adapters/acp-session";
import { WorkflowContractError } from "../workflow/errors";

/**
 * DSH 0.2.1-rc.2 的 JSONL 会话持久化用 `link(tmp, final)` 原子发布。
 * macOS 感知沙箱全局禁止 `file-link`，因此 session/new 会以 EPERM 失败。
 * 该预加载 shim 只对 `$DSH_HOME`（缺省 `~/.dsh`）下的 link 调用改为
 * `COPYFILE_EXCL | COPYFILE_FICLONE` 发布：不创建硬链接，不允许覆盖已有文件，
 * APFS 上是 clone，其他文件系统由 Node 回退为普通复制。沙箱策略保持不变。
 */
const DSH_LINK_SHIM_SOURCE = String.raw`const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const originalLink = fsp.link;
const dshHome = process.env.DSH_HOME && path.isAbsolute(process.env.DSH_HOME)
  ? process.env.DSH_HOME
  : path.join(os.homedir(), ".dsh");
const root = path.resolve(dshHome);
const inside = (value) => {
  if (typeof value !== "string" || !path.isAbsolute(value)) return false;
  const resolved = path.resolve(value);
  return resolved === root || resolved.startsWith(root + path.sep);
};

fsp.link = async (existingPath, newPath) => {
  if (!inside(existingPath) || !inside(newPath)) return originalLink(existingPath, newPath);
  const source = await fsp.stat(existingPath);
  await fsp.copyFile(existingPath, newPath, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
  await fsp.chmod(newPath, source.mode & 0o777);
  const handle = await fsp.open(newPath, "r");
  try { await handle.sync(); } finally { await handle.close(); }
};
`;

/**
 * 为 DSH 主控会话写入 Node 预加载 shim，并把 `--require` 追加到 NODE_OPTIONS。
 *
 * 只在 macOS 主控写边界（沙箱禁止 file-link）下调用。shim 位于会话私有 scratch，
 * 0600，随会话清理。
 *
 * @param launcher 已经过 Registry 复核的 DSH launcher；调用方保证 id 为 `dsh-acp`。
 * @param scratch 当前会话私有目录，必须已存在且可写。
 * @returns 带 NODE_OPTIONS 的新 launcher；不修改入参。
 */
export async function prepareDshLinkShim(launcher: AcpLauncher, scratch: string): Promise<AcpLauncher> {
  const file = join(scratch, "dsh-link-shim.cjs");
  if (/[\x00-\x1f\x7f"]/.test(file)) throw new WorkflowContractError("DSH shim 路径包含无法安全传入 NODE_OPTIONS 的字符。");
  await writeFile(file, DSH_LINK_SHIM_SOURCE, { mode: 0o600 });
  const required = `--require=${JSON.stringify(file)}`;
  const existing = launcher.env?.NODE_OPTIONS?.trim();
  return { ...launcher, env: { ...launcher.env, NODE_OPTIONS: existing ? `${existing} ${required}` : required } };
}
