import type { AgentNodeSnapshot } from "../runtime/run-types";
import type { SessionIdentity } from "../sessions/types";
import type { AgentCli } from "../shared/workflow-types";

/** 由 Session Bootstrap 交给一个正常交互式 CLI Adapter 的节点启动请求。 */
export type InteractiveCliStartRequest = {
  /** 所属 Run 的稳定 UUID；必须与随后创建的 SessionIdentity 匹配。 */
  readonly runId: string;
  /** 已进入启动阶段的节点快照；Adapter 只可消费其中已规范化的 CLI、cwd、sandbox、model 与任务。 */
  readonly node: AgentNodeSnapshot;
  /** 首条任务 Prompt；不得由 Bootstrap 拼入 shell 或解释为终端控制序列。 */
  readonly prompt: string;
  /** 会话 identity 的耐久文件路径；由 SessionBackend 在确认销毁后清理。 */
  readonly identityFile: string;
};

/** Adapter 交给 SessionBackend 的正常 CLI 启动计划。 */
export type InteractiveCliLaunchPlan = {
  /** 正常交互 CLI 的完整 argv；不得是 exec、print 或其他一次性模式。 */
  readonly command: readonly string[];
  /** 仅注入该受管会话的环境；不能携带 Workflow 作者任意环境变量。 */
  readonly env?: Readonly<Record<string, string>>;
};

/** Adapter 对“现在是否允许提交首条 Prompt”的专属判断。 */
export type PromptReadyEvidence = {
  /** true 仅代表可进入本 Adapter 的 submit 步骤，不代表节点完成或模型已处理任务。 */
  readonly ready: boolean;
  /** Adapter 专属的稳定诊断；不得由 Runtime 从 ANSI 或自然语言合成。 */
  readonly diagnostic: string;
};

/** Adapter 对首条 Prompt 是否实际被 CLI 接收的可审计结论。 */
export type PromptSubmissionEvidence = {
  /** true 仅在 Adapter 的原生、可测试确认策略成功时成立。 */
  readonly submitted: boolean;
  /** 形成结论的 Adapter 专属证据类别；launch-argv 本身不能证明 submitted。 */
  readonly proof: "native-history" | "native-hook" | "native-rpc" | "unconfirmed";
  /** CLI 原生会话身份；无可证明关联时省略，不能臆造。 */
  readonly cliSessionId?: string;
  /** 面向 Journal 与诊断的稳定说明。 */
  readonly diagnostic: string;
};

/**
 * 正常交互式 CLI 的专属边界。
 *
 * Bootstrap 只安排这四步，绝不持有任一 CLI 的屏幕模式、历史文件或 Hook 协议。未来
 * Claude Code、TraeX 必须各自实现本接口并提供独立的可验证 evidence，不能复用 Codex
 * 的内部文件或把终端文本当作通用正确性信号。
 */
export interface InteractiveCliAdapter {
  /** 稳定 Adapter 名称，仅用于诊断和注册；不自动扩展 Workflow 作者 API 的 cli 可选值。 */
  readonly id: string;
  /** 此 Adapter 当前可承载的 Workflow CLI；Bootstrap 必须拒绝不匹配的节点，防止错用启动参数或提交证据。 */
  readonly cli: AgentCli;
  /** 根据受控节点输入构造正常交互 CLI 的启动 argv。 */
  launch(request: InteractiveCliStartRequest): InteractiveCliLaunchPlan;
  /** 等待本 CLI 专属的可提交条件；不满足时返回 ready: false。 */
  waitUntilReady(request: InteractiveCliStartRequest, identity: SessionIdentity): Promise<PromptReadyEvidence>;
  /** 以本 CLI 专属方式提交首条 Prompt；只在 ready: true 后调用。 */
  submitInitialPrompt(request: InteractiveCliStartRequest, identity: SessionIdentity): Promise<void>;
  /** 使用本 CLI 的原生证据确认提交；无法证明时必须返回 submitted: false。 */
  confirmInitialPrompt(request: InteractiveCliStartRequest, identity: SessionIdentity): Promise<PromptSubmissionEvidence>;
}
