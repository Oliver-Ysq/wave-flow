import type { CapabilitySnapshot, CapabilityStatus } from "../adapters/capabilities";

/** 注入命令执行器，使环境探测可在测试中覆盖缺失和无结论情形。 */
export type CapabilityCommandRunner = {
  /** 尝试执行固定的只读探测命令；返回退出码或抛出启动/超时异常。 */
  run(command: string, args: readonly string[], timeoutMs: number): Promise<{ readonly exitCode: number }>;
};

/** 创建当前 Bun 环境的最小能力快照；未实现的产品能力必须保持 unavailable 或 unknown。 */
export async function probeCapabilities(runner: CapabilityCommandRunner = bunCommandRunner, timeoutMs = 3_000): Promise<CapabilitySnapshot> {
  const tmux = await probeCommand(runner, "tmux", ["-V"], timeoutMs);
  const codex = await probeCommand(runner, "codex", ["--version"], timeoutMs);
  return {
    version: 1,
    host: { platform: process.platform, tmux: { status: tmux, persistentSessions: "unavailable" } },
    adapters: {
      codex: {
        status: codex,
        interactiveSession: "unavailable",
        verifiedPromptDelivery: "unavailable",
        persistentTmuxSession: "unavailable",
        sandbox: { readOnly: "unknown", workspaceWrite: "unknown" },
      },
    },
  };
}

async function probeCommand(runner: CapabilityCommandRunner, command: string, args: readonly string[], timeoutMs: number): Promise<CapabilityStatus> {
  try {
    const result = await withTimeout(runner.run(command, args, timeoutMs), timeoutMs);
    return result.exitCode === 0 ? "available" : "unavailable";
  } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    return code === "ENOENT" ? "unavailable" : "unknown";
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("probe timeout"), { code: "ETIMEDOUT" })), timeoutMs); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

const bunCommandRunner: CapabilityCommandRunner = {
  async run(command, args, timeoutMs) {
    const process = Bun.spawn([command, ...args], { stdout: "ignore", stderr: "ignore" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exitCode = await Promise.race([
        process.exited,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("probe timeout"), { code: "ETIMEDOUT" })), timeoutMs); }),
      ]);
      return { exitCode };
    } catch (error) {
      process.kill();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
};
