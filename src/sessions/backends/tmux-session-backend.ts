import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CreateSessionOptions, DestroyResult, SessionBackend, SessionIdentity, SessionLiveness } from "../types";
import { TmuxCommandClient } from "./tmux-command";

/** P0 唯一生产会话后端：只使用 Wave Flow 私有 tmux socket，不接管用户默认 tmux server。 */
export class TmuxSessionBackend implements SessionBackend {
  constructor(private readonly client: TmuxCommandClient, private readonly destroyPollMs = 100, private readonly destroyTimeoutMs = 3_000) {}

  /** 创建 detached tmux 会话，并注入 identity 环境变量作为后续重新绑定证据。 */
  async create(options: CreateSessionOptions): Promise<SessionIdentity> {
    if (options.command.length === 0) throw new Error("tmux 会话创建需要 command argv。");
    const identity: SessionIdentity = {
      backend: "tmux",
      sessionName: opaqueSessionName(options.runId),
      backendRef: this.client.socketPath,
      runId: options.runId,
      nodeId: options.nodeId,
      agentSessionId: crypto.randomUUID(),
      cli: options.cli,
      createdAt: new Date().toISOString(),
      identityFile: options.identityFile,
    };
    await this.client.createSession(identity.sessionName, options.cwd, {
      ...options.env,
      WF_BACKEND: "tmux",
      WF_RUN_ID: identity.runId,
      WF_NODE_ID: identity.nodeId,
      WF_AGENT_SESSION_ID: identity.agentSessionId,
      WF_CLI: identity.cli,
    }, shellCommand(options.command));
    if (identity.identityFile) {
      try {
        await writeIdentity(identity.identityFile, identity);
      } catch (error) {
        try { await this.client.killSession(identity.sessionName); } catch {}
        throw error;
      }
    }
    return identity;
  }

  /** 通过 tmux private buffer 发送原始文本，不把文本拼入 shell 命令。 */
  async sendText(identity: SessionIdentity, text: string): Promise<void> {
    await this.requireMatchingIdentity(identity);
    await this.client.pasteText(identity.sessionName, `wf-${crypto.randomUUID()}`, text);
  }

  /** 捕获近期屏幕作为诊断；绝不根据文本改变业务节点状态。 */
  async readRecent(identity: SessionIdentity, lines = 200): Promise<string> {
    await this.requireMatchingIdentity(identity);
    return this.client.capture(identity.sessionName, Math.max(1, Math.min(lines, 10_000)));
  }

  /** 存活探测同时验证 session 存在性和 injected identity。 */
  async liveness(identity: SessionIdentity): Promise<SessionLiveness> {
    if (identity.backend !== "tmux" || identity.backendRef !== this.client.socketPath) return "unknown";
    const live = await this.client.liveness(identity.sessionName);
    if (live !== "exists") return live;
    const values = await Promise.all([
      this.client.environment(identity.sessionName, "WF_BACKEND"),
      this.client.environment(identity.sessionName, "WF_RUN_ID"),
      this.client.environment(identity.sessionName, "WF_NODE_ID"),
      this.client.environment(identity.sessionName, "WF_AGENT_SESSION_ID"),
      this.client.environment(identity.sessionName, "WF_CLI"),
    ]);
    return values[0] === "tmux" && values[1] === identity.runId && values[2] === identity.nodeId && values[3] === identity.agentSessionId && values[4] === identity.cli ? "exists" : "unknown";
  }

  /** detached tmux 会话没有观察者需要断开；该操作是幂等 no-op。 */
  async detach(_identity: SessionIdentity): Promise<void> {}

  /** 请求中断并等待明确 missing；无结论时保留 identity，禁止误报已销毁。 */
  async destroy(identity: SessionIdentity): Promise<DestroyResult> {
    const live = await this.liveness(identity);
    if (live === "missing") { await removeIdentity(identity); return { status: "destroyed", diagnostic: null }; }
    if (live === "unknown") return { status: "termination-unconfirmed", diagnostic: "tmux 会话身份无法验证，拒绝销毁。" };
    try { await this.client.interrupt(identity.sessionName); } catch (error) { return { status: "termination-unconfirmed", diagnostic: error instanceof Error ? error.message : String(error) }; }
    const deadline = Date.now() + this.destroyTimeoutMs;
    while (Date.now() < deadline) {
      await delay(this.destroyPollMs);
      const current = await this.client.liveness(identity.sessionName);
      if (current === "missing") { await removeIdentity(identity); return { status: "destroyed", diagnostic: null }; }
      if (current === "unknown") return { status: "termination-unconfirmed", diagnostic: "tmux 终结探测无结论。" };
    }
    return { status: "termination-unconfirmed", diagnostic: "tmux 会话在中断后未确认退出。" };
  }

  private async requireMatchingIdentity(identity: SessionIdentity): Promise<void> {
    const live = await this.liveness(identity);
    if (live !== "exists") throw new Error(`tmux 会话不可安全使用：${live}`);
  }
}

function opaqueSessionName(runId: string): string {
  return `wf-${runId.replaceAll("-", "").slice(0, 8)}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function shellCommand(argv: readonly string[]): string { return argv.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" "); }

async function writeIdentity(path: string, identity: SessionIdentity): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function removeIdentity(identity: SessionIdentity): Promise<void> {
  if (!identity.identityFile) return;
  try { await unlink(identity.identityFile); } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code !== "ENOENT") throw error;
  }
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
