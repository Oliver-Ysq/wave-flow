import type { AcpLauncher } from "../adapters/acp-session";
import { CODEX_ACP_ADAPTER } from "./codex-runtime-validator";
import { codexAcpAdapterEntry } from "./codex-acp-entry";
import { createWorkerEnvironment } from "./worker-environment";
import type { RuntimeProvenance, VerifiedCliRuntime } from "./types";

/** 将已复核的用户 CLI 与固定 adapter 组合为唯一可启动 ACP Launcher。 */
export function resolveCodexAcpLauncher(runtime: VerifiedCliRuntime): AcpLauncher {
  const entry = codexAcpAdapterEntry();
  return { id: CODEX_ACP_ADAPTER.id, command: entry.command, args: entry.args, env: createWorkerEnvironment(runtime) };
}

/** 写入 Journal 的安全来源信息；不含文件身份、PATH 或任何环境变量。 */
export function runtimeProvenance(runtime: VerifiedCliRuntime): RuntimeProvenance {
  return { runtimeId: runtime.runtimeId, cli: runtime.cli, executablePath: runtime.executablePath, version: runtime.version, adapterId: runtime.verifiedAdapter.adapterId, adapterVersion: runtime.verifiedAdapter.adapterVersion, verifiedAt: runtime.verifiedAt };
}
