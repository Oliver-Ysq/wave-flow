import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { homedir } from "node:os";
import { WorkflowContractError } from "../workflow/errors";

/** Engine 提供的 OS 写边界；不是 Workflow JavaScript sandbox，也不授权外部资源。 */
export type MacosWriteBoundary = {
  /** 主控固定null，不存在业务工作区/Git写例外。 */
  readonly workspace: null;
  /** 本session私有scratch目录；不默认开放用户HOME/CLI配置/系统tmp。 */
  readonly scratch: string;
  /** Adapter声明的当前CLI原生可写目录；缺省空，禁止Home根/软链接/与业务及Engine目录重叠。 */
  readonly cliWritableRoots?: readonly string[];
  /** 仅开放Engine已创建的session私有FIFO端点，不开放其父目录。 */
  readonly controlFiles: readonly string[];
  /** 位于可写目录内但必须保持只读的配置、认证引用或子树；deny优先于父级allow。 */
  readonly readOnlyPaths?: readonly string[];
  /** 主工作区及共享Git目录，任何可写目录不得覆盖它们。 */
  readonly protectedDirectories: readonly string[];
};

/** 生成继承到全部后代的macOS Seatbelt写策略；不可验证环境拒绝而非扩大权限。 */
export async function macosWriteProfile(boundary: MacosWriteBoundary): Promise<string> {
  if (process.platform !== "darwin") throw new WorkflowContractError("受管写隔离当前仅验证macOS，其他平台拒绝启动。");
  const nativeRoots = boundary.cliWritableRoots ?? [];
  const writable = [boundary.scratch, ...nativeRoots];
  for (const path of nativeRoots) {
    if (path === homedir() || path === dirname(boundary.scratch) || overlaps(path, boundary.scratch)) throw new WorkflowContractError("CLI原生目录不得覆盖Home根、业务工作区或会话目录。");
  }
  for (const path of [...writable, ...boundary.protectedDirectories]) {
    await canonical(path, true);
  }
  for (const path of writable) for (const protectedPath of boundary.protectedDirectories) {
    if (overlaps(path, protectedPath)) throw new WorkflowContractError("可写目录与主工作区/Git元数据重叠，拒绝启动。");
  }
  const files = [];
  for (const path of boundary.controlFiles) { await canonical(path, false); files.push(`(literal ${quote(path)})`); }
  const denied = [];
  const pinned = new Set<string>();
  for (const path of boundary.readOnlyPaths ?? []) {
    if (!isAbsolute(path) || normalize(path) !== path || /[\x00-\x1f\x7f]/.test(path)) throw new WorkflowContractError("只读例外路径无效。");
    // 固定可写根内全部祖先，避免移动父目录后在原路径重建配置绕过deny。
    for (let parent = dirname(path); writable.some(root => inside(root, parent)); parent = dirname(parent)) {
      pinned.add(parent);
      if (dirname(parent) === parent) break;
    }
    let info;
    try { info = await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      let parent = dirname(path);
      while (true) {
        try { await lstat(parent); break; }
        catch (parentError) { if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") throw parentError; parent = dirname(parent); }
      }
      if (await realpath(parent) !== parent) throw new WorkflowContractError("只读例外父目录不安全。");
      // 配置或插件目录可不存在，仍禁止其创建及子路径写入，不能由CLI自行补工具通道。
      denied.push(`(literal ${quote(path)})`, `(subpath ${quote(path)})`); continue;
    }
    if (info.isSymbolicLink()) {
      const target = await realpath(path);
      if (writable.some(root => inside(root, target))) throw new WorkflowContractError("只读引用指向可写运行目录，拒绝启动。");
      denied.push(`(literal ${quote(path)})`);
    }
    else if (info.isDirectory() && await realpath(path) === path) {
      await rejectHardlinkedProtectedFiles(path, writable);
      denied.push(`(subpath ${quote(path)})`, `(literal ${quote(path)})`);
    }
    else if (info.isFile() && await realpath(path) === path) {
      // Seatbelt按路径授权；启动前已存在的可写硬链接别名会指向同一inode并绕过literal deny。
      // 无法枚举本机全部别名时只能拒绝多链接保护文件，不能把配置/凭据安全寄托于路径名。
      if (info.nlink !== 1) throw new WorkflowContractError("只读配置或认证文件存在硬链接别名，拒绝启动。");
      denied.push(`(literal ${quote(path)})`);
    }
    else throw new WorkflowContractError("只读例外必须为canonical常规文件、目录或明确符号链接。");
  }
  return `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (literal "/dev/null") ${writable.map(path => `(subpath ${quote(path)})`).join(" ")} ${files.join(" ")})\n${denied.length ? `(deny file-write* ${denied.join(" ")})\n` : ""}${pinned.size ? `(deny file-write-unlink ${[...pinned].map(path => `(literal ${quote(path)})`).join(" ")})\n` : ""}`;
}

/** 只读目录也不能藏有可写别名；不跟随符号链接，最多核验10000项，超限拒绝而非略过。 */
async function rejectHardlinkedProtectedFiles(root: string, writable: readonly string[]): Promise<void> {
  const pending = [root]; let checked = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const name of await readdir(directory)) {
      if (++checked > 10000) throw new WorkflowContractError("只读目录现场超出安全核验上限，拒绝启动。");
      const path = join(directory, name), info = await lstat(path);
      if (info.isFile() && info.nlink !== 1) throw new WorkflowContractError("只读配置或认证文件存在硬链接别名，拒绝启动。");
      if (info.isSymbolicLink()) {
        const target = await realpath(path);
        if (writable.some(root => inside(root, target))) throw new WorkflowContractError("只读引用指向可写运行目录，拒绝启动。");
      }
      if (info.isDirectory() && !info.isSymbolicLink()) pending.push(path);
    }
  }
}

async function canonical(path: string, directory: boolean): Promise<void> {
  if (!isAbsolute(path) || path === "/" || /[\x00-\x1f\x7f]/.test(path)) throw new WorkflowContractError("写边界路径无效。");
  const info = await lstat(path);
  if (info.isSymbolicLink() || await realpath(path) !== path || (directory && !info.isDirectory()) || (!directory && !info.isFIFO())) throw new WorkflowContractError("写边界必须使用canonical真实目录或私有FIFO。");
}
function overlaps(a: string, b: string): boolean { return inside(a, b) || inside(b, a); }
function inside(a: string, b: string): boolean { const path = relative(a, b); return path === "" || (path !== ".." && !path.startsWith("../") && !isAbsolute(path)); }
function quote(path: string): string { return JSON.stringify(path); }
