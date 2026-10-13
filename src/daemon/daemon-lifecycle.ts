import { DAEMON_PROTOCOL_VERSION, processStartIdentity, readFreshDaemonCandidate, readFreshDescriptor, readFreshDescriptorProtocol, readIncompatibleFreshDescriptor, removeDeadDaemonArtifacts, type DaemonDescriptor } from "./daemon-descriptor";
import { isAbsolute } from "node:path";
import { runtimeRoot } from "../journal/paths";

/** 已通过 descriptor 与 health 双重校验的全局 daemon 地址。 */
export type ConnectedDaemon = { readonly baseUrl: string; readonly descriptor: DaemonDescriptor };

/** daemon 发现/启动过程中的可验证步骤；CLI 仅在实际完成后展示。 */
export type DaemonEnsureProgress = (message: string) => void;

/** 发现或启动当前用户唯一 daemon；客户端退出不停止后台进程。 */
export async function ensureGlobalDaemon(timeoutMs = 10_000, progress?: DaemonEnsureProgress, daemonExecutable?: string, daemonEnv?: Readonly<Record<string, string>>, expectedWebBuildId?: string): Promise<ConnectedDaemon> {
  progress?.("检查 daemon descriptor、heartbeat、PID 启动身份与 /health…");
  const existing = await discoverDaemon(undefined, undefined, expectedWebBuildId);
  if (existing) {
    progress?.(`已验证并复用 daemon（PID ${existing.descriptor.pid}）。`);
    return existing;
  }
  // 桌面升级页靠“协议版本”子串识别可升级旧 daemon（见 web/src/main.tsx）；
  // 改动这两条诊断文案时必须同步检查该契约，否则用户只会看到无操作的启动超时。
  const legacyProtocol = await readFreshDescriptorProtocol();
  if (legacyProtocol !== null && legacyProtocol !== DAEMON_PROTOCOL_VERSION) throw new Error(`现有 Wave Flow daemon 协议版本为 ${legacyProtocol}，当前版本需要 ${DAEMON_PROTOCOL_VERSION}；请在桌面端确认升级重启，或先停止旧 daemon 后重试。`);
  const legacy = await readFreshDaemonCandidate();
  if (legacy && expectedWebBuildId && legacy.webBuildId !== expectedWebBuildId) throw new Error("现有 Wave Flow daemon 的 Web 构建版本与桌面应用不一致；请在桌面端确认升级重启。");
  const incompatibleProtocol = await readIncompatibleFreshDescriptor();
  if (incompatibleProtocol !== null) throw new Error(`检测到协议版本为 ${incompatibleProtocol} 但 descriptor 格式过旧的 Wave Flow daemon；请先停止旧 daemon 后重试。`);
  if (daemonExecutable !== undefined && !isAbsolute(daemonExecutable)) throw new Error("桌面 daemon sidecar 必须使用绝对路径。");
  const entry = new URL("./daemon-main.ts", import.meta.url).pathname;
  progress?.("未发现可复用 daemon，启动新的 loopback daemon…");
  const child = Bun.spawn(daemonExecutable ? [daemonExecutable] : [process.execPath, entry], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true, ...(daemonEnv ? { env: { ...process.env, ...daemonEnv } } : {}) });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await discoverDaemon(undefined, undefined, expectedWebBuildId);
    if (found) {
      progress?.(`已完成 heartbeat、PID 启动身份和 /health 验证（PID ${found.descriptor.pid}）。`);
      return found;
    }
    await delay(50);
  }
  throw new Error("Wave Flow 全局 daemon 未在时限内完成健康启动。");
}

/**
 * 桌面端用户明确确认升级后才调用。旧 daemon 必须先以自身 loopback API 优雅退出；
 * 身份、health 或关闭接口无法验证时 fail closed，绝不盲目杀进程。
 */
export async function restartGlobalDaemon(timeoutMs = 20_000, daemonExecutable?: string, daemonEnv?: Readonly<Record<string, string>>, expectedWebBuildId?: string): Promise<ConnectedDaemon> {
  const current = await discoverDaemon();
  if (current) await requestVerifiedDaemonClose(current.descriptor, current.baseUrl);
  else {
    // 当前协议不可复用时，仍给字段齐全的旧协议 daemon 一次受控优雅退出机会；
    // 无法验证身份的旧 daemon 会在下面的遗留清理等待中原样暴露，绝不接管。
    const legacy = await readFreshDaemonCandidate();
    if (legacy) await requestVerifiedDaemonClose(legacy, `http://127.0.0.1:${legacy.port}`);
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await removeDeadDaemonArtifacts()) break;
    await delay(50);
  }
  if (!await removeDeadDaemonArtifacts()) throw new Error("旧 daemon 未在确认时间内退出；为保护运行任务，拒绝启动第二个后台服务。 ");
  return ensureGlobalDaemon(timeoutMs, undefined, daemonExecutable, daemonEnv, expectedWebBuildId);
}

/** 读取候选 descriptor 后必须 health 握手；descriptor 本身不可信。 */
export async function discoverDaemon(
  root = runtimeRoot(),
  readProcessStartIdentity: (pid: number) => Promise<string> = currentProcessStartIdentity,
  expectedWebBuildId?: string,
): Promise<ConnectedDaemon | null> {
  const descriptor = await readFreshDescriptor(root);
  if (!descriptor) return null;
  const baseUrl = `http://127.0.0.1:${descriptor.port}`;
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
    const health = await response.json() as Partial<DaemonDescriptor>;
    if (!response.ok || health.protocolVersion !== descriptor.protocolVersion || health.webBuildId !== descriptor.webBuildId || health.userIdentity !== descriptor.userIdentity || health.bootInstanceId !== descriptor.bootInstanceId || (expectedWebBuildId !== undefined && descriptor.webBuildId !== expectedWebBuildId)) return null;
    if (await readProcessStartIdentity(descriptor.pid).catch(() => null) !== descriptor.processStartIdentity) return null;
    return { baseUrl, descriptor };
  } catch { return null; }
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function requestVerifiedDaemonClose(candidate: { readonly pid: number; readonly processStartIdentity: string; readonly bootInstanceId: string; readonly userIdentity: string }, baseUrl: string): Promise<void> {
  if (await currentProcessStartIdentity(candidate.pid).catch(() => null) !== candidate.processStartIdentity) throw new Error("daemon 身份在重启前发生变化，拒绝关闭。 ");
  const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) }).then(response => response.ok ? response.json() as Promise<Partial<DaemonDescriptor>> : null).catch(() => null);
  if (!health || health.bootInstanceId !== candidate.bootInstanceId || health.userIdentity !== candidate.userIdentity) throw new Error("daemon 健康身份无法确认，拒绝关闭。 ");
  const response = await fetch(`${baseUrl}/daemon/close`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(1_000) });
  if (!response.ok) throw new Error("现有 daemon 不支持受控重启；为保护任务，未终止后台服务。 ");
}

/** 连接前复核 descriptor 中 PID 的启动身份，防止 PID 被复用后误连无关进程。 */
async function currentProcessStartIdentity(pid: number): Promise<string> {
  const child = Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const output = (await new Response(child.stdout).text()).trim();
  if (await child.exited !== 0 || !output) throw new Error("daemon 进程启动身份不可读取。");
  return output;
}
