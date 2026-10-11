/** Harness 会话的耐久状态；它不等同于 Workflow Run 完成状态。 */
export type HarnessStatus = "idle" | "running" | "interrupted";

/** 用户或完整主控消息；reasoning delta 永不进入此类型。 */
export type HarnessMessage = {
  /** 稳定消息标识，用于界面 key 与分页去重。 */
  readonly id: string;
  /** 消息来源；assistant 只在完整文本耐久后出现。 */
  readonly role: "user" | "assistant";
  /** 可展示的正文；不得包含模型 key 或未完成 reasoning。 */
  readonly text: string;
  /** 耐久写入时间。 */
  readonly createdAt: string;
};

/** 一个可恢复读取、但不认领原生 Pi session 的主控会话快照。 */
export type HarnessSnapshot = {
  /** Harness Run UUID。 */
  readonly harnessRunId: string;
  /** 已验证的项目 cwd。 */
  readonly cwd: string;
  /** 当前对话回合状态。 */
  readonly status: HarnessStatus;
  /** 最近一条 turn 的诊断；正常 idle 时为 null。 */
  readonly diagnostic: string | null;
  /** 创建时间。 */
  readonly createdAt: string;
  /** 当前已耐久的完整消息。 */
  readonly messages: readonly HarnessMessage[];
  /** 已耐久的 Workflow 草案；接受仅冻结 revision，不代表已创建或执行 Worker Run。 */
  readonly workflowRevisions: readonly WorkflowRevision[];
};

/** 主控会话中的不可变 workflow.ts 草案。 */
export type WorkflowRevision = {
  /** Harness 内递增 revision；同一序号的 source/hash 不可改变。 */
  readonly revision: number;
  /** 草案 TypeScript 原文；尚未进入受限 Runtime。 */
  readonly source: string;
  /** source 的 SHA-256，用于后续 Execution 冻结与审计。 */
  readonly sourceHash: string;
  /** 草案创建时间。 */
  readonly createdAt: string;
  /** 用户是否明确接受此草案；接受不等于执行。 */
  readonly acceptedAt: string | null;
};

/** Pi adapter 向 HarnessService 公开的最小流事件；不暴露 Pi 原始对象。 */
export type HarnessStreamEvent =
  | { readonly type: "reasoning_delta"; readonly delta: string }
  | { readonly type: "assistant_delta"; readonly delta: string }
  | { readonly type: "turn_finished"; readonly messageId: string }
  | { readonly type: "turn_interrupted"; readonly diagnostic: string };

/** 用于创建主控会话的本机模型配置；secret 从环境读取，绝不放入此对象。 */
export type HarnessModelConfig = {
  /** OpenAI-compatible 模型名。 */
  readonly model: string;
  /** OpenAI-compatible base URL。 */
  readonly baseUrl: string;
  /** 环境变量名，不是 key 本身。 */
  readonly apiKeyEnv: string;
};
