import { homedir } from "node:os";
import { dirname } from "node:path";
import { CLI_VERSION_TIMEOUT_CODE, readCliVersion } from "./cli-version";
import { systemCliInstallDirectories, versionManagerBinDirectories } from "./install-dirs";

/** 一次探测的共享截止时间；与 Orca `PREFLIGHT_COMMAND_TIMEOUT_MS` 同值。 */
export const CLI_PROBE_TIMEOUT_MS = 5_000;

/** 每个 CLI 最多探测的候选数；与 Orca `PREFLIGHT_LOCAL_PROBE_LIMIT` 同值。 */
export const CLI_PROBE_LIMIT = 4;

/**
 * 候选可运行性结论。
 * - `available`：某个候选能跑 `--version`，binary/version 有效。
 * - `absent`：可执行文件不存在（例如手动路径已被删除）。
 * - `timeout`：共享预算耗尽，无法判断（不等于不存在）。
 * - `exec_failed`：候选都跑起来了但全部失败（坏二进制、缺依赖）。
 * - `limit_reached`：候选数超过上限且前几个都不可用，后续未探测。
 */
export type CliProbeStatus = "available" | "absent" | "timeout" | "exec_failed" | "limit_reached";

/** 探测结果；`binary` 为实际被判定/最后探测的候选，供诊断与后续完整验证使用。 */
export type CliProbeResult = {
  readonly status: CliProbeStatus;
  readonly binary: string | null;
  readonly version: string | null;
  /** 本次实际探测的候选数。 */
  readonly probed: number;
};

function probeTimedOut(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === CLI_VERSION_TIMEOUT_CODE;
}

function probeMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

/**
 * 按发现顺序找到第一个能运行的候选。
 *
 * 语义移植自 Orca `probeRunnableLocalCommand`（src/main/ipc/preflight-command-exec.ts）：
 * 候选上限 4 个；健康候选使用完整共享预算；一旦有候选超时，才开一份新的补救预算
 * 并按剩余候选均分，避免一个慢 wrapper 把后面的候选全部饿死；超时与“不存在”
 * 必须分开返回，不能把探测失败折叠成“未安装”。
 */
export async function probeFirstRunnable(binaries: readonly string[]): Promise<CliProbeResult> {
  const probes = binaries.slice(0, CLI_PROBE_LIMIT);
  if (probes.length === 0) return { status: "absent", binary: null, version: null, probed: 0 };
  // wrapper 常用 `#!/usr/bin/env node` 找运行时；node 可能只存在于 nvm 或系统安装目录，
  // 探测时要把这些目录放进最小 PATH，否则能把可用的 CLI 误判成 exec_failed。
  const nodeDirectories = await runtimePathDirectories();
  const deadline = Date.now() + CLI_PROBE_TIMEOUT_MS;
  let recoveryDeadline: number | undefined;
  let timedOutBinary: string | null = null;
  let probed = 0;
  for (const [index, binary] of probes.entries()) {
    const remainingMs = (recoveryDeadline ?? deadline) - Date.now();
    if (remainingMs <= 0) return { status: "timeout", binary, version: null, probed };
    const timeoutMs = recoveryDeadline
      ? Math.max(1, Math.floor(remainingMs / (probes.length - index)))
      : remainingMs;
    probed += 1;
    try {
      // 候选自身目录加入 PATH：wrapper 常用 `#!/usr/bin/env node` 找旁边的运行时。
      return { status: "available", binary, version: await readCliVersion(binary, "CLI", [dirname(binary), ...(nodeDirectories ?? [])], timeoutMs), probed };
    } catch (error) {
      if (probeTimedOut(error)) { timedOutBinary = binary; recoveryDeadline ??= Date.now() + CLI_PROBE_TIMEOUT_MS; continue; }
      if (probeMissing(error)) return { status: "absent", binary, version: null, probed };
    }
  }
  if (timedOutBinary) return { status: "timeout", binary: timedOutBinary, version: null, probed };
  return {
    status: binaries.length > CLI_PROBE_LIMIT ? "limit_reached" : "exec_failed",
    binary: probes.at(-1) ?? null,
    version: null,
    probed,
  };
}

/** 把探测结论转成用户能行动的说明；扫描无结果时展示，替代过去静默吞掉原因。 */
export function describeProbeStatus(status: CliProbeStatus): string {
  switch (status) {
    case "available": return "可用";
    case "absent": return "未找到可执行文件";
    case "timeout": return "探测超时，无法确认是否已安装";
    case "exec_failed": return "程序无法运行（--version 失败）";
    case "limit_reached": return `候选超过 ${CLI_PROBE_LIMIT} 个且前几个都不可用`;
  }
}

/** 探测用的最小运行时目录：系统 CLI 安装目录 + nvm 版本目录。 */
async function runtimePathDirectories(): Promise<readonly string[]> {
  const home = process.env.HOME ?? homedir();
  return [...systemCliInstallDirectories(process.platform, home), ...(home ? await versionManagerBinDirectories(home) : [])];
}
