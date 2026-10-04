import type { InteractiveCliAdapter, InteractiveCliStartRequest, PromptReadyEvidence, PromptSubmissionEvidence } from "../../adapters/interactive-cli-adapter";
import type { DestroyResult, SessionBackend, SessionIdentity } from "../types";

/** Bootstrap 成功创建的会话及首条 Prompt 的标准化证据。 */
export type BootstrappedInteractiveSession = {
  /** 已经与 run/node/cli 身份绑定的会话。 */
  readonly identity: SessionIdentity;
  /** Adapter 给出的 ready 结论；不携带 TUI 原始文本。 */
  readonly ready: PromptReadyEvidence;
  /** Adapter 给出的提交确认结论；submitted 为 false 时 Bootstrap fail closed。 */
  readonly submission: PromptSubmissionEvidence;
};

/** Bootstrap 失败时保留的会话终结证据，防止错误掩盖潜在存活会话。 */
export class InteractiveCliBootstrapError extends Error {
  constructor(message: string, readonly destroy: DestroyResult | null) { super(message); }
}

/**
 * 编排受控会话创建与 Adapter 专属 Ready/Submit/Confirm Gate。
 *
 * 它不解析终端、不修改业务状态，也不接受任意 CLI 参数；未确认首条任务提交时会清理刚创建的
 * 会话并抛错。destroy 无法确认时，错误会保留该事实，调用方不得创建替代 Agent。
 */
export class InteractiveCliBootstrap {
  /**
   * @param gateTimeoutMs 每个异步 Gate 的最长等待毫秒数；默认 15 秒。超时会销毁新会话并以未确认失败，
   * 不允许无限占用 tmux/CLI 资源。
   */
  constructor(private readonly sessions: SessionBackend, private readonly gateTimeoutMs = 15_000) {
    if (!Number.isFinite(gateTimeoutMs) || gateTimeoutMs <= 0) throw new Error("交互 CLI Gate 超时必须是正的有限毫秒数。");
  }

  /** 创建会话，按 Adapter 的顺序完成首条 Prompt 提交并要求原生确认。 */
  async start(adapter: InteractiveCliAdapter, request: InteractiveCliStartRequest): Promise<BootstrappedInteractiveSession> {
    if (adapter.cli !== request.node.cli) {
      throw new InteractiveCliBootstrapError(`${adapter.id} Adapter 不能启动 cli: ${request.node.cli} 节点。`, null);
    }
    const plan = await withinTimeout((signal) => adapter.launch(request, signal), this.gateTimeoutMs, "launch");
    if (plan.command.length === 0) throw new InteractiveCliBootstrapError(`${adapter.id} Adapter 未提供正常交互 CLI 启动命令。`, null);
    const identity = await this.sessions.create({
      runId: request.runId,
      nodeId: request.node.id,
      agentSessionId: request.node.agentSessionId ?? undefined,
      cli: request.node.cli,
      cwd: request.node.cwd,
      command: plan.command,
      env: plan.env,
      identityFile: request.identityFile,
    });
    try {
      assertIdentityMatchesRequest(identity, request);
      const ready = await withinTimeout((signal) => adapter.waitUntilReady(request, plan, identity, signal), this.gateTimeoutMs, "ready");
      if (!ready.ready) throw new Error(`首条 Prompt 尚未就绪：${ready.diagnostic}`);
      await withinTimeout((signal) => adapter.submitInitialPrompt(request, plan, identity, signal), this.gateTimeoutMs, "submit");
      const submission = await withinTimeout((signal) => adapter.confirmInitialPrompt(request, plan, identity, signal), this.gateTimeoutMs, "confirm");
      assertSubmissionIsBound(submission);
      return { identity, ready, submission };
    } catch (error) {
      const destroy = await this.sessions.destroy(identity).catch((destroyError) => ({
        status: "termination-unconfirmed" as const,
        diagnostic: destroyError instanceof Error ? destroyError.message : String(destroyError),
      }));
      const message = error instanceof Error ? error.message : String(error);
      throw new InteractiveCliBootstrapError(`${adapter.id} 交互会话启动失败：${message}`, destroy);
    }
  }
}

/** 创建返回值必须仍属于请求的 Run、节点和 CLI；否则不能将其交给 Adapter 操作。 */
function assertIdentityMatchesRequest(identity: SessionIdentity, request: InteractiveCliStartRequest): void {
  if (identity.runId !== request.runId || identity.nodeId !== request.node.id || identity.cli !== request.node.cli) {
    throw new Error("SessionBackend 返回的会话身份与请求的 Run、节点或 CLI 不匹配。");
  }
}

/** 已确认的提交必须携带可关联的 CLI 原生会话身份；否则同机其他会话的证据可能被误认。 */
function assertSubmissionIsBound(submission: PromptSubmissionEvidence): void {
  if (!submission.submitted || submission.proof === "unconfirmed") throw new Error(`首条 Prompt 未获确认：${submission.diagnostic}`);
  if (!submission.cliSessionId?.trim()) throw new Error("首条 Prompt 确认缺少可关联的 CLI 原生会话身份。");
}

/** 为单个 Adapter Gate 设置硬超时，避免卡死的 CLI 探测泄漏受管会话。 */
function withinTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, stage: "launch" | "ready" | "submit" | "confirm"): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`首条 Prompt ${stage} Gate 超时。`));
    }, timeoutMs);
  });
  return Promise.race([operation(controller.signal), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
    controller.abort();
  });
}
