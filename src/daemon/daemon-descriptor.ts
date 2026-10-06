import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runtimeRoot } from "../journal/paths";
import { waveFlowHome } from "../journal/paths";

/** 当前后台发现协议版本；不匹配的 descriptor 绝不复用。 */
export const DAEMON_PROTOCOL_VERSION = 2;
const HEARTBEAT_STALE_MS = 15_000;

/** 仅用于发现候选 daemon 的私有 descriptor，不能作为任何 Control 授权。 */
export type DaemonDescriptor = {
  readonly protocolVersion: 2;
  readonly userIdentity: string;
  readonly bootInstanceId: string;
  readonly port: number;
  readonly pid: number;
  /** 操作系统报告的进程启动时间；与 pid 一起防止 PID 被复用后误连。 */
  readonly processStartIdentity: string;
  readonly heartbeatAt: string;
};

/** 当前 OS 用户的稳定、非敏感身份文本。 */
export function daemonUserIdentity(): string {
  return typeof process.getuid === "function" ? `uid:${process.getuid()}` : `user:${process.env.USER ?? "unknown"}`;
}

export function descriptorPath(root = runtimeRoot()): string { return join(root, "daemon.json"); }
export function lockPath(root = runtimeRoot()): string { return join(root, "daemon.lock"); }

/** 创建安全 runtime 目录；用户目录、软链接或宽权限均拒绝。 */
export async function ensureDaemonRuntimeRoot(root = runtimeRoot()): Promise<void> {
  if (resolve(root) === resolve(runtimeRoot())) await ensurePrivateStateHome();
  const created = await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Wave Flow daemon 运行目录必须是真实目录。");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("Wave Flow daemon 运行目录不属于当前用户。");
  if ((info.mode & 0o077) !== 0) throw new Error("Wave Flow daemon 运行目录权限过宽。");
  // 已存在且权限已安全的目录无需 chmod。部分受 ACL 管理的用户目录会拒绝
  // 这类无意义元数据修改；继续尝试会让 daemon 无法启动。
  if (created !== undefined) await chmod(root, 0o700);
}

/** runtime 子目录创建前先验证 ~/.wave-flow 本身，避免 mkdir 跟随父级软链接。 */
async function ensurePrivateStateHome(): Promise<void> {
  const home = waveFlowHome();
  const created = await mkdir(home, { recursive: true, mode: 0o700 });
  const info = await lstat(home);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Wave Flow 状态根目录必须是真实目录。");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("Wave Flow 状态根目录不属于当前用户。");
  if ((info.mode & 0o077) !== 0) throw new Error("Wave Flow 状态根目录权限过宽。");
  if (created !== undefined) await chmod(home, 0o700);
}

/** 原子发布本 daemon descriptor；每次 heartbeat 都覆盖完整文件。 */
export async function publishDescriptor(descriptor: DaemonDescriptor, root = runtimeRoot()): Promise<void> {
  await ensureDaemonRuntimeRoot(root);
  const path = descriptorPath(root);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(descriptor)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

/** 读取候选 descriptor；损坏、权限错误、旧 heartbeat 都不作为可复用 daemon。 */
export async function readFreshDescriptor(root = runtimeRoot(), now = Date.now()): Promise<DaemonDescriptor | null> {
  try {
    const runtime = await lstat(root);
    if (!runtime.isDirectory() || runtime.isSymbolicLink() || (runtime.mode & 0o077) !== 0 || (typeof process.getuid === "function" && runtime.uid !== process.getuid())) return null;
    const path = descriptorPath(root);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid())) return null;
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isDescriptor(value)) return null;
    if (value.protocolVersion !== DAEMON_PROTOCOL_VERSION || value.userIdentity !== daemonUserIdentity()) return null;
    if (now - Date.parse(value.heartbeatAt) > HEARTBEAT_STALE_MS) return null;
    return value;
  } catch { return null; }
}

/** 读取仍新鲜的 descriptor 协议版本，只用于给旧 daemon 提供升级诊断，不用于连接或授权。 */
export async function readFreshDescriptorProtocol(root = runtimeRoot(), now = Date.now()): Promise<number | null> {
  try {
    const runtime = await lstat(root);
    if (!runtime.isDirectory() || runtime.isSymbolicLink() || (runtime.mode & 0o077) !== 0 || (typeof process.getuid === "function" && runtime.uid !== process.getuid())) return null;
    const path = descriptorPath(root);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid())) return null;
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (!Number.isSafeInteger(value.protocolVersion) || value.userIdentity !== daemonUserIdentity() || typeof value.heartbeatAt !== "string" || now - Date.parse(value.heartbeatAt) > HEARTBEAT_STALE_MS) return null;
    return value.protocolVersion as number;
  } catch { return null; }
}

/**
 * 读取仍活跃但不满足当前 descriptor 格式的旧记录。
 * 仅用于把“新 daemon 拿不到旧锁”的超时，转换为可操作的升级诊断；绝不用于连接。
 */
