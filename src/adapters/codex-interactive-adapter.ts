import type { SessionIdentity } from "../sessions/types";
import type { AgentSandbox } from "../shared/workflow-types";
import type { InteractiveCliAdapter, InteractiveCliLaunchPlan, InteractiveCliStartRequest, PromptReadyEvidence, PromptSubmissionEvidence } from "./interactive-cli-adapter";

/** Codex 启动请求是通用交互式 Adapter 请求的别名，保留为公开导入兼容名。 */
export type CodexInteractiveStartRequest = InteractiveCliStartRequest;

/**
 * Codex 正常交互式启动 Adapter。
 *
 * 它只负责受控 argv 及 SessionBackend 创建，绝不解析 TUI 文本、判断完成状态或替 Runtime
 * 更改节点状态。Codex 没有稳定的 composer-ready/submit 回执时，不能把 session 存活误称为
 * Prompt 已被模型接收；调用方必须检查标准化提交 evidence 并 fail closed。
 */
export class CodexInteractiveAdapter implements InteractiveCliAdapter {
  readonly id = "codex";
  readonly cli = "codex" as const;
  constructor(private readonly codexCommand = "codex") {}

  /** 构造正常交互式 Codex argv；显式拒绝一次性 exec、print 和危险 sandbox。 */
  commandFor(request: Pick<CodexInteractiveStartRequest, "node" | "prompt">): readonly string[] {
    const { node, prompt } = request;
    if (node.cli !== "codex") throw new Error("Codex Adapter 只能启动 cli: codex 节点。");
    if (typeof prompt !== "string" || prompt.trim() === "") throw new Error("Codex 初始 Prompt 必须为非空字符串。");
    const sandbox = codexSandbox(node.sandbox);
    const command = [this.codexCommand, "--sandbox", sandbox, "--cd", node.cwd, "--no-alt-screen"];
    if (node.request.model) command.push("--model", node.request.model);
    // `codex [PROMPT]` 是官方正常交互入口；不要改用 `codex exec` 或启动后盲目 paste。
    command.push(prompt);
    return command;
  }

  /** 将 Codex 的位置参数启动策略暴露为通用 Adapter LaunchPlan。 */
  launch(request: CodexInteractiveStartRequest): InteractiveCliLaunchPlan { return { command: this.commandFor(request) }; }

  /** Prompt 已作为启动位置参数交给 CLI，因此没有可等待的 TUI 输入焦点。 */
  async waitUntilReady(_request: CodexInteractiveStartRequest, _identity: SessionIdentity): Promise<PromptReadyEvidence> {
    return { ready: true, diagnostic: "Codex 首条 Prompt 已包含在正常交互启动 argv 中，无需 TUI paste。" };
  }

  /** 启动参数已携带 Prompt；这里刻意不写 tmux，避免把任务重复投递到未知 TUI 焦点。 */
  async submitInitialPrompt(_request: CodexInteractiveStartRequest, _identity: SessionIdentity): Promise<void> {}

  /** 4.4.1 未读取 Codex 专属历史或 Hook，因此明确返回未确认，而不是猜测。 */
  async confirmInitialPrompt(_request: CodexInteractiveStartRequest, _identity: SessionIdentity): Promise<PromptSubmissionEvidence> {
    return { submitted: false, proof: "unconfirmed", diagnostic: "Codex 已以正常交互 argv 启动；当前没有可验证的 Codex Prompt 接收回执。" };
  }

}

function codexSandbox(value: AgentSandbox): "read-only" | "workspace-write" {
  if (value === "read-only" || value === "workspace-write") return value;
  throw new Error("Codex Adapter 只允许 read-only 或 workspace-write sandbox。");
}
