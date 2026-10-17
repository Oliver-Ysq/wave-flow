import { lstat, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { WorkflowContractError } from "../workflow/errors";

/** 宿主创建会话独立运行目录；主控和Worker共用，不依赖CLI名称或业务状态。
 * stateRoot由Engine指定，先验证无项目重叠和父路径链接，再创建；拒绝时不写业务目录。
 */
export async function prepareSessionScratch(stateRoot: string, cwd: string): Promise<string> {
  if (!isAbsolute(stateRoot) || normalize(stateRoot) !== stateRoot || stateRoot === "/") throw new WorkflowContractError("会话私有运行根路径无效。");
  const project = await realpath(cwd);
  let ancestor = stateRoot;
  while (true) {
    try {
      const resolved = await realpath(ancestor);
      if (resolved !== ancestor) throw new WorkflowContractError("会话私有运行根的父目录不可为符号链接。");
      break;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; ancestor = dirname(ancestor); }
  }
  if (stateRoot === project || stateRoot.startsWith(`${project}/`) || project.startsWith(`${stateRoot}/`)) throw new WorkflowContractError("会话私有运行根目录与项目重叠。");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(stateRoot), info = await lstat(stateRoot);
  if (info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid()) || root !== stateRoot) throw new WorkflowContractError("会话私有运行根目录不安全。");
  return realpath(await mkdtemp(join(root, "session-")));
}