export async function readIncompatibleFreshDescriptor(root = runtimeRoot(), now = Date.now()): Promise<number | null> {
  try {
    const runtime = await lstat(root);
    if (!runtime.isDirectory() || runtime.isSymbolicLink() || (runtime.mode & 0o077) !== 0 || (typeof process.getuid === "function" && runtime.uid !== process.getuid())) return null;
    const info = await lstat(descriptorPath(root));
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid())) return null;
    const value = JSON.parse(await readFile(descriptorPath(root), "utf8")) as Record<string, unknown>;
    if (!Number.isSafeInteger(value.protocolVersion) || value.userIdentity !== daemonUserIdentity() || typeof value.heartbeatAt !== "string" || now - Date.parse(value.heartbeatAt) > HEARTBEAT_STALE_MS) return null;
    return isDescriptor(value) ? null : value.protocolVersion as number;
  } catch { return null; }
}

/** 优雅退出仅删除自身仍拥有的 descriptor，防止旧 daemon 删除新记录。 */
export async function removeOwnDescriptor(bootInstanceId: string, root = runtimeRoot()): Promise<void> {
  const descriptor = await readFreshDescriptor(root);
  if (descriptor?.bootInstanceId !== bootInstanceId) return;
  try { await unlink(descriptorPath(root)); } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code !== "ENOENT") throw error;
  }
}

/** daemon 启动互斥记录；启动身份用于安全识别崩溃遗留的 lock。 */
type DaemonLock = { readonly pid: number; readonly processStartIdentity: string; readonly bootInstanceId: string };

/** 取得单实例启动锁；已确认失效的旧 lock 才能移除，未知归属一律拒绝。 */
export async function acquireDaemonLock(bootInstanceId: string, root = runtimeRoot()): Promise<boolean> {
  await ensureDaemonRuntimeRoot(root);
  const path = lockPath(root);
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      const value: DaemonLock = { pid: process.pid, processStartIdentity: await processStartIdentity(process.pid), bootInstanceId };
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    } catch (error) {
      await handle.close();
      try { await unlink(path); } catch {}
      throw error;
    }
    await handle.close();
    await chmod(path, 0o600);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code !== "EEXIST") throw error;
  }
  const previous = await readLock(path);
  if (!previous) throw new Error("Wave Flow daemon 启动锁损坏或权限不安全，拒绝接管。");
  const status = await processStatus(previous.pid, previous.processStartIdentity);
  if (status === "dead") {
    await removeOwnLock(previous.bootInstanceId, root);
    return acquireDaemonLock(bootInstanceId, root);
  }
  if (status === "unknown") throw new Error("无法验证现有 Wave Flow daemon 启动锁所属进程，拒绝接管。");
  return false;
}

/** 优雅退出仅删除当前 daemon 自己的锁。 */
export async function removeOwnLock(bootInstanceId: string, root = runtimeRoot()): Promise<void> {
  const path = lockPath(root);
  const lock = await readLock(path);
  if (lock?.bootInstanceId !== bootInstanceId) return;
  try { await unlink(path); } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code !== "ENOENT") throw error;
  }
}

async function readLock(path: string): Promise<DaemonLock | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) return null;
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    return Number.isSafeInteger(item.pid) && (item.pid as number) > 0 && typeof item.processStartIdentity === "string" && item.processStartIdentity !== "" && typeof item.bootInstanceId === "string" && item.bootInstanceId !== "" ? item as DaemonLock : null;
  } catch { return null; }
}

/** macOS/Unix 以 ps 启动时间防 PID 复用；无法验证时 fail closed。 */
export async function processStartIdentity(pid: number): Promise<string> {
  const child = Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const code = await child.exited;
  const output = (await new Response(child.stdout).text()).trim();
  if (code !== 0 || !output) throw new Error("daemon 进程不存在或启动身份不可读取。");
  return output;
}

async function processStatus(pid: number, expected: string): Promise<"live" | "dead" | "unknown"> {
  try {
    const child = Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
    const code = await child.exited;
    const output = (await new Response(child.stdout).text()).trim();
    // 仅 macOS 已验证的 code=1 + 无输出可证明 PID 已死。其他非零码在 sandbox、
    // 权限受限或 ps 异常时均可能出现，必须 fail-closed，不能误删未知 daemon 锁。
    if (code === 1 && !output) return "dead";
    if (code !== 0 || !output) return "unknown";
    return output === expected ? "live" : "dead";
  } catch { return "unknown"; }
}

function isDescriptor(value: unknown): value is DaemonDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.protocolVersion === DAEMON_PROTOCOL_VERSION && typeof item.userIdentity === "string" && item.userIdentity !== "" && typeof item.bootInstanceId === "string" && item.bootInstanceId !== "" && Number.isSafeInteger(item.port) && (item.port as number) > 0 && (item.port as number) <= 65_535 && Number.isSafeInteger(item.pid) && (item.pid as number) > 0 && typeof item.processStartIdentity === "string" && item.processStartIdentity !== "" && typeof item.heartbeatAt === "string" && !Number.isNaN(Date.parse(item.heartbeatAt));
}
