import { DAEMON_PROTOCOL_VERSION, readFreshDescriptor, readFreshDescriptorProtocol, readIncompatibleFreshDescriptor, type DaemonDescriptor } from "./daemon-descriptor";
import { runtimeRoot } from "../journal/paths";

/** 已通过 descriptor 与 health 双重校验的全局 daemon 地址。 */
export type ConnectedDaemon = { readonly baseUrl: string; readonly descriptor: DaemonDescriptor };

/** daemon 发现/启动过程中的可验证步骤；CLI 仅在实际完成后展示。 */
export type DaemonEnsureProgress = (message: string) => void;

/** 发现或启动当前用户唯一 daemon；客户端退出不停止后台进程。 */
export async function ensureGlobalDaemon(timeoutMs = 10_000, progress?: DaemonEnsureProgress): Promise<ConnectedDaemon> {
  progress?.("检查 daemon descriptor、heartbeat、PID 启动身份与 /health…");
  const existing = await discoverDaemon();
  if (existing) {
    progress?.(`已验证并复用 daemon（PID ${existing.descriptor.pid}）。`);
    return existing;
  }
  const legacyProtocol = await readFreshDescriptorProtocol();
  if (legacyProtocol !== null && legacyProtocol !== DAEMON_PROTOCOL_VERSION) throw new Error(`现有 Wave Flow daemon 协议版本为 ${legacyProtocol}，当前 CLI 需要 ${DAEMON_PROTOCOL_VERSION}；请先停止旧 daemon 后重试。`);
  const incompatibleProtocol = await readIncompatibleFreshDescriptor();
  if (incompatibleProtocol !== null) throw new Error(`检测到协议版本为 ${incompatibleProtocol} 但 descriptor 格式过旧的 Wave Flow daemon；请先停止旧 daemon 后重试。`);
  const entry = new URL("./daemon-main.ts", import.meta.url).pathname;
  progress?.("未发现可复用 daemon，启动新的 loopback daemon…");
  const child = Bun.spawn([process.execPath, entry], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await discoverDaemon();
    if (found) {
      progress?.(`已完成 heartbeat、PID 启动身份和 /health 验证（PID ${found.descriptor.pid}）。`);
      return found;
    }
    await delay(50);
  }
  throw new Error("Wave Flow 全局 daemon 未在时限内完成健康启动。");
}

/** 读取候选 descriptor 后必须 health 握手；descriptor 本身不可信。 */
export async function discoverDaemon(
  root = runtimeRoot(),
  readProcessStartIdentity: (pid: number) => Promise<string> = currentProcessStartIdentity,
): Promise<ConnectedDaemon | null> {
  const descriptor = await readFreshDescriptor(root);
  if (!descriptor) return null;
  const baseUrl = `http://127.0.0.1:${descriptor.port}`;
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
    const health = await response.json() as Partial<DaemonDescriptor>;
    if (!response.ok || health.protocolVersion !== descriptor.protocolVersion || health.userIdentity !== descriptor.userIdentity || health.bootInstanceId !== descriptor.bootInstanceId) return null;
    if (await readProcessStartIdentity(descriptor.pid).catch(() => null) !== descriptor.processStartIdentity) return null;
    return { baseUrl, descriptor };
  } catch { return null; }
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

/** 连接前复核 descriptor 中 PID 的启动身份，防止 PID 被复用后误连无关进程。 */
async function currentProcessStartIdentity(pid: number): Promise<string> {
  const child = Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const output = (await new Response(child.stdout).text()).trim();
  if (await child.exited !== 0 || !output) throw new Error("daemon 进程启动身份不可读取。");
  return output;
}
