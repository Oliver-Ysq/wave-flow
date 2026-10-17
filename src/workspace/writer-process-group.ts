import { WorkflowContractError } from "../workflow/errors";

/** 本Engine真实启动的进程组，不接受manifest恢复的PID作为新writer。 */
export type OwnedWriterProcess = {
  /** 本次detached启动的进程组leader PID，必须大于1。 */
  readonly pid: number;
  /** 实际子进程退出Promise；不是ACP回合结束。 */
  readonly exited: Promise<unknown>;
  /** 请求终止整个进程组；不得仅取消ACP会话。 */
  terminate(): void;
};

/** writer退出证明登记簿；只有本实例登记且leader/进程组都退出才能移交租约。 */
export class WriterProcessGroups {
  #owned = new Map<string, { process: OwnedWriterProcess; leaderExited: boolean }>();
  #verifiedExited = new Set<string>();
  constructor(
    /** POSIX kill(-pgid,0)成功代表仍存在；EPERM未知，不能解释成已退出。 */
    private readonly groupExists: (pid: number) => boolean = exists,
  ) {}

  /** 在启动成功后立即登记；返回随机证明身份，稳定PID不作为授权凭证。 */
  register(process: OwnedWriterProcess): string {
    if (!Number.isInteger(process.pid) || process.pid <= 1) throw new WorkflowContractError("writer进程组PID无效。");
    const identity = crypto.randomUUID(); const record = { process, leaderExited: false };
    this.#owned.set(identity, record);
    // 非零退出也证明leader结束，但仍需独立核对组内子进程。
    void process.exited.then(() => { record.leaderExited = true; }, () => { record.leaderExited = true; });
    return identity;
  }

  /** 检查真实退出；重启或未知身份永远false，不按旧PID推测。
   * 进程组一旦验证消失，保留该身份的退出证明，PID后续复用不污染旧租约。
   */
  hasExited(identity: string): boolean {
    if (this.#verifiedExited.has(identity)) return true;
    const record = this.#owned.get(identity);
    if (!record || !record.leaderExited) return false;
    if (this.groupExists(record.process.pid)) return false;
    this.#verifiedExited.add(identity);
    return true;
  }

  /** 请求终止并在有界时间内核验整个组；超时保留身份与锁，调用者不得保存Git。 */
  async closeAndVerify(identity: string, timeoutMs = 5_000): Promise<void> {
    const record = this.#owned.get(identity);
    if (!record || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new WorkflowContractError("writer身份或退出预算无效。");
    if (this.hasExited(identity)) return;
    record.process.terminate();
    const deadline = Date.now() + timeoutMs;
    while (!this.hasExited(identity)) {
      if (Date.now() >= deadline) throw new WorkflowContractError("writer进程组未确认退出；保留锁与现场。");
      await Bun.sleep(Math.min(20, Math.max(1, deadline - Date.now())));
    }
  }
}

function exists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM" && process.platform === "darwin") {
      // macOS组内sandbox子进程可能不可signal；只读全进程表可核对组是否实际仍存在。
      // 仅用于本Engine登记且leader已退出的组，不根据旧manifest PID认领。
      const result = Bun.spawnSync(["/bin/ps", "-axo", "pgid="], { stdout: "pipe", stderr: "pipe", timeout: 1_000 });
      if (result.exitCode === 0) {
        const rows = new TextDecoder().decode(result.stdout).trim().split(/\s+/);
        if (rows.every(row => /^\d+$/.test(row))) return rows.includes(String(pid));
      }
    }
    throw new WorkflowContractError("writer进程组不可核验；禁止按PID猜测退出。");
  }
}
