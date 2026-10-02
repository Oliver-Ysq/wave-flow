import type { CapabilitySnapshot, CapabilityStatus } from "../adapters/capabilities";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateTmuxSocketPath, TmuxCommandClient, type TmuxCommandRunner } from "../sessions/backends/tmux-command";

/** 注入命令执行器，使环境探测可在测试中覆盖缺失和无结论情形。 */
export type CapabilityCommandRunner = {
  /** 尝试执行固定的只读探测命令；返回退出码或抛出启动/超时异常。 */
  run(command: string, args: readonly string[], timeoutMs: number, stdin?: string): Promise<{ readonly exitCode: number; readonly stdout?: string; readonly stderr?: string }>;
};

/** 创建当前 Bun 环境的最小能力快照；未实现的产品能力必须保持 unavailable 或 unknown。 */
export async function probeCapabilities(runner: CapabilityCommandRunner = bunCommandRunner, timeoutMs = 3_000): Promise<CapabilitySnapshot> {
  const tmux = await probeCommand(runner, "tmux", ["-V"], timeoutMs);
  const codex = await probeCommand(runner, "codex", ["--version"], timeoutMs);
  const persistentSessions = tmux === "available" ? await probePrivateTmuxSession(runner, timeoutMs) : tmux;
  return {
    version: 1,
    host: { platform: process.platform, tmux: { status: tmux, persistentSessions } },
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

async function probePrivateTmuxSession(runner: CapabilityCommandRunner, timeoutMs: number): Promise<CapabilityStatus> {
  const directory = await mkdtemp(join(tmpdir(), "wave-flow-capabilities-"));
  const socket = privateTmuxSocketPath(join(directory, "runtime"), "probe");
  const client = new TmuxCommandClient(socket, {
    run: async (args, limit, stdin) => {
      const result = await runner.run("tmux", args, limit, stdin);
      return { exitCode: result.exitCode, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
  }, timeoutMs);
  const session = `wf-probe-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const marker = `wf-capability-${crypto.randomUUID()}`;
  let created = false;
  try {
    await client.createSession(session, directory, { WF_BACKEND: "tmux" }, "while IFS= read -r line; do printf '%s\\n' \"$line\"; done");
    created = true;
    if (await client.liveness(session) !== "exists") return "unknown";
    await client.pasteText(session, `wf-probe-${crypto.randomUUID()}`, `${marker}\n`);
    if (!(await client.capture(session, 20)).includes(marker)) return "unknown";
    await client.killSession(session);
    created = false;
    return (await client.liveness(session)) === "missing" ? "available" : "unknown";
  } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    return code === "ENOENT" ? "unavailable" : "unknown";
  } finally {
    if (created) {
      try { await client.killSession(session); } catch {}
    }
    try { await client.closePrivateServer(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
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
  async run(command, args, timeoutMs, stdin) {
    const process = Bun.spawn([command, ...args], { stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
    if (stdin !== undefined) {
      if (!process.stdin) throw new Error("capability probe stdin pipe 不可用。");
      process.stdin.write(stdin);
      process.stdin.end();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exitCode = await Promise.race([
        process.exited,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("probe timeout"), { code: "ETIMEDOUT" })), timeoutMs); }),
      ]);
      return { exitCode, stdout: await new Response(process.stdout).text(), stderr: await new Response(process.stderr).text() };
    } catch (error) {
      process.kill();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
};
