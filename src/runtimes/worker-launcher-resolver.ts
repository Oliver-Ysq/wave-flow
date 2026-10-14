import type { AcpLauncher } from "../adapters/acp-session";
import { adapterById } from "./adapter-catalog";
import type { RuntimeProvenance, VerifiedCliRuntime } from "./types";

/** 将已复核的用户 CLI 与 Adapter Catalog 中的固定 adapter 组合为唯一可启动 ACP Launcher。 */
export function resolveWorkerLauncher(runtime: VerifiedCliRuntime): AcpLauncher {
  const entry = adapterById(runtime.verifiedAdapter.adapterId);
  if (!entry || entry.cli !== runtime.cli) throw new Error(`CLI Runtime 的 adapter ${runtime.verifiedAdapter.adapterId} 不可用。 `);
  const launcher = entry.launcher(runtime);
  return { id: entry.adapterId, command: launcher.command, args: launcher.args, env: entry.environment(runtime) };
}

/** 主控 Harness 的 launcher 解析；与 Worker 同为 Adapter Catalog 分发的泛型实现。 */
export function resolveHarnessLauncher(runtime: VerifiedCliRuntime): AcpLauncher {
  return resolveWorkerLauncher(runtime);
}

/** 旧名保留以避免扩散 diff；语义同 resolveHarnessLauncher，已不再限定 Codex。 */
export function resolveCodexAcpLauncher(runtime: VerifiedCliRuntime): AcpLauncher {
  return resolveHarnessLauncher(runtime);
}

/** 写入 Journal 的安全来源信息；不含文件身份、PATH 或任何环境变量。 */
export function runtimeProvenance(runtime: VerifiedCliRuntime): RuntimeProvenance {
  return { runtimeId: runtime.runtimeId, cli: runtime.cli, executablePath: runtime.executablePath, version: runtime.version, adapterId: runtime.verifiedAdapter.adapterId, adapterVersion: runtime.verifiedAdapter.adapterVersion, verifiedAt: runtime.verifiedAt };
}
